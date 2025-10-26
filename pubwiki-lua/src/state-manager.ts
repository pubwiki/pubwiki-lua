import { NamespaceRegistry, type NamespaceConfig } from './namespace-registry'
import type { StorageBackend } from './storage-backend'
import { IndexedDBBackend } from './storage-backend'

/**
 * 状态记录接口
 */
export interface StateRecord {
  fullKey: string
  namespace: string
  scriptId: string | null
  path: string[]
  value: unknown
  timestamp: number
  expireAt: number | null
  shared: boolean
}

/**
 * 状态变化监听器
 */
type StateWatcher = {
  scriptId: string
  callback: (value: unknown) => void
}

/**
 * 设置选项
 */
export interface SetOptions {
  ttl?: number  // 覆盖配置中的 TTL
}

/**
 * 命名空间状态管理器
 * 支持可插拔的存储后端，默认使用 IndexedDB
 */
export class NamespaceStateManager {
  private registry: NamespaceRegistry
  private backend: StorageBackend
  private cache = new Map<string, unknown>()
  private tempStorage = new Map<string, unknown>()  // 非持久化临时存储
  private watchers = new Map<string, StateWatcher[]>()
  private initialized = false
  
  constructor(
    registry: NamespaceRegistry,
    backend?: StorageBackend
  ) {
    this.registry = registry
    this.backend = backend || new IndexedDBBackend()
  }
  
  /**
   * 初始化存储后端
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    await this.backend.init()
    this.initialized = true
  }
  
  /**
   * 解析 key 路径
   */
  private parsePath(key: string): { firstSegment: string; path: string[]; fullKey: string } {
    const parts = key.split('.')
    if (parts.length < 2) {
      throw new Error(`Invalid key format: ${key}`)
    }
    return {
      firstSegment: parts[0],
      path: parts,
      fullKey: key
    }
  }
  
  /**
   * 获取状态值
   */
  async get(scriptId: string, key: string, defaultValue?: unknown): Promise<unknown> {
    const { config } = this.registry.checkPermission(scriptId, key, 'read')
    
    // 临时存储
    if (!config.persistent) {
      return this.tempStorage.get(key) ?? defaultValue
    }
    
    // 先查缓存
    if (this.cache.has(key)) {
      return this.cache.get(key)
    }
    
    // 查存储后端
    await this.ensureInitialized()
    const record = await this.backend.get(key)
    
    // 检查是否过期
    if (record && record.expireAt && Date.now() > record.expireAt) {
      // 异步删除过期数据
      this.delete(scriptId, key).catch(console.error)
      return defaultValue
    }
    
    const value = record?.value ?? defaultValue
    if (value !== undefined) {
      this.cache.set(key, value)
    }
    return value
  }
  
  /**
   * 设置状态值
   */
  async set(scriptId: string, key: string, value: unknown, options: SetOptions = {}): Promise<void> {
    const { namespace, config } = this.registry.checkPermission(scriptId, key, 'write')
    
    // 合并 TTL 配置
    const ttl = options.ttl ?? config.ttl
    
    // 临时存储
    if (!config.persistent) {
      this.tempStorage.set(key, value)
      this.notifyWatchers(key, value)
      return
    }
    
    // 更新缓存
    this.cache.set(key, value)
    
    // 写入存储后端
    await this.ensureInitialized()
    
    const record: StateRecord = {
      fullKey: key,
      namespace,
      scriptId: config.shared ? null : scriptId,
      path: key.split('.'),
      value,
      timestamp: Date.now(),
      expireAt: ttl ? Date.now() + ttl : null,
      shared: config.shared
    }
    
    await this.backend.set(record)
    this.notifyWatchers(key, value)
  }
  
  /**
   * 删除状态值
   */
  async delete(scriptId: string, key: string): Promise<void> {
    const { config } = this.registry.checkPermission(scriptId, key, 'write')
    
    if (!config.persistent) {
      this.tempStorage.delete(key)
      this.notifyWatchers(key, undefined)
      return
    }
    
    this.cache.delete(key)
    await this.ensureInitialized()
    await this.backend.delete(key)
    this.notifyWatchers(key, undefined)
  }
  
  /**
   * 列出前缀匹配的所有 key
   */
  async list(scriptId: string, prefix: string): Promise<string[]> {
    // 验证至少有一个命名空间匹配
    const accessibleNamespaces = this.registry.listAccessible(scriptId)
    const matchingNamespace = accessibleNamespaces.find(ns => 
      prefix.startsWith(ns) || ns.startsWith(prefix)
    )
    
    if (!matchingNamespace) {
      throw new Error(`No permission to list keys with prefix: ${prefix}`)
    }
    
    const results: string[] = []
    
    // 从临时存储查找
    for (const key of this.tempStorage.keys()) {
      if (key.startsWith(prefix)) {
        results.push(key)
      }
    }
    
    // 从存储后端查找
    await this.ensureInitialized()
    const records = await this.backend.getAll()
    const dbResults = records
      .filter(r => r.fullKey.startsWith(prefix))
      .map(r => r.fullKey)
    
    return [...new Set([...results, ...dbResults])]
  }
  
  /**
   * 监听状态变化
   */
  watch(scriptId: string, key: string, callback: (value: unknown) => void): () => void {
    // 验证读权限
    this.registry.checkPermission(scriptId, key, 'read')
    
    if (!this.watchers.has(key)) {
      this.watchers.set(key, [])
    }
    
    const watcher: StateWatcher = { scriptId, callback }
    this.watchers.get(key)!.push(watcher)
    
    // 返回取消监听的函数
    return () => {
      const list = this.watchers.get(key)
      if (!list) return
      
      const index = list.findIndex(w => w.callback === callback)
      if (index !== -1) {
        list.splice(index, 1)
      }
      
      // 如果没有监听器了，删除这个 key
      if (list.length === 0) {
        this.watchers.delete(key)
      }
    }
  }
  
  /**
   * 通知所有监听器
   */
  private notifyWatchers(key: string, value: unknown): void {
    const watchers = this.watchers.get(key)
    if (!watchers) return
    
    for (const { callback } of watchers) {
      try {
        callback(value)
      } catch (err) {
        console.error('State watcher error:', err)
      }
    }
  }
  
  /**
   * 清理过期数据
   */
  async cleanupExpired(): Promise<number> {
    await this.ensureInitialized()
    const records = await this.backend.getAll()
    const now = Date.now()
    let count = 0
    
    for (const record of records) {
      if (record.expireAt && record.expireAt <= now) {
        await this.backend.delete(record.fullKey)
        this.cache.delete(record.fullKey)
        count++
      }
    }
    
    return count
  }
  
  /**
   * 清空所有数据
   */
  async clear(): Promise<void> {
    this.cache.clear()
    this.tempStorage.clear()
    await this.ensureInitialized()
    await this.backend.clear()
  }
  
  /**
   * 获取所有存储的记录（用于调试和查看）
   */
  async getAllRecords(): Promise<StateRecord[]> {
    await this.ensureInitialized()
    return this.backend.getAll()
  }
  
  /**
   * 关闭存储后端
   */
  close(): void {
    if (this.backend.close) {
      this.backend.close()
    }
  }
}
