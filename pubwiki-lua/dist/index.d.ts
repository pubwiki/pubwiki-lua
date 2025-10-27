/**
 * pubwiki-lua - RDF-based Lua Script Runner
 *
 * 完全基于 RDF 三元组的 Lua 执行引擎
 * 调用者需要提供 RDFStore 实现
 */
import type { RDFStore, SyncRDFStore } from './rdf-types';
export type { RDFStore, SyncRDFStore, Triple, TriplePattern } from './rdf-types';
export { createSyncAdapter } from './rdf-bridge';
/**
 * 上传文件模块（用于 file:// 协议）
 */
export declare function uploadFileModule(name: string, content: string): void;
/**
 * 清除模块缓存
 */
export declare function clearModuleCache(): void;
/**
 * 加载 Lua WASM 模块
 */
export declare function loadRunner(customGluePath?: string): Promise<void>;
/**
 * 运行 Lua 代码
 *
 * @param code Lua 源代码
 * @param rdfStore RDF 存储实现
 * @returns Lua 返回值（JSON 字符串）
 */
export declare function runLua(code: string, rdfStore: RDFStore | SyncRDFStore): Promise<string>;
/**
 * 设置 WASM glue 文件路径
 */
export declare function setGluePath(path: string): void;
/**
 * 获取当前 glue 文件路径
 */
export declare function getGluePath(): string;
/**
 * 获取默认 glue 文件路径
 */
export declare function getDefaultGluePath(): string;
/**
 * 检查 runner 是否已加载
 */
export declare function isRunnerLoaded(): boolean;
/**
 * 重置 runner 状态
 */
export declare function resetRunnerState(): void;
//# sourceMappingURL=index.d.ts.map