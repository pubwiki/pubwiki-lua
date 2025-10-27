/**
 * Lua 桥接模块
 * 提供 Rust 可调用的同步状态管理 API
 * 通过内存缓存实现同步访问，后台异步同步到 IndexedDB
 */
import type { ScriptNamespaceConfig } from './namespace-registry';
import type { SetOptions, StateRecord } from './state-manager';
type StateAPI = {
    registerNamespaces: (scriptId: string, config: ScriptNamespaceConfig) => void;
    listAccessibleNamespaces: (scriptId: string) => string[];
    resolveKey: (scriptId: string, key: string) => string;
    getState: (scriptId: string, key: string, defaultValue?: unknown) => Promise<unknown>;
    setState: (scriptId: string, key: string, value: unknown, options?: SetOptions) => Promise<void>;
    deleteState: (scriptId: string, key: string) => Promise<void>;
    listKeys: (scriptId: string, prefix: string) => Promise<string[]>;
    watchState: (scriptId: string, key: string, callback: (value: unknown) => void) => () => void;
    getAllRecords: () => Promise<StateRecord[]>;
};
/**
 * 初始化桥接，保存 API 引用
 */
export declare function createLuaBridge(api: StateAPI): void;
/**
 * Rust 调用的同步函数：注册命名空间
 */
export declare function js_state_register(scriptId: string, configJson: string): string;
/**
 * Rust 调用的同步函数：获取状态
 */
export declare function js_state_get(scriptId: string, key: string, defaultJson: string): string;
/**
 * Rust 调用的同步函数：设置状态
 */
export declare function js_state_set(scriptId: string, key: string, valueJson: string, ttl: number): string;
/**
 * Rust 调用的同步函数：删除状态
 */
export declare function js_state_delete(scriptId: string, key: string): string;
/**
 * Rust 调用的同步函数：列出键
 */
export declare function js_state_list(scriptId: string, prefix: string): string;
/**
 * 预加载状态到缓存
 * 在运行 Lua 脚本前调用，避免缓存未命中
 */
export declare function preloadStateCache(api: StateAPI, scriptId: string, keys: string[]): Promise<void>;
/**
 * 从 IndexedDB 预加载所有数据到缓存
 * 建议在 loadRunner 后立即调用
 */
export declare function preloadAllStateCache(): Promise<void>;
/**
 * 清理缓存
 */
export declare function clearStateCache(scriptId?: string): void;
/**
 * 清理桥接
 */
export declare function cleanupLuaBridge(): void;
export {};
//# sourceMappingURL=lua-bridge.d.ts.map