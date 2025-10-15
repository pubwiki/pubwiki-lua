const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8')

const moduleCache = new Map<string, string>()
const fileModules = new Map<string, string>()

const DEFAULT_GLUE_PATH = new URL('../wasm/lua_runner_glue.js', import.meta.url).href
let gluePath = DEFAULT_GLUE_PATH
let moduleInstance: LuaModule | null = null
let modulePromise: Promise<void> | null = null
let wasmExports: WebAssembly.Exports | null = null
let heapU8: Uint8Array | null = null
let heapU32: Uint32Array | null = null
let lastFetchError: string | null = null

interface LuaModule {
  HEAPU8: Uint8Array
  _malloc(size: number): number
  _free(ptr: number): void
  _lua_run(ptr: number): number
  _lua_free_last(ptr: number): void
  UTF8ToString(ptr: number): string
  stringToUTF8?(input: string, ptr: number, maxBytesToWrite: number): void
  HEAPU32?: Uint32Array
  [key: string]: unknown
}

type LuaModuleFactory = (options: Record<string, unknown>) => LuaModule | Promise<LuaModule>

type SuccessCallback = (instance: WebAssembly.Instance, module: WebAssembly.Module) => unknown

function ensureModule(): LuaModule {
  if (!moduleInstance) {
    throw new Error('Lua runner has not been loaded. Call loadRunner() first.')
  }
  return moduleInstance
}

function setHeapViews(module: LuaModule) {
  if (heapU8 !== module.HEAPU8) {
    heapU8 = module.HEAPU8
  }
  if (!heapU8) {
    throw new Error('Lua runtime did not expose HEAPU8')
  }
  if (!heapU32 || heapU32.buffer !== heapU8.buffer) {
    heapU32 = new Uint32Array(heapU8.buffer)
  }
}

function allocateImportBytes(bytes: Uint8Array, module: LuaModule) {
  const length = bytes.length
  const ptr = module._malloc(length > 0 ? length : 1)
  if (length > 0) {
    module.HEAPU8.set(bytes, ptr)
  } else {
    module.HEAPU8[ptr] = 0
  }
  return { ptr, length }
}

function readCString(ptr: number, module: LuaModule): string {
  const heap = module.HEAPU8
  let end = ptr
  while (heap[end] !== 0) end += 1
  return textDecoder.decode(heap.subarray(ptr, end))
}

function httpGetSync(url: string): string {
  const xhr = new XMLHttpRequest()
  xhr.open('GET', url, false)
  xhr.overrideMimeType('text/plain; charset=utf-8')
  try {
    xhr.send(null)
  } catch (error) {
    throw new Error(`Network error while fetching ${url}: ${error}`)
  }
  if (xhr.status >= 200 && xhr.status < 300) {
    return xhr.responseText
  }
  throw new Error(`HTTP ${xhr.status} while fetching ${url}`)
}

function parseMediaWikiSpec(spec: string): { base: string; page: string } {
  const remainder = spec.slice('mediawiki://'.length)
  const slash = remainder.indexOf('/')
  if (slash === -1) {
    throw new Error(`Invalid mediawiki module '${spec}'. Expected mediawiki://<wiki>/Module:Name`)
  }
  let wiki = remainder.slice(0, slash)
  const path = remainder.slice(slash + 1)
  const marker = 'Module:'
  const markerIndex = path.indexOf(marker)
  if (markerIndex === -1) {
    throw new Error(`Invalid mediawiki module '${spec}'. Missing '${marker}' segment`)
  }
  const page = path.slice(markerIndex)
  if (!wiki.startsWith('http://') && !wiki.startsWith('https://')) {
    wiki = `https://${wiki}`
  }
  const base = wiki.replace(/\/+$/, '')
  return { base, page }
}

interface MediaWikiRevisionPayload {
  error?: { code?: string; info?: string }
  query?: {
    pages?: Array<{
      revisions?: Array<{
        slots?: {
          main?: {
            content?: string
          }
        }
      }>
    }>
  }
}

function fetchMediaWikiModule(spec: string): string {
  const { base, page } = parseMediaWikiSpec(spec)
  const query = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    prop: 'revisions',
    titles: page,
    rvprop: 'content',
    rvslots: 'main',
    origin: '*'
  })

  const candidates = [`${base}/api.php?${query.toString()}`]
  let lastError: unknown = null

  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(httpGetSync(candidate)) as MediaWikiRevisionPayload
      if (payload.error) {
        lastError = payload.error.info || payload.error.code || 'unknown MediaWiki API error'
        continue
      }
      const content = payload.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content
      if (typeof content !== 'string') {
        lastError = 'response missing module content'
        continue
      }
      return content
    } catch (error) {
      lastError = error
    }
  }

  throw new Error(`Failed to load MediaWiki module '${spec}': ${lastError}`)
}

function fetchModuleSource(spec: string): string {
  const cached = moduleCache.get(spec)
  if (cached) {
    return cached
  }

  let source: string
  if (spec.startsWith('mediawiki://')) {
    source = fetchMediaWikiModule(spec)
  } else if (spec.startsWith('http://') || spec.startsWith('https://')) {
    source = httpGetSync(spec)
  } else if (spec.startsWith('file://')) {
    const content = fileModules.get(spec)
    if (!content) {
      throw new Error(`File module '${spec}' has not been uploaded`)
    }
    source = content
  } else {
    throw new Error(`Unsupported module scheme in '${spec}'`)
  }

  moduleCache.set(spec, source)
  return source
}

function resolveResourcePath(baseHref: string, file: string): string {
  if (!baseHref) return file
  if (!baseHref.endsWith('/')) {
    return `${baseHref}/${file}`
  }
  return `${baseHref}${file}`
}

function deriveBasePath(resource: string): string {
  try {
    const url = new URL(resource, typeof document !== 'undefined' ? document.baseURI : undefined)
    url.hash = ''
    url.search = ''
    const pathname = url.pathname.replace(/[^/]*$/, '')
    return `${url.origin}${pathname}`
  } catch {
    const sanitized = resource.split(/[?#]/)[0]
    const idx = sanitized.lastIndexOf('/')
    return idx === -1 ? '' : sanitized.slice(0, idx + 1)
  }
}

export async function loadRunner(customGluePath?: string): Promise<void> {
  if (customGluePath && customGluePath !== gluePath) {
    if (moduleInstance) {
      throw new Error('Lua runner already loaded; cannot change glue path now')
    }
    gluePath = customGluePath
  }

  if (moduleInstance) return
  if (modulePromise) return modulePromise

  modulePromise = (async () => {
    const glueHref = gluePath
    const response = await fetch(glueHref)
    if (!response.ok) {
      throw new Error(`Failed to fetch ${glueHref}: ${response.status}`)
    }
    const source = await response.text()
    const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    const basePath = deriveBasePath(glueHref)

    try {
      const factoryModule = await import(/* @vite-ignore */ blobUrl)
      const factory = (factoryModule.default ?? factoryModule) as LuaModuleFactory

      let localModule: LuaModule | null = null

      const moduleOptions: Record<string, unknown> = {
        locateFile: (path: string) => resolveResourcePath(basePath, path),
        instantiateWasm: async (imports: WebAssembly.Imports, successCallback?: SuccessCallback) => {
          const importsWithEnv = imports as WebAssembly.Imports & { env?: Record<string, WebAssembly.ImportValue> }
          const env = (importsWithEnv.env ??= {}) as Record<string, WebAssembly.ImportValue>

          env.fetch_lua_module = (urlPtr: number, lenPtr: number) => {
            if (!localModule) {
              lastFetchError = 'Lua runtime not ready'
              return 0
            }
            try {
              const url = localModule.UTF8ToString(urlPtr)
              const sourceText = fetchModuleSource(url)
              const bytes = textEncoder.encode(sourceText)
              const { ptr, length } = allocateImportBytes(bytes, localModule)
              setHeapViews(localModule)
              heapU32![lenPtr >>> 2] = length
              lastFetchError = null
              return ptr
            } catch (error) {
              lastFetchError = error instanceof Error ? error.message : String(error)
              setHeapViews(localModule)
              heapU32![lenPtr >>> 2] = 0
              return 0
            }
          }

          env.free_lua_module = (ptr: number) => {
            if (ptr && localModule) {
              localModule._free(ptr)
            }
          }

          env.get_last_fetch_error = (lenPtr: number) => {
            if (!localModule) return 0
            setHeapViews(localModule)
            if (!lastFetchError) {
              heapU32![lenPtr >>> 2] = 0
              return 0
            }
            const bytes = textEncoder.encode(lastFetchError)
            const { ptr, length } = allocateImportBytes(bytes, localModule)
            heapU32![lenPtr >>> 2] = length
            return ptr
          }

          const wasmPath = resolveResourcePath(basePath, 'lua_runner_wasm.wasm')
          const fetchWasm = () => fetch(wasmPath, { credentials: 'same-origin' })

          const instantiateFromResponse = async (responsePromise: Promise<Response>) => {
            const wasmResponse = await responsePromise
            if (!wasmResponse.ok) {
              throw new Error(`Failed to fetch ${wasmPath}: ${wasmResponse.status}`)
            }
            const bytes = await wasmResponse.arrayBuffer()
            return WebAssembly.instantiate(bytes, imports)
          }

          let result: WebAssembly.WebAssemblyInstantiatedSource
          if (WebAssembly.instantiateStreaming) {
            try {
              result = await WebAssembly.instantiateStreaming(fetchWasm(), imports)
            } catch (error) {
              console.warn('Falling back to ArrayBuffer instantiation for wasm module:', error)
              result = await instantiateFromResponse(fetchWasm())
            }
          } else {
            result = await instantiateFromResponse(fetchWasm())
          }

          wasmExports = result.instance.exports
          return successCallback ? successCallback(result.instance, result.module) : wasmExports
        }
      }

      localModule = (await factory(moduleOptions)) as LuaModule
      moduleInstance = localModule
      setHeapViews(localModule)
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  })()

  await modulePromise
}

export function setGluePath(path: string) {
  if (moduleInstance) {
    throw new Error('Cannot change glue path after the runner has been loaded')
  }
  gluePath = path
}

export function getGluePath() {
  return gluePath
}

export function getDefaultGluePath() {
  return DEFAULT_GLUE_PATH
}

export function isRunnerLoaded() {
  return moduleInstance !== null
}

export function resetRunnerState() {
  moduleInstance = null
  modulePromise = null
  wasmExports = null
  heapU8 = null
  heapU32 = null
  lastFetchError = null
  gluePath = DEFAULT_GLUE_PATH
  moduleCache.clear()
  fileModules.clear()
}

export async function runLua(code: string): Promise<string> {
  await loadRunner()
  const module = ensureModule()
  const bytes = textEncoder.encode(`${code}\0`)
  const ptr = module._malloc(bytes.length)
  module.HEAPU8.set(bytes, ptr)
  const resultPtr = module._lua_run(ptr)
  let output = ''
  if (resultPtr) {
    output = readCString(resultPtr, module)
    module._lua_free_last(resultPtr)
  }
  module._free(ptr)
  return output
}

export function registerFileModule(identifier: string, source: string) {
  const key = identifier.startsWith('file://') ? identifier : `file://${identifier}`
  fileModules.set(key, source)
  moduleCache.set(key, source)
}

export function removeFileModule(identifier: string) {
  const key = identifier.startsWith('file://') ? identifier : `file://${identifier}`
  fileModules.delete(key)
  moduleCache.delete(key)
}

export function listFileModules() {
  return Array.from(fileModules.keys()).map(key => key.replace(/^file:\/\//, ''))
}

export function clearRemoteModuleCache() {
  for (const key of Array.from(moduleCache.keys())) {
    if (!key.startsWith('file://')) {
      moduleCache.delete(key)
    }
  }
}

export function getModuleCacheSize() {
  return moduleCache.size
}

export type { LuaModule }

export { DEFAULT_GLUE_PATH }
