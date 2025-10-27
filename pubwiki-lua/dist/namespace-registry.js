/**
 * 命名空间注册表
 * 管理所有脚本的命名空间声明和权限
 *
 * 设计原则：
 * 1. 默认隔离：非共享命名空间自动添加 scriptId 前缀，避免冲突
 * 2. 显式共享：shared: true 的命名空间不添加前缀，全局可访问
 */
export class NamespaceRegistry {
    constructor() {
        // 脚本 ID -> 命名空间配置
        this.registry = new Map();
        // 系统保留的命名空间前缀
        this.reservedPrefixes = ['system', '_internal'];
    }
    /**
     * 规范化命名空间名称
     * 非共享命名空间自动添加 scriptId 前缀以实现隔离
     * @param scriptId 脚本 ID
     * @param namespace 原始命名空间名称
     * @param isShared 是否是共享命名空间
     * @returns 规范化后的命名空间名称
     */
    normalizeNamespace(scriptId, namespace, isShared) {
        // 共享命名空间不添加前缀
        if (isShared) {
            return namespace;
        }
        // 非共享命名空间添加 scriptId 前缀
        return `${scriptId}/${namespace}`;
    }
    /**
     * 反规范化命名空间名称（用于显示给用户）
     * @param scriptId 脚本 ID
     * @param normalizedNamespace 规范化后的命名空间
     * @returns 原始命名空间名称
     */
    denormalizeNamespace(scriptId, normalizedNamespace) {
        const prefix = `${scriptId}/`;
        if (normalizedNamespace.startsWith(prefix)) {
            return normalizedNamespace.substring(prefix.length);
        }
        return normalizedNamespace;
    }
    /**
     * 注册脚本的命名空间配置
     */
    registerScript(scriptId, namespaceConfig) {
        // 验证 scriptId 格式
        if (!scriptId || typeof scriptId !== 'string') {
            throw new Error('scriptId must be a non-empty string');
        }
        // scriptId 不能包含 '/' 字符（用作内部分隔符）
        if (scriptId.includes('/')) {
            throw new Error(`scriptId cannot contain '/' character: ${scriptId}`);
        }
        // 验证所有命名空间配置
        for (const [namespace, config] of Object.entries(namespaceConfig)) {
            this.validateNamespace(scriptId, namespace, config);
        }
        // 规范化并存储配置
        const normalizedConfig = {};
        for (const [namespace, config] of Object.entries(namespaceConfig)) {
            const normalizedName = this.normalizeNamespace(scriptId, namespace, config.shared);
            normalizedConfig[normalizedName] = { ...config };
        }
        this.registry.set(scriptId, normalizedConfig);
    }
    /**
     * 验证命名空间的合法性
     */
    validateNamespace(scriptId, namespace, config) {
        // 检查保留字
        const firstPart = namespace.split('.')[0];
        if (this.reservedPrefixes.includes(firstPart)) {
            throw new Error(`Namespace '${firstPart}' is reserved by system`);
        }
        // 禁止使用 '/' 字符（用作内部分隔符）
        if (namespace.includes('/')) {
            throw new Error(`Namespace cannot contain '/' character: ${namespace}`);
        }
        // 检查配置有效性
        if (typeof config.read !== 'boolean' || typeof config.write !== 'boolean') {
            throw new Error(`Invalid namespace config for ${namespace}: read and write must be boolean`);
        }
        if (typeof config.shared !== 'boolean' || typeof config.persistent !== 'boolean') {
            throw new Error(`Invalid namespace config for ${namespace}: shared and persistent must be boolean`);
        }
        // 检查 TTL
        if (config.ttl !== undefined && (typeof config.ttl !== 'number' || config.ttl <= 0)) {
            throw new Error(`Invalid TTL for namespace ${namespace}: must be a positive number`);
        }
        // 检查配额
        if (config.quota !== undefined && (typeof config.quota !== 'number' || config.quota <= 0)) {
            throw new Error(`Invalid quota for namespace ${namespace}: must be a positive number`);
        }
    }
    /**
     * 将用户提供的 key 转换为完整的存储 key
     * 自动添加 scriptId 前缀（如果需要）
     * @param scriptId 脚本 ID
     * @param key 用户提供的 key
     * @returns 完整的存储 key
     */
    resolveKey(scriptId, key) {
        const scriptConfig = this.registry.get(scriptId);
        if (!scriptConfig) {
            throw new Error(`Script ${scriptId} not registered`);
        }
        // 1. 检查是否匹配共享命名空间（本脚本或其他脚本）
        for (const [_, config] of this.registry.entries()) {
            for (const [namespace, namespaceConfig] of Object.entries(config)) {
                if (namespaceConfig.shared && (key === namespace || key.startsWith(namespace + '.'))) {
                    return key; // 共享命名空间不需要前缀
                }
            }
        }
        // 2. 默认：添加 scriptId 前缀（私有命名空间）
        return `${scriptId}/${key}`;
    }
    /**
     * 检查脚本是否有权限访问指定的 key
     * 如果 namespace 未注册，自动创建为私有、可读写、持久化的 namespace
     */
    checkPermission(scriptId, key, operation) {
        let namespace = this.findMatchingNamespace(scriptId, key);
        // 如果找不到匹配的 namespace，自动创建为私有 namespace
        if (!namespace) {
            // 提取 namespace 名称：最后一个点之前的所有部分
            // 例如：
            //   key = "script-A/user.profile.name" → keyWithoutPrefix = "user.profile.name" → namespace = "user.profile"
            //   key = "script-A/user.settings" → keyWithoutPrefix = "user.settings" → namespace = "user"
            //   key = "data.cache" → namespace = "data"
            const keyWithoutPrefix = key.startsWith(`${scriptId}/`)
                ? key.substring(`${scriptId}/`.length)
                : key;
            const lastDotIndex = keyWithoutPrefix.lastIndexOf('.');
            const namespaceFromKey = lastDotIndex > 0
                ? keyWithoutPrefix.substring(0, lastDotIndex) // 最后一个点之前的部分
                : keyWithoutPrefix; // 没有点，整个就是 namespace（例如访问 "user"）
            // 自动创建默认配置：私有、可读写、持久化
            const defaultConfig = {
                read: true,
                write: true,
                shared: false,
                persistent: true
            };
            // 注册到脚本配置中
            const scriptConfig = this.registry.get(scriptId) || {};
            const normalizedName = `${scriptId}/${namespaceFromKey}`;
            scriptConfig[normalizedName] = defaultConfig;
            this.registry.set(scriptId, scriptConfig);
            namespace = { name: normalizedName, config: defaultConfig };
        }
        const config = namespace.config;
        if (operation === 'read' && !config.read) {
            throw new Error(`No read permission for: ${key}`);
        }
        if (operation === 'write' && !config.write) {
            throw new Error(`No write permission for: ${key}`);
        }
        return { namespace: namespace.name, config };
    }
    /**
     * 找到匹配 key 的命名空间配置
     * 搜索顺序：
     * 1. 脚本自己的命名空间（已规范化，包含前缀）
     * 2. 其他脚本的共享命名空间
     */
    findMatchingNamespace(scriptId, key) {
        const scriptConfig = this.registry.get(scriptId);
        if (!scriptConfig) {
            throw new Error(`Script ${scriptId} not registered`);
        }
        // 1. 精确匹配：检查脚本声明的命名空间（已规范化）
        for (const [namespace, config] of Object.entries(scriptConfig)) {
            if (key === namespace || key.startsWith(namespace + '.')) {
                return { name: namespace, config };
            }
        }
        // 2. 共享命名空间（其他脚本声明的 shared: true）
        for (const [otherScriptId, otherConfig] of this.registry.entries()) {
            for (const [namespace, config] of Object.entries(otherConfig)) {
                if (config.shared && (key === namespace || key.startsWith(namespace + '.'))) {
                    return { name: namespace, config };
                }
            }
        }
        return null;
    }
    /**
     * 列出脚本可访问的所有命名空间
     * 注意：返回的是用户视角的命名空间名称（不含 scriptId 前缀）
     */
    listAccessible(scriptId) {
        const result = [];
        const scriptConfig = this.registry.get(scriptId);
        // 自己声明的命名空间（去掉前缀）
        if (scriptConfig) {
            for (const namespace of Object.keys(scriptConfig)) {
                result.push(this.denormalizeNamespace(scriptId, namespace));
            }
        }
        // 其他脚本的共享命名空间（共享命名空间没有前缀）
        for (const [otherScriptId, otherConfig] of this.registry.entries()) {
            if (otherScriptId === scriptId)
                continue;
            for (const [namespace, config] of Object.entries(otherConfig)) {
                if (config.shared) {
                    result.push(namespace);
                }
            }
        }
        return [...new Set(result)];
    }
    /**
     * 注销脚本
     */
    unregisterScript(scriptId) {
        this.registry.delete(scriptId);
    }
    /**
     * 获取所有注册的脚本 ID
     */
    getRegisteredScripts() {
        return Array.from(this.registry.keys());
    }
    /**
     * 获取脚本的命名空间配置
     */
    getScriptConfig(scriptId) {
        return this.registry.get(scriptId);
    }
}
//# sourceMappingURL=namespace-registry.js.map