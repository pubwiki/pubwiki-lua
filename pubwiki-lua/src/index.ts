import { NamespaceRegistry, type ScriptNamespaceConfig } from './namespace-registry'
import { NamespaceStateManager, type SetOptions } from './state-manager'
import type { StorageBackend } from './storage-backend'
import { 
  createLuaBridge, 
  cleanupLuaBridge, 
  preloadStateCache, 
  preloadAllStateCache,
  clearStateCache,
  js_state_register,
  js_state_get,
  js_state_set,
  js_state_delete,
  js_state_list
} from './lua-bridge'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8')

const moduleCache = new Map<string, string>()
const fileModules = new Map<string, string>()

// 状态管理实例
const namespaceRegistry = new NamespaceRegistry()
let stateManager: NamespaceStateManager | null = null
let customBackend: StorageBackend | undefined = undefined

/**
 * 设置自定义存储后端
 * 必须在调用 loadRunner() 之前调用
 * @param backend 自定义存储后端实现
 */
export function setStorageBackend(backend: StorageBackend) {
  if (stateManager) {
    throw new Error('Cannot set storage backend after state manager has been initialized')
  }
  customBackend = backend
}

/**
 * 初始化状态管理器
 * @param backend 可选的自定义存储后端，默认使用 IndexedDB
 */
function initStateManager(backend?: StorageBackend) {
  if (!stateManager) {
    stateManager = new NamespaceStateManager(namespaceRegistry, backend || customBackend)
  }
  return stateManager
}

// 初始化 Lua 桥接
createLuaBridge({
  registerNamespaces,
  listAccessibleNamespaces,
  resolveKey,
  getState,
  setState,
  deleteState,
  listKeys,
  watchState,
  getAllRecords: () => initStateManager().getAllRecords()
})

const DEFAULT_GLUE_PATH = new URL('../wasm/lua_runner_glue.js', import.meta.url).href
let gluePath = DEFAULT_GLUE_PATH
let moduleInstance: LuaModule | null = null
let modulePromise: Promise<void> | null = null
let wasmExports: WebAssembly.Exports | null = null
let heapU8: Uint8Array | null = null
let heapU32: Uint32Array | null = null
let lastFetchError: string | null = null

interface EmscriptenModule {
  HEAPU8: Uint8Array
  UTF8ToString(ptr: number): string
}

interface LuaModule extends EmscriptenModule {
  _lua_run(codePtr: number, scriptIdPtr: number): number
  _lua_free_result(ptr: number): void
  _malloc(size: number): number
  _free(ptr: number): void
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

// 分配 C 字符串（带 null 终止符）
function allocateCString(str: string, module: LuaModule): number {
  const bytes = textEncoder.encode(str)
  const ptr = module._malloc(bytes.length + 1)  // +1 for null terminator
  module.HEAPU8.set(bytes, ptr)
  module.HEAPU8[ptr + bytes.length] = 0  // null terminator
  return ptr
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

          // 状态管理 API - Rust 调用的同步函数
          env.js_state_register = (scriptIdPtr: number, configJsonPtr: number) => {
            if (!localModule) return 0
            try {
              const scriptId = localModule.UTF8ToString(scriptIdPtr)
              const configJson = localModule.UTF8ToString(configJsonPtr)
              const result = js_state_register(scriptId, configJson)
              return allocateCString(result, localModule)
            } catch (error) {
              const errMsg = `ERROR:${error instanceof Error ? error.message : String(error)}`
              return allocateCString(errMsg, localModule)
            }
          }

          env.js_state_get = (scriptIdPtr: number, keyPtr: number, defaultJsonPtr: number) => {
            if (!localModule) return 0
            try {
              const scriptId = localModule.UTF8ToString(scriptIdPtr)
              const key = localModule.UTF8ToString(keyPtr)
              const defaultJson = localModule.UTF8ToString(defaultJsonPtr)
              const result = js_state_get(scriptId, key, defaultJson)
              return allocateCString(result, localModule)
            } catch (error) {
              const errMsg = `ERROR:${error instanceof Error ? error.message : String(error)}`
              return allocateCString(errMsg, localModule)
            }
          }

          env.js_state_set = (scriptIdPtr: number, keyPtr: number, valueJsonPtr: number, ttl: number) => {
            if (!localModule) return 0
            try {
              const scriptId = localModule.UTF8ToString(scriptIdPtr)
              const key = localModule.UTF8ToString(keyPtr)
              const valueJson = localModule.UTF8ToString(valueJsonPtr)
              const result = js_state_set(scriptId, key, valueJson, ttl)
              return allocateCString(result, localModule)
            } catch (error) {
              const errMsg = `ERROR:${error instanceof Error ? error.message : String(error)}`
              return allocateCString(errMsg, localModule)
            }
          }

          env.js_state_delete = (scriptIdPtr: number, keyPtr: number) => {
            if (!localModule) return 0
            try {
              const scriptId = localModule.UTF8ToString(scriptIdPtr)
              const key = localModule.UTF8ToString(keyPtr)
              const result = js_state_delete(scriptId, key)
              return allocateCString(result, localModule)
            } catch (error) {
              const errMsg = `ERROR:${error instanceof Error ? error.message : String(error)}`
              return allocateCString(errMsg, localModule)
            }
          }

          env.js_state_list = (scriptIdPtr: number, prefixPtr: number) => {
            if (!localModule) return 0
            try {
              const scriptId = localModule.UTF8ToString(scriptIdPtr)
              const prefix = localModule.UTF8ToString(prefixPtr)
              const result = js_state_list(scriptId, prefix)
              return allocateCString(result, localModule)
            } catch (error) {
              const errMsg = `ERROR:${error instanceof Error ? error.message : String(error)}`
              return allocateCString(errMsg, localModule)
            }
          }

          env.js_state_free = (ptr: number) => {
            if (ptr && localModule) {
              localModule._free(ptr)
            }
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
  
  // 自动预加载所有已存储的状态到缓存
  await preloadAllStateCache().catch(err => {
    console.warn('[State] Failed to preload cache on startup:', err)
  })
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
  cleanupLuaBridge()
}

/**
 * 运行 Lua 代码
 * @param code Lua 代码字符串
 * @param scriptId 脚本ID，用于权限控制和状态隔离
 * @returns Lua 代码的输出结果
 */
export async function runLua(scriptId: string, code: string): Promise<string> {
  await loadRunner()
  const module = ensureModule()
  
  // 分配输入内存
  const codeBytes = textEncoder.encode(`${code}\0`)
  const codePtr = module._malloc(codeBytes.length)
  module.HEAPU8.set(codeBytes, codePtr)
  
  const scriptIdBytes = textEncoder.encode(`${scriptId}\0`)
  const scriptIdPtr = module._malloc(scriptIdBytes.length)
  module.HEAPU8.set(scriptIdBytes, scriptIdPtr)
  
  try {
    // 调用 lua_run，传入代码和 scriptId
    const resultPtr = module._lua_run(codePtr, scriptIdPtr)
    
    try {
      if (resultPtr) {
        const responseStr = readCString(resultPtr, module)
        
        // 解析统一的响应格式: {"result": ..., "error": null} 或 {"result": null, "error": "..."}
        try {
          const response = JSON.parse(responseStr)
          
          // 检查是否有错误
          if (response.error !== null && response.error !== undefined) {
            throw new Error(response.error)
          }
          
          // 返回结果的 JSON 字符串表示
          return JSON.stringify(response.result)
        } catch (e) {
          // 如果 JSON 解析失败，这不应该发生（因为 Rust 总是返回有效的 JSON）
          if (e instanceof SyntaxError) {
            throw new Error(`Invalid response from Lua runner: ${responseStr}`)
          }
          // 重新抛出其他错误（包括我们抛出的 Error）
          throw e
        }
      }
      return 'null'
    } finally {
      // 确保总是释放 Rust 分配的结果内存
      if (resultPtr) {
        module._lua_free_result(resultPtr)
      }
    }
  } finally {
    // 确保总是释放输入内存
    module._free(codePtr)
    module._free(scriptIdPtr)
  }
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

/**
 * 注册脚本的命名空间配置
 */
export function registerNamespaces(scriptId: string, config: ScriptNamespaceConfig): void {
  namespaceRegistry.registerScript(scriptId, config)
}

/**
 * 注销脚本
 */
export function unregisterScript(scriptId: string): void {
  namespaceRegistry.unregisterScript(scriptId)
}

/**
 * 列出脚本可访问的命名空间
 */
export function listAccessibleNamespaces(scriptId: string): string[] {
  return namespaceRegistry.listAccessible(scriptId)
}

/**
 * 解析 key 为完整的存储 key
 * 内部函数，供 lua-bridge 使用
 */
function resolveKey(scriptId: string, key: string): string {
  return namespaceRegistry.resolveKey(scriptId, key)
}

/**
 * 获取状态值
 */
export async function getState(scriptId: string, key: string, defaultValue?: unknown): Promise<unknown> {
  return initStateManager().get(scriptId, key, defaultValue)
}

/**
 * 设置状态值
 */
export async function setState(scriptId: string, key: string, value: unknown, options?: SetOptions): Promise<void> {
  return initStateManager().set(scriptId, key, value, options)
}

/**
 * 删除状态值
 */
export async function deleteState(scriptId: string, key: string): Promise<void> {
  return initStateManager().delete(scriptId, key)
}

/**
 * 列出匹配前缀的所有 key
 */
export async function listKeys(scriptId: string, prefix: string): Promise<string[]> {
  return initStateManager().list(scriptId, prefix)
}

/**
 * 监听状态变化
 */
export function watchState(scriptId: string, key: string, callback: (value: unknown) => void): () => void {
  return initStateManager().watch(scriptId, key, callback)
}

/**
 * 清理过期数据
 */
export async function cleanupExpiredState(): Promise<number> {
  return initStateManager().cleanupExpired()
}

/**
 * 清空所有状态数据
 */
export async function clearAllState(): Promise<void> {
  return initStateManager().clear()
}

/**
 * 预加载状态到同步缓存
 * 在运行 Lua 脚本前调用，避免缓存未命中
 */
export async function preloadState(scriptId: string, keys: string[]): Promise<void> {
  return preloadStateCache({
    registerNamespaces,
    listAccessibleNamespaces,
    resolveKey,
    getState,
    setState,
    deleteState,
    listKeys,
    watchState,
    getAllRecords: () => initStateManager().getAllRecords()
  }, scriptId, keys)
}

/**
 * 预加载所有状态到缓存
 * loadRunner 会自动调用此函数
 */
export async function preloadAllState(): Promise<void> {
  return preloadAllStateCache()
}

/**
 * 清理状态缓存
 */
export function clearCache(scriptId?: string): void {
  clearStateCache(scriptId)
}

/**
 * 获取所有状态记录（用于调试和查看）
 */
export async function getAllStateRecords() {
  return initStateManager().getAllRecords()
}

export type { LuaModule }
export type { ScriptNamespaceConfig } from './namespace-registry'
export type { SetOptions, StateRecord } from './state-manager'
export type { StorageBackend } from './storage-backend'
export { IndexedDBBackend, MemoryBackend, LocalStorageBackend } from './storage-backend'

export { DEFAULT_GLUE_PATH }

// 导出 IndexedDB 配置常量
export const STATE_DB_NAME = 'pubwiki_lua_state'
export const STATE_DB_VERSION = 3  // 升级到版本 3
export const STATE_STORE_NAME = 'namespace_data'
