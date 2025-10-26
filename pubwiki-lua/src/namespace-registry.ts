/**
 * 命名空间配置接口
 */
export interface NamespaceConfig {
  read: boolean
  write: boolean
  shared: boolean
  persistent: boolean
  ttl?: number  // 过期时间（毫秒）
  quota?: number  // 存储配额（字节）
}

/**
 * 脚本的命名空间配置集合
 */
export type ScriptNamespaceConfig = Record<string, NamespaceConfig>

/**
 * 权限检查结果
 */
export interface PermissionCheckResult {
  namespace: string
  config: NamespaceConfig
}

/**
 * 命名空间注册表
 * 管理所有脚本的命名空间声明和权限
 */
export class NamespaceRegistry {
  // 脚本 ID -> 命名空间配置
  private registry = new Map<string, ScriptNamespaceConfig>()
  
  // 系统保留的命名空间前缀
  private readonly reservedPrefixes = ['system', '_internal']
  
  /**
   * 注册脚本的命名空间配置
   */
  registerScript(scriptId: string, namespaceConfig: ScriptNamespaceConfig): void {
    // 验证所有命名空间配置
    for (const [namespace, config] of Object.entries(namespaceConfig)) {
      this.validateNamespace(scriptId, namespace, config)
    }
    
    // 存储配置
    this.registry.set(scriptId, { ...namespaceConfig })
    
    // 自动添加脚本私有命名空间（如果未声明）
    const privateNs = `script.${scriptId}`
    if (!namespaceConfig[privateNs]) {
      this.registry.get(scriptId)![privateNs] = {
        read: true,
        write: true,
        shared: false,
        persistent: true
      }
    }
  }
  
  /**
   * 验证命名空间的合法性
   */
  private validateNamespace(scriptId: string, namespace: string, config: NamespaceConfig): void {
    // 检查保留字
    const firstPart = namespace.split('.')[0]
    if (this.reservedPrefixes.includes(firstPart)) {
      throw new Error(`Namespace '${firstPart}' is reserved by system`)
    }
    
    // 检查命名格式
    if (!/^[a-zA-Z0-9_.]+$/.test(namespace)) {
      throw new Error(`Invalid namespace format: ${namespace}`)
    }
    
    // 不允许单段命名空间（至少要有一个点）
    if (!namespace.includes('.')) {
      throw new Error(`Namespace must have at least one dot: ${namespace}`)
    }
    
    // 检查配置有效性
    if (typeof config.read !== 'boolean' || typeof config.write !== 'boolean') {
      throw new Error(`Invalid namespace config for ${namespace}: read and write must be boolean`)
    }
    
    if (typeof config.shared !== 'boolean' || typeof config.persistent !== 'boolean') {
      throw new Error(`Invalid namespace config for ${namespace}: shared and persistent must be boolean`)
    }
    
    // 检查 TTL
    if (config.ttl !== undefined && (typeof config.ttl !== 'number' || config.ttl <= 0)) {
      throw new Error(`Invalid TTL for namespace ${namespace}: must be a positive number`)
    }
    
    // 检查配额
    if (config.quota !== undefined && (typeof config.quota !== 'number' || config.quota <= 0)) {
      throw new Error(`Invalid quota for namespace ${namespace}: must be a positive number`)
    }
  }
  
  /**
   * 检查脚本是否有权限访问指定的 key
   */
  checkPermission(scriptId: string, key: string, operation: 'read' | 'write'): PermissionCheckResult {
    const namespace = this.findMatchingNamespace(scriptId, key)
    
    if (!namespace) {
      throw new Error(`No permission to access: ${key}`)
    }
    
    const config = namespace.config
    
    if (operation === 'read' && !config.read) {
      throw new Error(`No read permission for: ${key}`)
    }
    
    if (operation === 'write' && !config.write) {
      throw new Error(`No write permission for: ${key}`)
    }
    
    return { namespace: namespace.name, config }
  }
  
  /**
   * 找到匹配 key 的命名空间配置
   */
  private findMatchingNamespace(scriptId: string, key: string): { name: string; config: NamespaceConfig } | null {
    const scriptConfig = this.registry.get(scriptId)
    if (!scriptConfig) {
      throw new Error(`Script ${scriptId} not registered`)
    }
    
    // 1. 精确匹配：检查脚本声明的命名空间
    for (const [namespace, config] of Object.entries(scriptConfig)) {
      if (key === namespace || key.startsWith(namespace + '.')) {
        return { name: namespace, config }
      }
    }
    
    // 2. 自动私有命名空间
    const privateNs = `script.${scriptId}`
    if (key === privateNs || key.startsWith(privateNs + '.')) {
      return {
        name: privateNs,
        config: { read: true, write: true, shared: false, persistent: true }
      }
    }
    
    // 3. 临时命名空间（非持久化）
    if (key === 'temp' || key.startsWith('temp.')) {
      return {
        name: 'temp',
        config: { read: true, write: true, shared: false, persistent: false }
      }
    }
    
    // 4. 共享命名空间（其他脚本声明的 shared: true）
    for (const [otherScriptId, otherConfig] of this.registry.entries()) {
      for (const [namespace, config] of Object.entries(otherConfig)) {
        if (config.shared && (key === namespace || key.startsWith(namespace + '.'))) {
          return { name: namespace, config }
        }
      }
    }
    
    return null
  }
  
  /**
   * 列出脚本可访问的所有命名空间
   */
  listAccessible(scriptId: string): string[] {
    const result: string[] = []
    const scriptConfig = this.registry.get(scriptId)
    
    // 自己声明的命名空间
    if (scriptConfig) {
      result.push(...Object.keys(scriptConfig))
    }
    
    // 自动私有命名空间
    result.push(`script.${scriptId}`)
    
    // 临时命名空间
    result.push('temp')
    
    // 其他脚本的共享命名空间
    for (const [otherScriptId, otherConfig] of this.registry.entries()) {
      if (otherScriptId === scriptId) continue
      
      for (const [namespace, config] of Object.entries(otherConfig)) {
        if (config.shared) {
          result.push(namespace)
        }
      }
    }
    
    return [...new Set(result)]
  }
  
  /**
   * 注销脚本
   */
  unregisterScript(scriptId: string): void {
    this.registry.delete(scriptId)
  }
  
  /**
   * 获取所有注册的脚本 ID
   */
  getRegisteredScripts(): string[] {
    return Array.from(this.registry.keys())
  }
  
  /**
   * 获取脚本的命名空间配置
   */
  getScriptConfig(scriptId: string): ScriptNamespaceConfig | undefined {
    return this.registry.get(scriptId)
  }
}
