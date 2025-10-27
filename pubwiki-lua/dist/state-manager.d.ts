import { NamespaceRegistry } from './namespace-registry';
import type { StorageBackend } from './storage-backend';
/**
 * 状态记录接口
 */
export interface StateRecord {
    fullKey: string;
    namespace: string;
    scriptId: string | null;
    path: string[];
    value: unknown;
    timestamp: number;
    expireAt: number | null;
    shared: boolean;
}
/**
 * 设置选项
 */
export interface SetOptions {
    ttl?: number;
}
/**
 * 命名空间状态管理器
 * 支持可插拔的存储后端，默认使用 IndexedDB
 */
export declare class NamespaceStateManager {
    private registry;
    private backend;
    private cache;
    private nonPersistentStorage;
    private watchers;
    private initialized;
    constructor(registry: NamespaceRegistry, backend?: StorageBackend);
    /**
     * 初始化存储后端
     */
    private ensureInitialized;
    /**
     * 解析 key 路径
     */
    private parsePath;
    /**
     * 获取状态值
     */
    get(scriptId: string, key: string, defaultValue?: unknown): Promise<unknown>;
    /**
     * 设置状态值
     */
    set(scriptId: string, key: string, value: unknown, options?: SetOptions): Promise<void>;
    /**
     * 删除状态值
     */
    delete(scriptId: string, key: string): Promise<void>;
    /**
     * 列出前缀匹配的所有 key
     */
    list(scriptId: string, prefix: string): Promise<string[]>;
    /**
     * 监听状态变化
     */
    watch(scriptId: string, key: string, callback: (value: unknown) => void): () => void;
    /**
     * 通知所有监听器
     */
    private notifyWatchers;
    /**
     * 清理过期数据
     */
    cleanupExpired(): Promise<number>;
    /**
     * 清空所有数据
     */
    clear(): Promise<void>;
    /**
     * 获取所有存储的记录（用于调试和查看）
     */
    getAllRecords(): Promise<StateRecord[]>;
    /**
     * 关闭存储后端
     */
    close(): void;
}
//# sourceMappingURL=state-manager.d.ts.map