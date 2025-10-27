/**
 * RDF Bridge - 连接 Lua WASM 和 RDFStore
 *
 * 职责：
 * 1. 接收 Rust 的同步 FFI 调用
 * 2. 转发给 RDFStore
 * 3. 处理同步/异步适配
 */
import { Store, DataFactory } from 'n3';
const { namedNode, literal, quad, defaultGraph } = DataFactory;
/**
 * 将我们的 Triple 转换为 N3 Quad
 */
function tripleToQuad(triple) {
    // Subject: 如果以 resource:// 开头，作为 NamedNode，否则也作为 NamedNode（主语通常是资源）
    const subject = namedNode(triple.subject);
    // Predicate: 总是 NamedNode（谓语总是属性/关系）
    const predicate = namedNode(triple.predicate);
    // Object: 只有 resource:// 开头的才是 NamedNode，其他都是 Literal
    let object;
    if (typeof triple.object === 'string' && triple.object.startsWith('resource://')) {
        object = namedNode(triple.object);
    }
    else if (typeof triple.object === 'string') {
        object = literal(triple.object);
    }
    else if (typeof triple.object === 'number') {
        object = literal(triple.object.toString());
    }
    else if (typeof triple.object === 'boolean') {
        object = literal(triple.object.toString());
    }
    else {
        // 其他类型转为 JSON 字符串
        object = literal(JSON.stringify(triple.object));
    }
    return quad(subject, predicate, object, defaultGraph());
}
/**
 * 将 N3 Quad 转换回我们的 Triple
 */
function quadToTriple(q) {
    // 解析 object
    let object;
    if (q.object.termType === 'NamedNode') {
        object = q.object.value;
    }
    else if (q.object.termType === 'Literal') {
        const value = q.object.value;
        // 尝试解析回原始类型
        if (value === 'true') {
            object = true;
        }
        else if (value === 'false') {
            object = false;
        }
        else if (/^-?\d+$/.test(value)) {
            object = parseInt(value, 10);
        }
        else if (/^-?\d+\.\d+$/.test(value)) {
            object = parseFloat(value);
        }
        else if (value.startsWith('{') || value.startsWith('[')) {
            // 尝试解析 JSON
            try {
                object = JSON.parse(value);
            }
            catch {
                object = value;
            }
        }
        else {
            object = value;
        }
    }
    else {
        object = q.object.value;
    }
    return {
        subject: q.subject.value,
        predicate: q.predicate.value,
        object
    };
}
// 当前活跃的 RDFStore（运行时注入）
let currentStore = null;
/**
 * 设置当前的 RDFStore
 * 在每次 runLua 时调用
 */
export function setRDFStore(store) {
    currentStore = store;
}
/**
 * 清除当前的 RDFStore
 * 在 runLua 完成后调用
 */
export function clearRDFStore() {
    currentStore = null;
}
/**
 * Rust 调用的同步函数：插入三元组
 */
export function js_rdf_insert(subject, predicate, objectJson) {
    if (!currentStore) {
        return "ERROR:RDFStore not initialized";
    }
    try {
        const object = JSON.parse(objectJson);
        currentStore.insert(subject, predicate, object);
        return "OK";
    }
    catch (err) {
        return `ERROR:${err instanceof Error ? err.message : String(err)}`;
    }
}
/**
 * Rust 调用的同步函数：删除三元组
 */
export function js_rdf_delete(subject, predicate, objectJson) {
    if (!currentStore) {
        return "ERROR:RDFStore not initialized";
    }
    try {
        const object = objectJson ? JSON.parse(objectJson) : undefined;
        currentStore.delete(subject, predicate, object);
        return "OK";
    }
    catch (err) {
        return `ERROR:${err instanceof Error ? err.message : String(err)}`;
    }
}
/**
 * Rust 调用的同步函数：查询三元组
 */
export function js_rdf_query(patternJson) {
    if (!currentStore) {
        return "ERROR:RDFStore not initialized";
    }
    try {
        const pattern = JSON.parse(patternJson);
        const results = currentStore.query(pattern);
        return JSON.stringify(results);
    }
    catch (err) {
        return `ERROR:${err instanceof Error ? err.message : String(err)}`;
    }
}
/**
 * Rust 调用的同步函数：批量插入三元组
 */
export function js_rdf_batch_insert(triplesJson) {
    if (!currentStore) {
        return "ERROR:RDFStore not initialized";
    }
    try {
        const triples = JSON.parse(triplesJson);
        if (currentStore.batchInsert) {
            currentStore.batchInsert(triples);
        }
        else {
            // 回退到逐个插入
            for (const triple of triples) {
                currentStore.insert(triple.subject, triple.predicate, triple.object);
            }
        }
        return "OK";
    }
    catch (err) {
        return `ERROR:${err instanceof Error ? err.message : String(err)}`;
    }
}
/**
 * 为异步 RDFStore 创建同步适配器
 * 使用 N3 Store 作为内存缓存来实现同步查询
 */
export function createSyncAdapter(store) {
    // 使用 N3.js Store 作为同步缓存
    const cache = new Store();
    return {
        insert(subject, predicate, object) {
            // 立即添加到 N3 Store
            const triple = { subject, predicate, object };
            const q = tripleToQuad(triple);
            cache.addQuad(q);
            // 后台异步持久化
            Promise.resolve(store.insert(subject, predicate, object)).catch((err) => {
                console.error('[SyncAdapter.insert] Background persist failed:', err);
            });
        },
        delete(subject, predicate, object) {
            // 从 N3 Store 删除匹配的三元组
            const subjectNode = namedNode(subject);
            const predicateNode = namedNode(predicate);
            let objectNode = null;
            if (object !== undefined && object !== null) {
                // 构造 object term 用于精确匹配
                if (typeof object === 'string' && object.startsWith('resource://')) {
                    objectNode = namedNode(object);
                }
                else if (typeof object === 'string') {
                    objectNode = literal(object);
                }
                else if (typeof object === 'number') {
                    objectNode = literal(object.toString());
                }
                else if (typeof object === 'boolean') {
                    objectNode = literal(object.toString());
                }
                else {
                    objectNode = literal(JSON.stringify(object));
                }
            }
            // 查询匹配的 quads
            const quadsToDelete = cache.getQuads(subjectNode, predicateNode, objectNode, null);
            // 删除所有匹配的 quads
            for (const q of quadsToDelete) {
                cache.removeQuad(q);
            }
            // 后台异步删除
            Promise.resolve(store.delete(subject, predicate, object)).catch((err) => {
                console.error('[SyncAdapter.delete] Background delete failed:', err);
            });
        },
        query(pattern) {
            // 构造查询参数（null 表示通配符）
            const subjectNode = pattern.subject !== null && pattern.subject !== undefined
                ? namedNode(pattern.subject)
                : null;
            const predicateNode = pattern.predicate !== null && pattern.predicate !== undefined
                ? namedNode(pattern.predicate)
                : null;
            let objectNode = null;
            if (pattern.object !== null && pattern.object !== undefined) {
                if (typeof pattern.object === 'string' && pattern.object.startsWith('resource://')) {
                    objectNode = namedNode(pattern.object);
                }
                else if (typeof pattern.object === 'string') {
                    objectNode = literal(pattern.object);
                }
                else if (typeof pattern.object === 'number') {
                    objectNode = literal(pattern.object.toString());
                }
                else if (typeof pattern.object === 'boolean') {
                    objectNode = literal(pattern.object.toString());
                }
                else {
                    objectNode = literal(JSON.stringify(pattern.object));
                }
            }
            // 使用 N3 Store 查询
            const quads = cache.getQuads(subjectNode, predicateNode, objectNode, null);
            // 转换回 Triple 格式
            return quads.map(quadToTriple);
        },
        batchInsert(triples) {
            // 批量添加到 N3 Store
            const quads = triples.map(tripleToQuad);
            cache.addQuads(quads);
            // 后台异步批量插入
            if (store.batchInsert) {
                Promise.resolve(store.batchInsert(triples)).catch((err) => {
                    console.error('[SyncAdapter.batchInsert] Background persist failed:', err);
                });
            }
            else {
                // 如果没有 batchInsert，回退到逐个插入
                for (const triple of triples) {
                    Promise.resolve(store.insert(triple.subject, triple.predicate, triple.object)).catch((err) => {
                        console.error('[SyncAdapter.batchInsert] Background persist failed:', err);
                    });
                }
            }
        }
    };
}
//# sourceMappingURL=rdf-bridge.js.map