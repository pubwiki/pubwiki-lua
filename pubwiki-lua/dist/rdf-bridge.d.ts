/**
 * RDF Bridge - 连接 Lua WASM 和 RDFStore
 *
 * 职责：
 * 1. 接收 Rust 的同步 FFI 调用
 * 2. 转发给 RDFStore
 * 3. 处理同步/异步适配
 */
import type { RDFStore, SyncRDFStore } from './rdf-types';
/**
 * 设置当前的 RDFStore
 * 在每次 runLua 时调用
 */
export declare function setRDFStore(store: SyncRDFStore): void;
/**
 * 清除当前的 RDFStore
 * 在 runLua 完成后调用
 */
export declare function clearRDFStore(): void;
/**
 * Rust 调用的同步函数：插入三元组
 */
export declare function js_rdf_insert(subject: string, predicate: string, objectJson: string): string;
/**
 * Rust 调用的同步函数：删除三元组
 */
export declare function js_rdf_delete(subject: string, predicate: string, objectJson: string): string;
/**
 * Rust 调用的同步函数：查询三元组
 */
export declare function js_rdf_query(patternJson: string): string;
/**
 * Rust 调用的同步函数：批量插入三元组
 */
export declare function js_rdf_batch_insert(triplesJson: string): string;
/**
 * 为异步 RDFStore 创建同步适配器
 * 使用 N3 Store 作为内存缓存来实现同步查询
 */
export declare function createSyncAdapter(store: RDFStore): SyncRDFStore;
//# sourceMappingURL=rdf-bridge.d.ts.map