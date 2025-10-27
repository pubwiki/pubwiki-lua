import { IndexedDBBackend } from './storage-backend';
/**
 * 命名空间状态管理器
 * 支持可插拔的存储后端，默认使用 IndexedDB
 */
export class NamespaceStateManager {
    constructor(registry, backend) {
        this.cache = new Map();
        this.nonPersistentStorage = new Map(); // 非持久化存储
        this.watchers = new Map();
        this.initialized = false;
        this.registry = registry;
        this.backend = backend || new IndexedDBBackend();
    }
    /**
     * 初始化存储后端
     */
    async ensureInitialized() {
        if (this.initialized)
            return;
        await this.backend.init();
        this.initialized = true;
    }
    /**
     * 解析 key 路径
     */
    parsePath(key) {
        const parts = key.split('.');
        if (parts.length < 2) {
            throw new Error(`Invalid key format: ${key}`);
        }
        return {
            firstSegment: parts[0],
            path: parts,
            fullKey: key
        };
    }
    /**
     * 获取状态值
     */
    async get(scriptId, key, defaultValue) {
        // 将用户的 key 转换为完整的存储 key
        const fullKey = this.registry.resolveKey(scriptId, key);
        // 检查权限
        const { config } = this.registry.checkPermission(scriptId, fullKey, 'read');
        // 非持久化存储
        if (!config.persistent) {
            return this.nonPersistentStorage.get(fullKey) ?? defaultValue;
        }
        // 先查缓存
        if (this.cache.has(fullKey)) {
            return this.cache.get(fullKey);
        }
        // 查存储后端
        await this.ensureInitialized();
        const record = await this.backend.get(fullKey);
        // 检查是否过期
        if (record && record.expireAt && Date.now() > record.expireAt) {
            // 异步删除过期数据
            this.delete(scriptId, key).catch(console.error);
            return defaultValue;
        }
        const value = record?.value ?? defaultValue;
        if (value !== undefined) {
            this.cache.set(fullKey, value);
        }
        return value;
    }
    /**
     * 设置状态值
     */
    async set(scriptId, key, value, options = {}) {
        // 将用户的 key 转换为完整的存储 key
        const fullKey = this.registry.resolveKey(scriptId, key);
        // 检查权限
        const { namespace, config } = this.registry.checkPermission(scriptId, fullKey, 'write');
        // 合并 TTL 配置
        const ttl = options.ttl ?? config.ttl;
        // 非持久化存储
        if (!config.persistent) {
            this.nonPersistentStorage.set(fullKey, value);
            this.notifyWatchers(fullKey, value);
            return;
        }
        // 更新缓存
        this.cache.set(fullKey, value);
        // 写入存储后端
        await this.ensureInitialized();
        const record = {
            fullKey,
            namespace,
            scriptId: config.shared ? null : scriptId,
            path: fullKey.split('.'),
            value,
            timestamp: Date.now(),
            expireAt: ttl ? Date.now() + ttl : null,
            shared: config.shared
        };
        await this.backend.set(record);
        this.notifyWatchers(fullKey, value);
    }
    /**
     * 删除状态值
     */
    async delete(scriptId, key) {
        // 将用户的 key 转换为完整的存储 key
        const fullKey = this.registry.resolveKey(scriptId, key);
        // 检查权限
        const { config } = this.registry.checkPermission(scriptId, fullKey, 'write');
        if (!config.persistent) {
            this.nonPersistentStorage.delete(fullKey);
            this.notifyWatchers(fullKey, undefined);
            return;
        }
        this.cache.delete(fullKey);
        await this.ensureInitialized();
        await this.backend.delete(fullKey);
        this.notifyWatchers(fullKey, undefined);
    }
    /**
     * 列出前缀匹配的所有 key
     */
    async list(scriptId, prefix) {
        // 将用户的 prefix 转换为完整的存储 prefix
        const fullPrefix = this.registry.resolveKey(scriptId, prefix);
        // 验证至少有一个命名空间匹配
        const accessibleNamespaces = this.registry.listAccessible(scriptId);
        const matchingNamespace = accessibleNamespaces.find(ns => fullPrefix.startsWith(ns) || ns.startsWith(fullPrefix));
        if (!matchingNamespace) {
            throw new Error(`No permission to list keys with prefix: ${prefix}`);
        }
        const results = [];
        // 从非持久化存储查找
        for (const key of this.nonPersistentStorage.keys()) {
            if (key.startsWith(prefix)) {
                results.push(key);
            }
        }
        // 从存储后端查找
        await this.ensureInitialized();
        const records = await this.backend.getAll();
        const dbResults = records
            .filter(r => r.fullKey.startsWith(prefix))
            .map(r => r.fullKey);
        return [...new Set([...results, ...dbResults])];
    }
    /**
     * 监听状态变化
     */
    watch(scriptId, key, callback) {
        // 验证读权限
        this.registry.checkPermission(scriptId, key, 'read');
        if (!this.watchers.has(key)) {
            this.watchers.set(key, []);
        }
        const watcher = { scriptId, callback };
        this.watchers.get(key).push(watcher);
        // 返回取消监听的函数
        return () => {
            const list = this.watchers.get(key);
            if (!list)
                return;
            const index = list.findIndex(w => w.callback === callback);
            if (index !== -1) {
                list.splice(index, 1);
            }
            // 如果没有监听器了，删除这个 key
            if (list.length === 0) {
                this.watchers.delete(key);
            }
        };
    }
    /**
     * 通知所有监听器
     */
    notifyWatchers(key, value) {
        const watchers = this.watchers.get(key);
        if (!watchers)
            return;
        for (const { callback } of watchers) {
            try {
                callback(value);
            }
            catch (err) {
                console.error('State watcher error:', err);
            }
        }
    }
    /**
     * 清理过期数据
     */
    async cleanupExpired() {
        await this.ensureInitialized();
        const records = await this.backend.getAll();
        const now = Date.now();
        let count = 0;
        for (const record of records) {
            if (record.expireAt && record.expireAt <= now) {
                await this.backend.delete(record.fullKey);
                this.cache.delete(record.fullKey);
                count++;
            }
        }
        return count;
    }
    /**
     * 清空所有数据
     */
    async clear() {
        this.cache.clear();
        this.nonPersistentStorage.clear();
        await this.ensureInitialized();
        await this.backend.clear();
    }
    /**
     * 获取所有存储的记录（用于调试和查看）
     */
    async getAllRecords() {
        await this.ensureInitialized();
        return this.backend.getAll();
    }
    /**
     * 关闭存储后端
     */
    close() {
        if (this.backend.close) {
            this.backend.close();
        }
    }
}
//# sourceMappingURL=state-manager.js.map