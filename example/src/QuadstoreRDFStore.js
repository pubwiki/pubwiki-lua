/**
 * QuadStore 适配器 - 实现 RDFStore 接口
 * 
 * 使用 quadstore 作为后端存储 RDF 三元组
 */
import { Quadstore } from 'quadstore'
import { DataFactory } from 'n3'
import { BrowserLevel } from 'browser-level'

const { namedNode, literal, quad } = DataFactory

/**
 * 将 JavaScript 值转换为 RDF Term
 */
function toRDFTerm(value) {
  if (value === null || value === undefined) {
    return literal('null')
  }
  if (typeof value === 'string') {
    return literal(value)
  }
  if (typeof value === 'number') {
    return literal(value.toString())
  }
  if (typeof value === 'boolean') {
    return literal(value.toString())
  }
  if (typeof value === 'object') {
    return literal(JSON.stringify(value))
  }
  return literal(String(value))
}

/**
 * 将 RDF Term 转换为 JavaScript 值
 */
function fromRDFTerm(term) {
  if (!term || !term.value) {
    return null
  }
  
  const val = term.value
  
  // 尝试解析为数字
  if (!isNaN(val) && val.trim() !== '') {
    const num = Number(val)
    if (Number.isFinite(num)) {
      return num
    }
  }
  
  // 尝试解析为布尔值
  if (val === 'true') return true
  if (val === 'false') return false
  if (val === 'null') return null
  
  // 尝试解析为 JSON
  if ((val.startsWith('{') && val.endsWith('}')) || 
      (val.startsWith('[') && val.endsWith(']'))) {
    try {
      return JSON.parse(val)
    } catch (e) {
      // 解析失败，返回原始字符串
    }
  }
  
  return val
}

export class QuadstoreRDFStore {
  constructor(store) {
    this.store = store
    this.defaultGraph = namedNode('urn:x-local:default')
  }

  /**
   * 创建并初始化 QuadstoreRDFStore
   */
  static async create() {
    const backend = new BrowserLevel('pubwiki-lua-rdf')
    
    const store = new Quadstore({
      backend,
      dataFactory: DataFactory
    })
    
    await store.open()
    
    return new QuadstoreRDFStore(store)
  }

  /**
   * 插入三元组
   */
  async insert(subject, predicate, object) {
    const subjectNode = namedNode(subject)
    const predicateNode = namedNode(predicate)
    const objectTerm = toRDFTerm(object)
    
    const quadToInsert = quad(
      subjectNode,
      predicateNode,
      objectTerm,
      this.defaultGraph
    )
    
    await this.store.multiPut([quadToInsert])
  }

  /**
   * 删除三元组
   */
  async delete(subject, predicate, object) {
    const query = {
      subject: namedNode(subject),
      predicate: namedNode(predicate),
      graph: this.defaultGraph
    }
    
    // 如果指定了 object，则精确匹配
    if (object !== null && object !== undefined) {
      query.object = toRDFTerm(object)
    }
    
    const { items } = await this.store.get(query)
    if (items.length > 0) {
      await this.store.multiDel(items)
    }
  }

  /**
   * 查询三元组
   */
  async query(pattern) {
    const query = {
      graph: this.defaultGraph
    }
    
    // 构建查询条件
    if (pattern.subject) {
      query.subject = namedNode(pattern.subject)
    }
    if (pattern.predicate) {
      query.predicate = namedNode(pattern.predicate)
    }
    if (pattern.object !== undefined && pattern.object !== null) {
      query.object = toRDFTerm(pattern.object)
    }
    
    const { items } = await this.store.get(query)
    const results = []
    
    for (const quadItem of items) {
      results.push({
        subject: quadItem.subject.value,
        predicate: quadItem.predicate.value,
        object: fromRDFTerm(quadItem.object)
      })
    }
    
    return results
  }

  /**
   * 批量插入三元组
   */
  async batchInsert(triples) {
    const quads = triples.map(triple => {
      return quad(
        namedNode(triple.subject),
        namedNode(triple.predicate),
        toRDFTerm(triple.object),
        this.defaultGraph
      )
    })
    
    await this.store.multiPut(quads)
  }

  /**
   * 清空所有数据
   */
  async clear() {
    const { items } = await this.store.get({
      graph: this.defaultGraph
    })
    if (items.length > 0) {
      await this.store.multiDel(items)
    }
  }

  /**
   * 关闭数据库
   */
  async close() {
    await this.store.close()
  }

  /**
   * 获取所有三元组（用于调试）
   */
  async getAll() {
    const { items } = await this.store.get({
      graph: this.defaultGraph
    })
    const results = []
    
    for (const quadItem of items) {
      results.push({
        subject: quadItem.subject.value,
        predicate: quadItem.predicate.value,
        object: fromRDFTerm(quadItem.object)
      })
    }
    
    return results
  }
}
