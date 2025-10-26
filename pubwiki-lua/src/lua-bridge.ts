/**
 * Lua 桥接模块
 * 提供 Rust 可调用的同步状态管理 API
 * 通过内存缓存实现同步访问，后台异步同步到 IndexedDB
 */

import type { ScriptNamespaceConfig } from './namespace-registry'
import type { SetOptions, StateRecord } from './state-manager'
import { STATE_DB_NAME, STATE_DB_VERSION, STATE_STORE_NAME } from './index'

// 从 index.ts 导入的函数（运行时通过参数传入）
type StateAPI = {
  registerNamespaces: (scriptId: string, config: ScriptNamespaceConfig) => void
  listAccessibleNamespaces: (scriptId: string) => string[]
  getState: (scriptId: string, key: string, defaultValue?: unknown) => Promise<unknown>
  setState: (scriptId: string, key: string, value: unknown, options?: SetOptions) => Promise<void>
  deleteState: (scriptId: string, key: string) => Promise<void>
  listKeys: (scriptId: string, prefix: string) => Promise<string[]>
  watchState: (scriptId: string, key: string, callback: (value: unknown) => void) => () => void
  getAllRecords: () => Promise<StateRecord[]>
}

// 内存缓存，用于同步访问
const syncCache = new Map<string, unknown>()

// 状态管理 API 实例（由 createLuaBridge 设置）
let stateAPI: StateAPI | null = null

/**
 * 初始化桥接，保存 API 引用
 */
export function createLuaBridge(api: StateAPI) {
  stateAPI = api
}

/**
 * Rust 调用的同步函数：注册命名空间
 */
export function js_state_register(scriptId: string, configJson: string): string {
  if (!stateAPI) return "ERROR:Bridge not initialized"
  try {
    const config = JSON.parse(configJson) as ScriptNamespaceConfig
    stateAPI.registerNamespaces(scriptId, config)
    return "OK"
  } catch (err) {
    return `ERROR:${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Rust 调用的同步函数：获取状态
 */
export function js_state_get(scriptId: string, key: string, defaultJson: string): string {
  if (!stateAPI) return "ERROR:Bridge not initialized"
  try {
    const cacheKey = `${scriptId}:${key}`
    
    // 从缓存读取
    if (syncCache.has(cacheKey)) {
      return JSON.stringify(syncCache.get(cacheKey))
    }
    
    // 缓存未命中：返回默认值
    const defaultValue = JSON.parse(defaultJson)
    
    // 后台异步加载真实值到缓存
    stateAPI.getState(scriptId, key, defaultValue).then(value => {
      syncCache.set(cacheKey, value)
    }).catch(() => {
      // 静默失败
    })
    
    return JSON.stringify(defaultValue)
  } catch (err) {
    return `ERROR:${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Rust 调用的同步函数：设置状态
 */
export function js_state_set(
  scriptId: string,
  key: string,
  valueJson: string,
  ttl: number
): string {
  if (!stateAPI) return "ERROR:Bridge not initialized"
  try {
    const value = JSON.parse(valueJson)
    const cacheKey = `${scriptId}:${key}`
    
    // 立即更新缓存
    syncCache.set(cacheKey, value)
    
    // 后台异步持久化到 IndexedDB
    // 优雅处理持久化失败（不影响 Lua 执行）
    const options: SetOptions = ttl > 0 ? { ttl } : {}
    stateAPI.setState(scriptId, key, value, options).catch(err => {
      console.debug(`[State] Background save skipped for ${key}:`, err.message || err)
    })
    
    return "OK"
  } catch (err) {
    return `ERROR:${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Rust 调用的同步函数：删除状态
 */
export function js_state_delete(scriptId: string, key: string): string {
  if (!stateAPI) return "ERROR:Bridge not initialized"
  try {
    const cacheKey = `${scriptId}:${key}`
    
    // 立即从缓存删除
    syncCache.delete(cacheKey)
    
    // 后台异步删除
    stateAPI.deleteState(scriptId, key).catch(err => {
      console.debug(`[State] Background delete skipped for ${key}:`, err.message || err)
    })
    
    return "OK"
  } catch (err) {
    return `ERROR:${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Rust 调用的同步函数：列出键
 */
export function js_state_list(scriptId: string, prefix: string): string {
  if (!stateAPI) return "ERROR:Bridge not initialized"
  try {
    // 从缓存中查找匹配的键
    const matchingKeys: string[] = []
    const prefixKey = `${scriptId}:${prefix}`
    
    for (const key of syncCache.keys()) {
      if (key.startsWith(prefixKey)) {
        matchingKeys.push(key.substring(scriptId.length + 1))
      }
    }
    
    // 后台异步获取完整列表
    stateAPI.listKeys(scriptId, prefix).then(keys => {
      // 更新缓存（可选：预加载这些键的值）
      console.log(`Background list returned ${keys.length} keys for prefix ${prefix}`)
    }).catch(err => {
      console.error(`Background list failed for ${prefix}:`, err)
    })
    
    return JSON.stringify(matchingKeys)
  } catch (err) {
    return `ERROR:${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * 预加载状态到缓存
 * 在运行 Lua 脚本前调用，避免缓存未命中
 */
export async function preloadStateCache(
  api: StateAPI,
  scriptId: string,
  keys: string[]
): Promise<void> {
  await Promise.all(
    keys.map(async key => {
      try {
        const value = await api.getState(scriptId, key)
        syncCache.set(`${scriptId}:${key}`, value)
      } catch (err) {
        console.warn(`Failed to preload ${key}:`, err)
      }
    })
  )
}

/**
 * 从 IndexedDB 预加载所有数据到缓存
 * 建议在 loadRunner 后立即调用
 */
export async function preloadAllStateCache(): Promise<void> {
  if (!stateAPI) {
    console.warn('[State] Cannot preload: Bridge not initialized')
    return
  }
  
  try {
    const records = await stateAPI.getAllRecords()
    const now = Date.now()
    let count = 0
    
    for (const record of records) {
      if (record.expireAt && record.expireAt < now) continue
      
      const cacheKey = record.scriptId 
        ? `${record.scriptId}:${record.fullKey}`
        : record.fullKey
      
      syncCache.set(cacheKey, record.value)
      count++
    }
    
    if (count > 0) {
      console.log(`[State] Preloaded ${count} records`)
    }
  } catch (err) {
    // 静默失败，不影响应用启动
  }
}

/**
 * 清理缓存
 */
export function clearStateCache(scriptId?: string) {
  if (scriptId) {
    const prefix = `${scriptId}:`
    for (const key of syncCache.keys()) {
      if (key.startsWith(prefix)) {
        syncCache.delete(key)
      }
    }
  } else {
    syncCache.clear()
  }
}

/**
 * 清理桥接
 */
export function cleanupLuaBridge() {
  stateAPI = null
  syncCache.clear()
}
