/**
 * 存储后端接口
 * 允许用户自定义状态的持久化实现
 */
/**
 * IndexedDB 存储后端（默认实现）
 */
export class IndexedDBBackend {
    constructor(dbName = 'pubwiki_lua_state', dbVersion = 3, storeName = 'namespace_data') {
        this.dbName = dbName;
        this.dbVersion = dbVersion;
        this.storeName = storeName;
        this.db = null;
        this.dbPromise = null;
    }
    async init() {
        await this.openDB();
    }
    async openDB() {
        if (this.db)
            return this.db;
        if (this.dbPromise)
            return this.dbPromise;
        this.dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (db.objectStoreNames.contains(this.storeName)) {
                    db.deleteObjectStore(this.storeName);
                }
                const store = db.createObjectStore(this.storeName, { keyPath: 'fullKey' });
                store.createIndex('namespace', 'namespace', { unique: false });
                store.createIndex('scriptId', 'scriptId', { unique: false });
                store.createIndex('timestamp', 'timestamp', { unique: false });
                store.createIndex('expireAt', 'expireAt', { unique: false });
            };
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };
            request.onerror = () => {
                this.dbPromise = null;
                reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`));
            };
            request.onblocked = () => {
                reject(new Error('Database upgrade blocked. Please close other tabs and refresh.'));
            };
        });
        return this.dbPromise;
    }
    async get(key) {
        const db = await this.openDB();
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        return new Promise((resolve, reject) => {
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(new Error(`Failed to get: ${request.error?.message}`));
        });
    }
    async set(record) {
        const db = await this.openDB();
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        return new Promise((resolve, reject) => {
            const request = store.put(record);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(new Error(`Failed to set: ${request.error?.message}`));
        });
    }
    async delete(key) {
        const db = await this.openDB();
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        return new Promise((resolve, reject) => {
            const request = store.delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(new Error(`Failed to delete: ${request.error?.message}`));
        });
    }
    async getAll() {
        const db = await this.openDB();
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(new Error(`Failed to getAll: ${request.error?.message}`));
        });
    }
    async clear() {
        const db = await this.openDB();
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        return new Promise((resolve, reject) => {
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(new Error(`Failed to clear: ${request.error?.message}`));
        });
    }
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.dbPromise = null;
        }
    }
}
/**
 * 内存存储后端（用于测试或不需要持久化的场景）
 */
export class MemoryBackend {
    constructor() {
        this.storage = new Map();
    }
    async init() {
        // 无需初始化
    }
    async get(key) {
        return this.storage.get(key);
    }
    async set(record) {
        this.storage.set(record.fullKey, record);
    }
    async delete(key) {
        this.storage.delete(key);
    }
    async getAll() {
        return Array.from(this.storage.values());
    }
    async clear() {
        this.storage.clear();
    }
}
/**
 * LocalStorage 存储后端（简单实现，适合小数据量）
 */
export class LocalStorageBackend {
    constructor(prefix = 'pubwiki_lua_state:') {
        this.prefix = prefix;
    }
    async init() {
        // 无需初始化
    }
    async get(key) {
        const json = localStorage.getItem(this.prefix + key);
        return json ? JSON.parse(json) : undefined;
    }
    async set(record) {
        localStorage.setItem(this.prefix + record.fullKey, JSON.stringify(record));
    }
    async delete(key) {
        localStorage.removeItem(this.prefix + key);
    }
    async getAll() {
        const records = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(this.prefix)) {
                const json = localStorage.getItem(key);
                if (json) {
                    records.push(JSON.parse(json));
                }
            }
        }
        return records;
    }
    async clear() {
        const keysToDelete = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(this.prefix)) {
                keysToDelete.push(key);
            }
        }
        keysToDelete.forEach(key => localStorage.removeItem(key));
    }
}
//# sourceMappingURL=storage-backend.js.map