/**
 * Lua 桥接模块
 * 提供 Rust 可调用的同步状态管理 API
 * 通过内存缓存实现同步访问，后台异步同步到 IndexedDB
 */
// 内存缓存，用于同步访问
const syncCache = new Map();
// 状态管理 API 实例（由 createLuaBridge 设置）
let stateAPI = null;
/**
 * 初始化桥接，保存 API 引用
 */
export function createLuaBridge(api) {
    stateAPI = api;
}
/**
 * Rust 调用的同步函数：注册命名空间
 */
export function js_state_register(scriptId, configJson) {
    if (!stateAPI)
        return "ERROR:Bridge not initialized";
    try {
        const config = JSON.parse(configJson);
        stateAPI.registerNamespaces(scriptId, config);
        return "OK";
    }
    catch (err) {
        return `ERROR:${err instanceof Error ? err.message : String(err)}`;
    }
}
/**
 * Rust 调用的同步函数：获取状态
 */
export function js_state_get(scriptId, key, defaultJson) {
    if (!stateAPI)
        return "ERROR:Bridge not initialized";
    try {
        // Rust 传入的是原始 key（例如 "user.profile"）
        // 需要通过 resolveKey 转换为完整 key：
        // - 私有命名空间：转换为 "scriptId/namespace"
        // - 共享命名空间：保持 "namespace"
        const fullKey = stateAPI.resolveKey(scriptId, key);
        const cacheKey = fullKey;
        // 从缓存读取
        if (syncCache.has(cacheKey)) {
            return JSON.stringify(syncCache.get(cacheKey));
        }
        // 缓存未命中：返回默认值
        const defaultValue = JSON.parse(defaultJson);
        // 后台异步加载真实值到缓存
        stateAPI.getState(scriptId, key, defaultValue).then(value => {
            syncCache.set(cacheKey, value);
        }).catch(() => {
            // 静默失败
        });
        return JSON.stringify(defaultValue);
    }
    catch (err) {
        return `ERROR:${err instanceof Error ? err.message : String(err)}`;
    }
}
/**
 * Rust 调用的同步函数：设置状态
 */
export function js_state_set(scriptId, key, valueJson, ttl) {
    if (!stateAPI)
        return "ERROR:Bridge not initialized";
    try {
        const value = JSON.parse(valueJson);
        // Rust 传入的是原始 key（例如 "user.profile"）
        // 需要通过 resolveKey 转换为完整 key
        const fullKey = stateAPI.resolveKey(scriptId, key);
        const cacheKey = fullKey;
        // 立即更新缓存
        syncCache.set(cacheKey, value);
        // 后台异步持久化到 IndexedDB
        // 优雅处理持久化失败（不影响 Lua 执行）
        const options = ttl > 0 ? { ttl } : {};
        stateAPI.setState(scriptId, key, value, options).catch(err => {
            console.debug(`[State] Background save skipped for ${key}:`, err.message || err);
        });
        return "OK";
    }
    catch (err) {
        return `ERROR:${err instanceof Error ? err.message : String(err)}`;
    }
}
/**
 * Rust 调用的同步函数：删除状态
 */
export function js_state_delete(scriptId, key) {
    if (!stateAPI)
        return "ERROR:Bridge not initialized";
    try {
        // Rust 传入的是原始 key，需要通过 resolveKey 转换
        const fullKey = stateAPI.resolveKey(scriptId, key);
        const cacheKey = fullKey;
        // 立即从缓存删除
        syncCache.delete(cacheKey);
        // 后台异步删除
        stateAPI.deleteState(scriptId, key).catch(err => {
            console.debug(`[State] Background delete skipped for ${key}:`, err.message || err);
        });
        return "OK";
    }
    catch (err) {
        return `ERROR:${err instanceof Error ? err.message : String(err)}`;
    }
}
/**
 * Rust 调用的同步函数：列出键
 */
export function js_state_list(scriptId, prefix) {
    if (!stateAPI)
        return "ERROR:Bridge not initialized";
    try {
        // Rust 传入的是原始 prefix（例如 "user"）
        // 需要通过 resolveKey 转换为完整前缀
        const fullPrefix = stateAPI.resolveKey(scriptId, prefix);
        // 从缓存中查找匹配的键
        const matchingKeys = [];
        for (const cacheKey of syncCache.keys()) {
            // 检查缓存键是否以 fullPrefix 开头
            // 例如：cacheKey="script-A/user.profile", fullPrefix="script-A/user"
            if (cacheKey.startsWith(fullPrefix)) {
                // 返回去掉前缀后的部分
                // 例如：cacheKey="script-A/user.profile" → "user.profile"
                const key = cacheKey.substring(`${scriptId}/`.length);
                matchingKeys.push(key);
            }
        }
        // 后台异步获取完整列表
        stateAPI.listKeys(scriptId, prefix).then(keys => {
            // 更新缓存（可选：预加载这些键的值）
        }).catch(err => {
            console.error(`Background list failed for ${prefix}:`, err);
        });
        return JSON.stringify(matchingKeys);
    }
    catch (err) {
        return `ERROR:${err instanceof Error ? err.message : String(err)}`;
    }
}
/**
 * 预加载状态到缓存
 * 在运行 Lua 脚本前调用，避免缓存未命中
 */
export async function preloadStateCache(api, scriptId, keys) {
    await Promise.all(keys.map(async (key) => {
        try {
            const value = await api.getState(scriptId, key);
            syncCache.set(`${scriptId}:${key}`, value);
        }
        catch (err) {
            console.warn(`Failed to preload ${key}:`, err);
        }
    }));
}
/**
 * 从 IndexedDB 预加载所有数据到缓存
 * 建议在 loadRunner 后立即调用
 */
export async function preloadAllStateCache() {
    if (!stateAPI) {
        console.warn('[State] Cannot preload: Bridge not initialized');
        return;
    }
    try {
        const records = await stateAPI.getAllRecords();
        const now = Date.now();
        let count = 0;
        for (const record of records) {
            if (record.expireAt && record.expireAt < now)
                continue;
            const cacheKey = record.scriptId
                ? `${record.scriptId}:${record.fullKey}`
                : record.fullKey;
            syncCache.set(cacheKey, record.value);
            count++;
        }
    }
    catch (err) {
        // 静默失败，不影响应用启动
    }
}
/**
 * 清理缓存
 */
export function clearStateCache(scriptId) {
    if (scriptId) {
        const prefix = `${scriptId}:`;
        for (const key of syncCache.keys()) {
            if (key.startsWith(prefix)) {
                syncCache.delete(key);
            }
        }
    }
    else {
        syncCache.clear();
    }
}
/**
 * 清理桥接
 */
export function cleanupLuaBridge() {
    stateAPI = null;
    syncCache.clear();
}
//# sourceMappingURL=lua-bridge.js.map