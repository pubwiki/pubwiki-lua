/**
 * 存储后端接口
 * 允许用户自定义状态的持久化实现
 */
import type { StateRecord } from './state-manager';
/**
 * 存储后端接口
 */
export interface StorageBackend {
    /**
     * 初始化存储
     */
    init(): Promise<void>;
    /**
     * 获取单个记录
     */
    get(key: string): Promise<StateRecord | undefined>;
    /**
     * 设置单个记录
     */
    set(record: StateRecord): Promise<void>;
    /**
     * 删除单个记录
     */
    delete(key: string): Promise<void>;
    /**
     * 获取所有记录
     */
    getAll(): Promise<StateRecord[]>;
    /**
     * 清空所有记录
     */
    clear(): Promise<void>;
    /**
     * 关闭存储（可选）
     */
    close?(): void;
}
/**
 * IndexedDB 存储后端（默认实现）
 */
export declare class IndexedDBBackend implements StorageBackend {
    private readonly dbName;
    private readonly dbVersion;
    private readonly storeName;
    private db;
    private dbPromise;
    constructor(dbName?: string, dbVersion?: number, storeName?: string);
    init(): Promise<void>;
    private openDB;
    get(key: string): Promise<StateRecord | undefined>;
    set(record: StateRecord): Promise<void>;
    delete(key: string): Promise<void>;
    getAll(): Promise<StateRecord[]>;
    clear(): Promise<void>;
    close(): void;
}
/**
 * 内存存储后端（用于测试或不需要持久化的场景）
 */
export declare class MemoryBackend implements StorageBackend {
    private storage;
    init(): Promise<void>;
    get(key: string): Promise<StateRecord | undefined>;
    set(record: StateRecord): Promise<void>;
    delete(key: string): Promise<void>;
    getAll(): Promise<StateRecord[]>;
    clear(): Promise<void>;
}
/**
 * LocalStorage 存储后端（简单实现，适合小数据量）
 */
export declare class LocalStorageBackend implements StorageBackend {
    private readonly prefix;
    constructor(prefix?: string);
    init(): Promise<void>;
    get(key: string): Promise<StateRecord | undefined>;
    set(record: StateRecord): Promise<void>;
    delete(key: string): Promise<void>;
    getAll(): Promise<StateRecord[]>;
    clear(): Promise<void>;
}
//# sourceMappingURL=storage-backend.d.ts.map