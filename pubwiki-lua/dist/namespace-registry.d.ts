/**
 * 命名空间配置接口
 */
export interface NamespaceConfig {
    read: boolean;
    write: boolean;
    shared: boolean;
    persistent: boolean;
    ttl?: number;
    quota?: number;
}
/**
 * 脚本的命名空间配置集合
 */
export type ScriptNamespaceConfig = Record<string, NamespaceConfig>;
/**
 * 权限检查结果
 */
export interface PermissionCheckResult {
    namespace: string;
    config: NamespaceConfig;
}
/**
 * 命名空间注册表
 * 管理所有脚本的命名空间声明和权限
 *
 * 设计原则：
 * 1. 默认隔离：非共享命名空间自动添加 scriptId 前缀，避免冲突
 * 2. 显式共享：shared: true 的命名空间不添加前缀，全局可访问
 */
export declare class NamespaceRegistry {
    private registry;
    private readonly reservedPrefixes;
    /**
     * 规范化命名空间名称
     * 非共享命名空间自动添加 scriptId 前缀以实现隔离
     * @param scriptId 脚本 ID
     * @param namespace 原始命名空间名称
     * @param isShared 是否是共享命名空间
     * @returns 规范化后的命名空间名称
     */
    private normalizeNamespace;
    /**
     * 反规范化命名空间名称（用于显示给用户）
     * @param scriptId 脚本 ID
     * @param normalizedNamespace 规范化后的命名空间
     * @returns 原始命名空间名称
     */
    private denormalizeNamespace;
    /**
     * 注册脚本的命名空间配置
     */
    registerScript(scriptId: string, namespaceConfig: ScriptNamespaceConfig): void;
    /**
     * 验证命名空间的合法性
     */
    private validateNamespace;
    /**
     * 将用户提供的 key 转换为完整的存储 key
     * 自动添加 scriptId 前缀（如果需要）
     * @param scriptId 脚本 ID
     * @param key 用户提供的 key
     * @returns 完整的存储 key
     */
    resolveKey(scriptId: string, key: string): string;
    /**
     * 检查脚本是否有权限访问指定的 key
     * 如果 namespace 未注册，自动创建为私有、可读写、持久化的 namespace
     */
    checkPermission(scriptId: string, key: string, operation: 'read' | 'write'): PermissionCheckResult;
    /**
     * 找到匹配 key 的命名空间配置
     * 搜索顺序：
     * 1. 脚本自己的命名空间（已规范化，包含前缀）
     * 2. 其他脚本的共享命名空间
     */
    private findMatchingNamespace;
    /**
     * 列出脚本可访问的所有命名空间
     * 注意：返回的是用户视角的命名空间名称（不含 scriptId 前缀）
     */
    listAccessible(scriptId: string): string[];
    /**
     * 注销脚本
     */
    unregisterScript(scriptId: string): void;
    /**
     * 获取所有注册的脚本 ID
     */
    getRegisteredScripts(): string[];
    /**
     * 获取脚本的命名空间配置
     */
    getScriptConfig(scriptId: string): ScriptNamespaceConfig | undefined;
}
//# sourceMappingURL=namespace-registry.d.ts.map