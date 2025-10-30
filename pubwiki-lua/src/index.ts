/**
 * pubwiki-lua - RDF-based Lua Script Runner
 * 
 * 完全基于 RDF 三元组的 Lua 执行引擎
 * 调用者需要提供 RDFStore 实现
 */

import type { RDFStore, SyncRDFStore } from './rdf-types'
import {
  setRDFStore,
  clearRDFStore,
  createSyncAdapter,
  js_rdf_insert,
  js_rdf_delete,
  js_rdf_query,
  js_rdf_batch_insert
} from './rdf-bridge'

// ============= 导出类型 =============
export type { RDFStore, SyncRDFStore, Triple, TriplePattern } from './rdf-types'
export { createSyncAdapter } from './rdf-bridge'

// ============= 环境检测 =============

const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined'
const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null

// ============= WASM 模块管理 =============

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8')

// 模块缓存和文件模块存储
const moduleCache = new Map<string, string>()
const fileModules = new Map<string, string>()

const DEFAULT_GLUE_PATH = new URL('../wasm/lua_runner_glue.js', import.meta.url).href
let gluePath = DEFAULT_GLUE_PATH
let moduleInstance: LuaModule | null = null
let modulePromise: Promise<void> | null = null
let heapU8: Uint8Array | null = null
let heapU32: Uint32Array | null = null
let lastFetchError: string | null = null

interface LuaModule {
  HEAPU8: Uint8Array
  UTF8ToString(ptr: number): string
  _lua_run(codePtr: number): number
  _lua_free_result(ptr: number): void
  _malloc(size: number): number
  _free(ptr: number): void
}

type LuaModuleFactory = (options: Record<string, unknown>) => LuaModule | Promise<LuaModule>

function ensureModule(): LuaModule {
  if (!moduleInstance) {
    throw new Error('Lua runner has not been loaded. Call loadRunner() first.')
  }
  return moduleInstance
}

function setHeapViews(module: LuaModule) {
  if (heapU8 !== module.HEAPU8) {
    heapU8 = module.HEAPU8
    heapU32 = new Uint32Array(heapU8.buffer)
  }
  if (!heapU8) {
    throw new Error('Lua runtime did not expose HEAPU8')
  }
}

// 辅助函数：分配字节到 WASM 内存
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

// ============= Module Loading (require support) =============

/**
 * 同步 HTTP GET 请求（用于 require）
 */
function httpGetSync(url: string): string {
  if (isBrowser) {
    // 浏览器环境：使用 XMLHttpRequest
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
  } else if (isNode) {
    // Node.js 环境：使用 node:https 或 node:http（同步方式）
    // 注意：Node.js 中真正的同步 HTTP 请求需要特殊处理
    // 这里提供一个简单的实现，实际项目中可能需要使用 sync-request 等库
    throw new Error('Synchronous HTTP requests are not supported in Node.js environment. Please use async require or register modules via registerFileModule().')
  } else {
    throw new Error('Unsupported environment for HTTP requests')
  }
}

/**
 * 解析 MediaWiki 模块规范
 */
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

/**
 * 从 MediaWiki API 获取模块
 */
function fetchMediaWikiModule(spec: string): string {
  const { base, page } = parseMediaWikiSpec(spec)
  const candidates = [
    `${base}/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&titles=${encodeURIComponent(page)}`,
    `${base}/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&titles=${encodeURIComponent(page)}`
  ]

  let lastError: unknown
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

/**
 * 获取模块源代码（支持多种协议）
 */
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

/**
 * 上传文件模块（用于 file:// 协议）
 */
export function uploadFileModule(name: string, content: string): void {
  const spec = name.startsWith('file://') ? name : `file://${name}`
  fileModules.set(spec, content)
  moduleCache.delete(spec)
}

/**
 * 清除模块缓存
 */
export function clearModuleCache(): void {
  moduleCache.clear()
}

// ============= Path Resolution =============
function resolveResourcePath(baseHref: string, file: string): string {
  if (!baseHref) return file
  if (!baseHref.endsWith('/')) {
    return `${baseHref}/${file}`
  }
  return `${baseHref}${file}`
}

// 辅助函数：从资源 URL 中提取基础路径
function deriveBasePath(resource: string): string {
  try {
    // 在 Node.js 中，如果是文件路径，使用 file:// 协议
    const baseURI = isBrowser && typeof document !== 'undefined' 
      ? document.baseURI 
      : isNode 
        ? import.meta.url 
        : undefined
    
    const url = new URL(resource, baseURI)
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

/**
 * 加载 Lua WASM 模块
 */
export async function loadRunner(customGluePath?: string): Promise<void> {
  console.log('[loadRunner] Starting...')
  
  if (customGluePath && customGluePath !== gluePath) {
    if (moduleInstance) {
      throw new Error('Lua runner already loaded; cannot change glue path now')
    }
    gluePath = customGluePath
  }
  
  if (moduleInstance) {
    console.log('[loadRunner] Module already loaded')
    return
  }
  
  if (modulePromise) {
    console.log('[loadRunner] Module already loading, returning existing promise')
    return modulePromise
  }

  modulePromise = (async () => {
    try {
      const glueHref = gluePath
      console.log('[loadRunner] Fetching glue file:', glueHref)
      
      let basePath: string
      let factoryModule: any
      
      if (isNode) {
        // Node.js 环境：直接导入文件（避免 data URL 导致的环境检测问题）
        const { pathToFileURL, fileURLToPath } = await import('node:url')
        const path = await import('node:path')
        
        // 处理 file:// URL 或相对路径
        const fileUrl = glueHref.startsWith('file://') 
          ? glueHref
          : pathToFileURL(path.resolve(glueHref)).href
        
        const filePath = fileURLToPath(fileUrl)
        basePath = 'file://' + path.dirname(filePath) + '/'
        console.log('[loadRunner] Base path (Node.js):', basePath)
        
        // 直接导入模块
        factoryModule = await import(/* @vite-ignore */ fileUrl)
      } else {
        // 浏览器环境：使用 fetch + blob URL
        const response = await fetch(glueHref)
        if (!response.ok) {
          throw new Error(`Failed to fetch ${glueHref}: ${response.status}`)
        }
        const source = await response.text()
        basePath = deriveBasePath(glueHref)
        console.log('[loadRunner] Base path (Browser):', basePath)
        
        // 使用 blob URL 导入
        const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
        factoryModule = await import(/* @vite-ignore */ blobUrl)
      }
      
      const factory = (factoryModule.default ?? factoryModule) as LuaModuleFactory

      let localModule: LuaModule | null = null

      // Emscripten 模块配置
      const moduleConfig: any = {
        // 资源定位函数
        locateFile: (path: string, scriptDirectory: string) => {
          console.log('[loadRunner] locateFile called:', path, 'from', scriptDirectory)
          // 始终使用 basePath + filename
          return basePath + path
        },        // instantiateWasm 回调，用于注入自定义导入函数
        instantiateWasm: async (imports: WebAssembly.Imports, successCallback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => {
          console.log('[loadRunner] instantiateWasm callback called')
          
          // 添加 RDF bridge 函数到 env
          const env = (imports.env as Record<string, any>) || {}
          console.log('[loadRunner] Registering RDF bridge functions...')
          
          // Lua require() 支持函数
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
          
          // 注入 RDF 函数
          env.js_rdf_insert = (subjectPtr: number, predicatePtr: number, objectJsonPtr: number) => {
            console.log('[js_rdf_insert] Called')
            if (!localModule) return 0
            const subject = localModule.UTF8ToString(subjectPtr)
            const predicate = localModule.UTF8ToString(predicatePtr)
            const objectJson = localModule.UTF8ToString(objectJsonPtr)
            console.log('[js_rdf_insert]', { subject, predicate, objectJson })
            const result = js_rdf_insert(subject, predicate, objectJson)
            
            // 将结果字符串复制到 WASM 内存
            const resultPtr = localModule._malloc(result.length + 1)
            if (heapU8) {
              const bytes = textEncoder.encode(result)
              heapU8.set(bytes, resultPtr)
              heapU8[resultPtr + bytes.length] = 0
            }
            return resultPtr
          }
          
          env.js_rdf_delete = (subjectPtr: number, predicatePtr: number, objectJsonPtr: number) => {
            console.log('[js_rdf_delete] Called')
            if (!localModule) return 0
            const subject = localModule.UTF8ToString(subjectPtr)
            const predicate = localModule.UTF8ToString(predicatePtr)
            const objectJson = localModule.UTF8ToString(objectJsonPtr)
            const result = js_rdf_delete(subject, predicate, objectJson)
            
            const resultPtr = localModule._malloc(result.length + 1)
            if (heapU8) {
              const bytes = textEncoder.encode(result)
              heapU8.set(bytes, resultPtr)
              heapU8[resultPtr + bytes.length] = 0
            }
            return resultPtr
          }
          
          env.js_rdf_query = (patternJsonPtr: number) => {
            if (!localModule) return 0
            const patternJson = localModule.UTF8ToString(patternJsonPtr)
            const result = js_rdf_query(patternJson)
            
            const bytes = textEncoder.encode(result)
            const resultPtr = localModule._malloc(bytes.length + 1)
            if (heapU8) {
              heapU8.set(bytes, resultPtr)
              heapU8[resultPtr + bytes.length] = 0
            }
            return resultPtr
          }
          
          env.js_rdf_batch_insert = (triplesJsonPtr: number) => {
            console.log('[js_rdf_batch_insert] Called')
            if (!localModule) return 0
            const triplesJson = localModule.UTF8ToString(triplesJsonPtr)
            const result = js_rdf_batch_insert(triplesJson)
            
            const resultPtr = localModule._malloc(result.length + 1)
            if (heapU8) {
              const bytes = textEncoder.encode(result)
              heapU8.set(bytes, resultPtr)
              heapU8[resultPtr + bytes.length] = 0
            }
            return resultPtr
          }
          
          env.js_rdf_free = (ptr: number) => {
            if (localModule && ptr !== 0) {
              localModule._free(ptr)
            }
          }
          
          imports.env = env
          console.log('[loadRunner] RDF functions registered')
          
          // 手动加载和实例化 WASM
          const wasmPath = resolveResourcePath(basePath, 'lua_runner_wasm.wasm')
          console.log('[loadRunner] Loading WASM file:', wasmPath)
          
          let result: WebAssembly.WebAssemblyInstantiatedSource
          
          if (isNode) {
            // Node.js：使用 fs 读取 WASM 文件
            const fs = await import('node:fs/promises')
            const { fileURLToPath } = await import('node:url')
            
            const wasmFilePath = wasmPath.startsWith('file://')
              ? fileURLToPath(wasmPath)
              : wasmPath
            
            console.log('[loadRunner] Reading WASM file (Node.js):', wasmFilePath)
            const wasmBuffer = await fs.readFile(wasmFilePath)
            result = await WebAssembly.instantiate(wasmBuffer, imports)
          } else {
            // 浏览器：使用 fetch
            const fetchWasm = () => fetch(wasmPath, { credentials: 'same-origin' })
            
            const instantiateFromResponse = async (responsePromise: Promise<Response>) => {
              const wasmResponse = await responsePromise
              if (!wasmResponse.ok) {
                throw new Error(`Failed to fetch ${wasmPath}: ${wasmResponse.status}`)
              }
              const bytes = await wasmResponse.arrayBuffer()
              return WebAssembly.instantiate(bytes, imports)
            }
            
            if (WebAssembly.instantiateStreaming) {
              try {
                console.log('[loadRunner] Using instantiateStreaming...')
                result = await WebAssembly.instantiateStreaming(fetchWasm(), imports)
              } catch (error) {
                console.warn('[loadRunner] Falling back to ArrayBuffer instantiation:', error)
                result = await instantiateFromResponse(fetchWasm())
              }
            } else {
              console.log('[loadRunner] Using ArrayBuffer instantiation...')
              result = await instantiateFromResponse(fetchWasm())
            }
          }
          
          console.log('[loadRunner] WASM instantiated successfully')
          const wasmExports = result.instance.exports
          
          // 调用 successCallback 完成实例化
          if (successCallback) {
            console.log('[loadRunner] Calling successCallback...')
            return successCallback(result.instance, result.module)
          }
          return wasmExports
        }
      }

      console.log('[loadRunner] Calling factory function...')
      const module = await factory(moduleConfig)
      console.log('[loadRunner] Factory returned, setting up module...')
      
      localModule = module
      moduleInstance = module
      setHeapViews(module)
      
      console.log('[loadRunner] Module loaded successfully!')
    } catch (error) {
      console.error('[loadRunner] Error:', error)
      modulePromise = null
      throw error
    }
  })()

  return modulePromise
}

/**
 * 运行 Lua 代码
 * 
 * @param code Lua 源代码
 * @param rdfStore RDF 存储实现
 * @returns Lua 返回值（JSON 字符串）
 */
export async function runLua(code: string, rdfStore: RDFStore | SyncRDFStore): Promise<string> {
  const module = ensureModule()

  // 准备 RDFStore
  const syncStore: SyncRDFStore = 'insert' in rdfStore && typeof rdfStore.insert === 'function'
    ? (rdfStore as any).query?.constructor?.name === 'AsyncFunction'
      ? createSyncAdapter(rdfStore as RDFStore)
      : rdfStore as SyncRDFStore
    : rdfStore as SyncRDFStore

  // 注入 RDFStore
  setRDFStore(syncStore)

  try {
    // 编码 Lua 代码
    const codeBytes = textEncoder.encode(code)
    const codePtr = module._malloc(codeBytes.length + 1)
    if (!heapU8) throw new Error('HEAPU8 not initialized')
    
    heapU8.set(codeBytes, codePtr)
    heapU8[codePtr + codeBytes.length] = 0

    // 调用 Lua
    const resultPtr = module._lua_run(codePtr)
    module._free(codePtr)

    if (resultPtr === 0) {
      throw new Error('Lua execution returned null pointer')
    }

    // 读取结果
    const resultStr = module.UTF8ToString(resultPtr)
    module._lua_free_result(resultPtr)

    // 解析统一格式的响应
    const response = JSON.parse(resultStr)
    if (response.error !== null && response.error !== undefined) {
      throw new Error(response.error)
    }

    // 组合输出：print() 的输出 + 返回值
    const output = response.output || ''
    const result = JSON.stringify(response.result)
    
    // 如果有 print 输出，则在返回值前面加上输出
    if (output) {
      return output + (result !== 'null' ? `\n${result}` : '')
    }
    
    return result
  } finally {
    // 清理 RDFStore
    clearRDFStore()
  }
}

/**
 * 设置 WASM glue 文件路径
 */
export function setGluePath(path: string) {
  if (moduleInstance) {
    throw new Error('Cannot change glue path after module is loaded')
  }
  gluePath = path
}

/**
 * 获取当前 glue 文件路径
 */
export function getGluePath() {
  return gluePath
}

/**
 * 获取默认 glue 文件路径
 */
export function getDefaultGluePath() {
  return DEFAULT_GLUE_PATH
}

/**
 * 检查 runner 是否已加载
 */
export function isRunnerLoaded() {
  return moduleInstance !== null
}

/**
 * 重置 runner 状态
 */
export function resetRunnerState() {
  moduleInstance = null
  modulePromise = null
  heapU8 = null
  clearRDFStore()
}
