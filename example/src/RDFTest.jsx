import React, { useEffect, useState } from 'react'
import { loadRunner, runLua } from 'pubwiki-lua'
import { QuadstoreRDFStore } from './QuadstoreRDFStore'

export default function RDFTest() {
  const [ready, setReady] = useState(false)
  const [store, setStore] = useState(null)
  const [code, setCode] = useState(`-- RDF 三元组操作示例

-- 插入用户信息
State.insert('user:alice', 'name', '爱丽丝')
State.insert('user:alice', 'age', 25)
State.insert('user:alice', 'email', 'alice@example.com')

State.insert('user:bob', 'name', 'Bob')
State.insert('user:bob', 'age', 30)

-- 查询所有用户的名字
local users = State.query({predicate = 'name'})
print("所有用户:")
for i, triple in ipairs(users) do
  print(string.format("  %s: %s", triple.subject, triple.object))
end

-- 查询 Alice 的所有信息
local alice_info = State.query({subject = 'user:alice'})
print("\\nAlice 的信息:")
for i, triple in ipairs(alice_info) do
  print(string.format("  %s = %s", triple.predicate, triple.object))
end

-- 修改年龄
State.delete('user:alice', 'age')
State.insert('user:alice', 'age', 26)
print("\\n✅ 已更新 Alice 的年龄为 26")

return "执行完成！"`)
  const [output, setOutput] = useState('')
  const [err, setErr] = useState('')
  const [triples, setTriples] = useState([])

  useEffect(() => {
    async function init() {
      try {
        console.log('[RDFTest] Starting initialization...')
        
        // 加载 Lua runner
        console.log('[RDFTest] Loading Lua runner...')
        await loadRunner()
        console.log('[RDFTest] Lua runner loaded successfully')
        
        // 创建 QuadstoreRDFStore
        console.log('[RDFTest] Creating QuadstoreRDFStore...')
        const rdfStore = await QuadstoreRDFStore.create()
        console.log('[RDFTest] QuadstoreRDFStore created successfully')
        
        setStore(rdfStore)
        setReady(true)
        console.log('[RDFTest] Initialization complete!')
      } catch (e) {
        console.error('[RDFTest] Initialization failed:', e)
        setErr(`初始化失败: ${e.message}`)
      }
    }
    init()
  }, [])

  const onRun = async () => {
    if (!store) {
      setErr('RDF Store 未初始化')
      return
    }
    
    setErr('')
    setOutput('运行中...')
    
    try {
      const result = await runLua(code, store)
      setOutput(result)
      
      // 刷新三元组列表
      await refreshTriples()
    } catch (e) {
      setErr(String(e))
      setOutput('')
      console.error(e)
    }
  }

  const refreshTriples = async () => {
    if (!store) return
    
    try {
      const allTriples = await store.getAll()
      setTriples(allTriples)
    } catch (e) {
      console.error('刷新三元组失败:', e)
    }
  }

  const clearStore = async () => {
    if (!store) return
    
    if (!confirm('确定要清空所有 RDF 数据吗？')) return
    
    try {
      await store.clear()
      setTriples([])
      setOutput('')
      alert('✅ 数据已清空')
    } catch (e) {
      setErr(`清空失败: ${e.message}`)
    }
  }

  // 验证测试结果的辅助函数
  const validateOutput = (output, checks) => {
    let validation = '\n\n━━━━━━ 测试验证 ━━━━━━\n'
    let allPassed = true
    
    checks.forEach(check => {
      const passed = check.test(output)
      validation += `${passed ? '✅' : '❌'} ${check.message}\n`
      if (!passed) allPassed = false
    })
    
    validation += `\n${allPassed ? '🎉 所有检查通过！' : '⚠️ 部分检查失败'}`
    return { validation, allPassed }
  }

  const testBasicOperations = async () => {
    if (!store) return
    
    setErr('')
    setOutput('测试基础 RDF 操作...')
    
    const testCode = `-- 测试基础操作

-- 1. 插入数据
State.insert('test:item1', 'label', 'First Item')
State.insert('test:item1', 'value', 100)
State.insert('test:item2', 'label', 'Second Item')
State.insert('test:item2', 'value', 200)

print("✅ 插入了 4 个三元组")

-- 2. 查询所有 label
local labels = State.query({predicate = 'label'})
print(string.format("\\n找到 %d 个 label:", #labels))
for i, t in ipairs(labels) do
  print(string.format("  - %s", t.object))
end

-- 3. 查询特定主体
local item1 = State.query({subject = 'test:item1'})
print(string.format("\\ntest:item1 有 %d 个属性", #item1))

-- 4. 删除操作
State.delete('test:item1', 'value')
print("\\n✅ 已删除 test:item1 的 value 属性")

-- 5. 验证删除
local item1_after = State.query({subject = 'test:item1'})
print(string.format("删除后 test:item1 还有 %d 个属性", #item1_after))

return "测试完成！"`
    
    try {
      const result = await runLua(testCode, store)
      
      // 添加调试信息
      console.log('[testBasicOperations] Lua result:', result)
      console.log('[testBasicOperations] Result length:', result.length)
      console.log('[testBasicOperations] Result type:', typeof result)
      
      // 验证结果
      const checks = [
        { test: (o) => /插入了 4 个三元组/.test(o), message: '成功插入 4 个三元组' },
        { test: (o) => /找到 2 个 label/.test(o), message: '查询到 2 个 label' },
        { test: (o) => /test:item1 有 2 个属性/.test(o), message: 'test:item1 初始有 2 个属性' },
        { test: (o) => /删除后 test:item1 还有 1 个属性/.test(o), message: '删除后还有 1 个属性' }
      ]
      
      const { validation, allPassed } = validateOutput(result, checks)
      setOutput(result + validation)
      if (!allPassed) setErr('⚠️ 部分测试未通过')
      
      await refreshTriples()
    } catch (e) {
      setErr(String(e))
      console.error(e)
    }
  }

  const testBatchInsert = async () => {
    if (!store) return
    
    setErr('')
    setOutput('测试批量插入...')
    
    const testCode = `-- 测试批量插入

local products = {
  {subject = 'product:p1', predicate = 'name', object = '笔记本电脑'},
  {subject = 'product:p1', predicate = 'price', object = 5999},
  {subject = 'product:p1', predicate = 'stock', object = 10},
  {subject = 'product:p2', predicate = 'name', object = '无线鼠标'},
  {subject = 'product:p2', predicate = 'price', object = 99},
  {subject = 'product:p2', predicate = 'stock', object = 50},
  {subject = 'product:p3', predicate = 'name', object = '机械键盘'},
  {subject = 'product:p3', predicate = 'price', object = 399},
  {subject = 'product:p3', predicate = 'stock', object = 30},
}

State.batchInsert(products)
print(string.format("✅ 批量插入了 %d 个三元组", #products))

-- 查询所有产品
local all_products = State.query({predicate = 'name'})
print(string.format("\\n数据库中有 %d 个产品:", #all_products))
for i, t in ipairs(all_products) do
  print(string.format("  %d. %s", i, t.object))
end

return string.format("批量插入成功，共 %d 个产品", #all_products)`
    
    try {
      const result = await runLua(testCode, store)
      
      // 验证结果
      const checks = [
        { test: (o) => /批量插入了 9 个三元组/.test(o), message: '成功批量插入 9 个三元组' },
        { test: (o) => /数据库中有 3 个产品/.test(o), message: '查询到 3 个产品' },
        { test: (o) => /笔记本电脑/.test(o), message: '包含笔记本电脑' },
        { test: (o) => /无线鼠标/.test(o), message: '包含无线鼠标' },
        { test: (o) => /机械键盘/.test(o), message: '包含机械键盘' }
      ]
      
      const { validation, allPassed } = validateOutput(result, checks)
      setOutput(result + validation)
      if (!allPassed) setErr('⚠️ 部分测试未通过')
      
      await refreshTriples()
    } catch (e) {
      setErr(String(e))
      console.error(e)
    }
  }

  const testComplexQuery = async () => {
    if (!store) return
    
    setErr('')
    setOutput('测试复杂查询...')
    
    const testCode = `-- 测试复杂查询场景

-- 1. 插入图书数据
local books = {
  {subject = 'book:1984', predicate = 'title', object = '1984'},
  {subject = 'book:1984', predicate = 'author', object = 'George Orwell'},
  {subject = 'book:1984', predicate = 'year', object = 1949},
  {subject = 'book:1984', predicate = 'genre', object = 'dystopian'},
  
  {subject = 'book:brave-new-world', predicate = 'title', object = 'Brave New World'},
  {subject = 'book:brave-new-world', predicate = 'author', object = 'Aldous Huxley'},
  {subject = 'book:brave-new-world', predicate = 'year', object = 1932},
  {subject = 'book:brave-new-world', predicate = 'genre', object = 'dystopian'},
}

State.batchInsert(books)
print("✅ 插入了图书数据")

-- 2. 查询所有书名
print("\\n所有书名:")
local titles = State.query({predicate = 'title'})
for i, t in ipairs(titles) do
  print(string.format("  - %s", t.object))
end

-- 3. 查询特定类型的书
print("\\n反乌托邦类型的书:")
local dystopian = State.query({predicate = 'genre', object = 'dystopian'})
print(string.format("找到 %d 本 dystopian 类型的书", #dystopian))
for i, t in ipairs(dystopian) do
  -- 查询这本书的标题
  local book_titles = State.query({subject = t.subject, predicate = 'title'})
  if #book_titles > 0 then
    print(string.format("  - %s", book_titles[1].object))
  end
end

-- 4. 查询某本书的完整信息
print("\\n《1984》的完整信息:")
local book_1984 = State.query({subject = 'book:1984'})
print(string.format("《1984》有 %d 个属性:", #book_1984))
for i, t in ipairs(book_1984) do
  print(string.format("  %s: %s", t.predicate, t.object))
end

return string.format("查询完成，总共 %d 本书", #titles)`
    
    try {
      const result = await runLua(testCode, store)
      
      // 验证结果
      const checks = [
        { test: (o) => /插入了图书数据/.test(o), message: '成功插入图书数据' },
        { test: (o) => /1984/.test(o), message: '包含《1984》' },
        { test: (o) => /Brave New World/.test(o), message: '包含《Brave New World》' },
        { test: (o) => /找到 2 本 dystopian 类型的书/.test(o), message: '正确查询到 2 本 dystopian 书籍' },
        { test: (o) => /《1984》有 4 个属性/.test(o), message: '《1984》有 4 个属性' },
        { test: (o) => /George Orwell/.test(o), message: '包含作者信息' }
      ]
      
      const { validation, allPassed } = validateOutput(result, checks)
      setOutput(result + validation)
      if (!allPassed) setErr('⚠️ 部分测试未通过')
      
      await refreshTriples()
    } catch (e) {
      setErr(String(e))
      console.error(e)
    }
  }

  useEffect(() => {
    if (ready && store) {
      refreshTriples()
    }
  }, [ready, store])

  return (
    <div style={{ maxWidth: 1200, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui, Arial, sans-serif' }}>
      <h1>🎯 RDF 三元组存储测试</h1>
      <p>使用 <strong>Quadstore</strong> 作为 RDF 后端，测试新的 RDF API</p>

      {!ready && <div style={{ padding: '1rem', background: '#fff3cd', borderRadius: 8 }}>⏳ 正在初始化...</div>}
      
      {err && <div style={{ padding: '1rem', background: '#f8d7da', color: '#721c24', borderRadius: 8, marginBottom: '1rem' }}>{err}</div>}

      {ready && (
        <>
          {/* 快速测试按钮 */}
          <div style={{ margin: '1.5rem 0', padding: '1rem', background: '#e7f3ff', borderRadius: 8, border: '1px solid #0066cc' }}>
            <h3 style={{ marginTop: 0 }}>🧪 快速测试</h3>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button onClick={testBasicOperations} style={{ padding: '0.5rem 1rem', background: '#28a745', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                基础操作
              </button>
              <button onClick={testBatchInsert} style={{ padding: '0.5rem 1rem', background: '#17a2b8', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                批量插入
              </button>
              <button onClick={testComplexQuery} style={{ padding: '0.5rem 1rem', background: '#6f42c1', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                复杂查询
              </button>
              <button onClick={refreshTriples} style={{ padding: '0.5rem 1rem', background: '#ffc107', color: '#000', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                刷新数据
              </button>
              <button onClick={clearStore} style={{ padding: '0.5rem 1rem', background: '#dc3545', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                清空数据
              </button>
            </div>
          </div>

          {/* 代码编辑器 */}
          <div style={{ marginBottom: '1rem' }}>
            <h3>Lua 代码</h3>
            <textarea
              value={code}
              onChange={e => setCode(e.target.value)}
              rows={20}
              style={{ 
                width: '100%', 
                fontFamily: 'Consolas, Monaco, "Courier New", monospace', 
                fontSize: 14,
                padding: '0.75rem',
                borderRadius: 4,
                border: '1px solid #ccc'
              }}
            />
            <button 
              onClick={onRun} 
              disabled={!ready}
              style={{ 
                marginTop: '0.5rem',
                padding: '0.75rem 1.5rem', 
                background: '#0066cc', 
                color: 'white', 
                border: 'none', 
                borderRadius: 4, 
                cursor: 'pointer',
                fontSize: 16,
                fontWeight: 'bold'
              }}
            >
              {ready ? '▶️ 运行代码' : '⏳ 加载中...'}
            </button>
          </div>

          {/* 输出区域 */}
          {output && (
            <div style={{ marginBottom: '1.5rem' }}>
              <h3>输出</h3>
              <pre style={{ 
                background: '#f7f7f7', 
                padding: '1rem', 
                borderRadius: 4,
                border: '1px solid #ddd',
                minHeight: '100px', 
                whiteSpace: 'pre-wrap',
                fontSize: 14
              }}>{output}</pre>
            </div>
          )}

          {/* RDF 三元组查看器 */}
          <div>
            <h3>📊 RDF 三元组数据 ({triples.length} 条)</h3>
            {triples.length === 0 ? (
              <p style={{ color: '#666', fontStyle: 'italic' }}>暂无数据，运行上面的测试或自定义代码来插入数据</p>
            ) : (
              <div style={{ background: '#f8f9fa', padding: '1rem', borderRadius: 8, border: '1px solid #dee2e6' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#e9ecef', borderBottom: '2px solid #dee2e6' }}>
                      <th style={{ padding: '0.75rem', textAlign: 'left', fontWeight: 600 }}>Subject</th>
                      <th style={{ padding: '0.75rem', textAlign: 'left', fontWeight: 600 }}>Predicate</th>
                      <th style={{ padding: '0.75rem', textAlign: 'left', fontWeight: 600 }}>Object</th>
                    </tr>
                  </thead>
                  <tbody>
                    {triples.map((triple, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid #e9ecef' }}>
                        <td style={{ padding: '0.75rem', fontFamily: 'monospace', fontSize: 13, color: '#0066cc' }}>
                          {triple.subject}
                        </td>
                        <td style={{ padding: '0.75rem', fontFamily: 'monospace', fontSize: 13, color: '#28a745' }}>
                          {triple.predicate}
                        </td>
                        <td style={{ padding: '0.75rem', fontFamily: 'monospace', fontSize: 13 }}>
                          {typeof triple.object === 'object' ? JSON.stringify(triple.object) : String(triple.object)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* API 说明 */}
          <div style={{ marginTop: '2rem', padding: '1rem', background: '#f0f7ff', borderRadius: 8, border: '1px solid #b3d9ff' }}>
            <h3 style={{ marginTop: 0 }}>📖 RDF API 说明</h3>
            <div style={{ fontSize: 14, lineHeight: 1.8 }}>
              <p><strong>State.insert(subject, predicate, object)</strong> - 插入三元组</p>
              <p><strong>State.delete(subject, predicate, object?)</strong> - 删除三元组（object 可选）</p>
              <p><strong>State.query(pattern)</strong> - 查询三元组，pattern 是 Lua table:</p>
              <pre style={{ background: 'white', padding: '0.5rem', borderRadius: 4, marginLeft: '1rem' }}>
{`-- 查询示例
State.query({subject = 'user:alice'})           -- 查询 Alice 的所有属性
State.query({predicate = 'name'})              -- 查询所有名字
State.query({subject = 'user:alice', predicate = 'age'})  -- 精确查询`}
              </pre>
              <p><strong>State.batchInsert(triples)</strong> - 批量插入三元组数组</p>
              <pre style={{ background: 'white', padding: '0.5rem', borderRadius: 4, marginLeft: '1rem' }}>
{`-- 批量插入示例
local data = {
  {subject = 's1', predicate = 'p1', object = 'v1'},
  {subject = 's2', predicate = 'p2', object = 'v2'}
}
State.batchInsert(data)`}
              </pre>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
