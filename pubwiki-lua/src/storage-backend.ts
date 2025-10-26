/**
 * 存储后端接口
 * 允许用户自定义状态的持久化实现
 */

import type { StateRecord } from './state-manager'

/**
 * 存储后端接口
 */
export interface StorageBackend {
  /**
   * 初始化存储
   */
  init(): Promise<void>
  
  /**
   * 获取单个记录
   */
  get(key: string): Promise<StateRecord | undefined>
  
  /**
   * 设置单个记录
   */
  set(record: StateRecord): Promise<void>
  
  /**
   * 删除单个记录
   */
  delete(key: string): Promise<void>
  
  /**
   * 获取所有记录
   */
  getAll(): Promise<StateRecord[]>
  
  /**
   * 清空所有记录
   */
  clear(): Promise<void>
  
  /**
   * 关闭存储（可选）
   */
  close?(): void
}

/**
 * IndexedDB 存储后端（默认实现）
 */
export class IndexedDBBackend implements StorageBackend {
  private db: IDBDatabase | null = null
  private dbPromise: Promise<IDBDatabase> | null = null
  
  constructor(
    private readonly dbName: string = 'pubwiki_lua_state',
    private readonly dbVersion: number = 3,
    private readonly storeName: string = 'namespace_data'
  ) {}
  
  async init(): Promise<void> {
    await this.openDB()
  }
  
  private async openDB(): Promise<IDBDatabase> {
    if (this.db) return this.db
    if (this.dbPromise) return this.dbPromise
    
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion)
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        
        if (db.objectStoreNames.contains(this.storeName)) {
          db.deleteObjectStore(this.storeName)
        }
        
        const store = db.createObjectStore(this.storeName, { keyPath: 'fullKey' })
        store.createIndex('namespace', 'namespace', { unique: false })
        store.createIndex('scriptId', 'scriptId', { unique: false })
        store.createIndex('timestamp', 'timestamp', { unique: false })
        store.createIndex('expireAt', 'expireAt', { unique: false })
      }
      
      request.onsuccess = () => {
        this.db = request.result
        resolve(this.db)
      }
      
      request.onerror = () => {
        this.dbPromise = null
        reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`))
      }
      
      request.onblocked = () => {
        reject(new Error('Database upgrade blocked. Please close other tabs and refresh.'))
      }
    })
    
    return this.dbPromise
  }
  
  async get(key: string): Promise<StateRecord | undefined> {
    const db = await this.openDB()
    const tx = db.transaction(this.storeName, 'readonly')
    const store = tx.objectStore(this.storeName)
    
    return new Promise((resolve, reject) => {
      const request = store.get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new Error(`Failed to get: ${request.error?.message}`))
    })
  }
  
  async set(record: StateRecord): Promise<void> {
    const db = await this.openDB()
    const tx = db.transaction(this.storeName, 'readwrite')
    const store = tx.objectStore(this.storeName)
    
    return new Promise((resolve, reject) => {
      const request = store.put(record)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(new Error(`Failed to set: ${request.error?.message}`))
    })
  }
  
  async delete(key: string): Promise<void> {
    const db = await this.openDB()
    const tx = db.transaction(this.storeName, 'readwrite')
    const store = tx.objectStore(this.storeName)
    
    return new Promise((resolve, reject) => {
      const request = store.delete(key)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(new Error(`Failed to delete: ${request.error?.message}`))
    })
  }
  
  async getAll(): Promise<StateRecord[]> {
    const db = await this.openDB()
    const tx = db.transaction(this.storeName, 'readonly')
    const store = tx.objectStore(this.storeName)
    
    return new Promise((resolve, reject) => {
      const request = store.getAll()
      request.onsuccess = () => resolve(request.result as StateRecord[])
      request.onerror = () => reject(new Error(`Failed to getAll: ${request.error?.message}`))
    })
  }
  
  async clear(): Promise<void> {
    const db = await this.openDB()
    const tx = db.transaction(this.storeName, 'readwrite')
    const store = tx.objectStore(this.storeName)
    
    return new Promise((resolve, reject) => {
      const request = store.clear()
      request.onsuccess = () => resolve()
      request.onerror = () => reject(new Error(`Failed to clear: ${request.error?.message}`))
    })
  }
  
  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
      this.dbPromise = null
    }
  }
}

/**
 * 内存存储后端（用于测试或不需要持久化的场景）
 */
export class MemoryBackend implements StorageBackend {
  private storage = new Map<string, StateRecord>()
  
  async init(): Promise<void> {
    // 无需初始化
  }
  
  async get(key: string): Promise<StateRecord | undefined> {
    return this.storage.get(key)
  }
  
  async set(record: StateRecord): Promise<void> {
    this.storage.set(record.fullKey, record)
  }
  
  async delete(key: string): Promise<void> {
    this.storage.delete(key)
  }
  
  async getAll(): Promise<StateRecord[]> {
    return Array.from(this.storage.values())
  }
  
  async clear(): Promise<void> {
    this.storage.clear()
  }
}

/**
 * LocalStorage 存储后端（简单实现，适合小数据量）
 */
export class LocalStorageBackend implements StorageBackend {
  private readonly prefix: string
  
  constructor(prefix: string = 'pubwiki_lua_state:') {
    this.prefix = prefix
  }
  
  async init(): Promise<void> {
    // 无需初始化
  }
  
  async get(key: string): Promise<StateRecord | undefined> {
    const json = localStorage.getItem(this.prefix + key)
    return json ? JSON.parse(json) : undefined
  }
  
  async set(record: StateRecord): Promise<void> {
    localStorage.setItem(this.prefix + record.fullKey, JSON.stringify(record))
  }
  
  async delete(key: string): Promise<void> {
    localStorage.removeItem(this.prefix + key)
  }
  
  async getAll(): Promise<StateRecord[]> {
    const records: StateRecord[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(this.prefix)) {
        const json = localStorage.getItem(key)
        if (json) {
          records.push(JSON.parse(json))
        }
      }
    }
    return records
  }
  
  async clear(): Promise<void> {
    const keysToDelete: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(this.prefix)) {
        keysToDelete.push(key)
      }
    }
    keysToDelete.forEach(key => localStorage.removeItem(key))
  }
}
