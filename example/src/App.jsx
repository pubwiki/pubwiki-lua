import React, { useEffect, useState } from 'react'
import { 
  loadRunner, 
  runLua, 
  registerFileModule, 
  removeFileModule, 
  listFileModules,
  registerNamespaces,
  clearCache,
  getAllStateRecords
} from 'pubwiki-lua'
import NamespaceTest from './NamespaceTest'

export default function App() {
  const [ready, setReady] = useState(false)
  const [code, setCode] = useState(`print('Hello from Lua!')\nreturn 1+2`)
  const [output, setOutput] = useState('')
  const [err, setErr] = useState('')
  const [files, setFiles] = useState([])
  const [stateData, setStateData] = useState([])
  const [activeTab, setActiveTab] = useState('lua') // 'lua', 'state', or 'namespace-test'

  useEffect(() => {
    loadRunner()
      .then(() => {
        setReady(true)
        setFiles(listFileModules())
      })
      .catch(e => setErr(String(e)))
  }, [])

  const onUploadFiles = async (event) => {
    const selected = Array.from(event.target.files || [])
    if (!selected.length) return

    const newNames = []
    for (const file of selected) {
      const text = await file.text()
      registerFileModule(`file://${file.name}`, text)
      newNames.push(file.name)
    }
    setFiles(prev => Array.from(new Set([...prev, ...newNames])))
    event.target.value = ''
  }

  const onRemoveFile = (name) => {
    removeFileModule(`file://${name}`)
    setFiles(prev => prev.filter(n => n !== name))
  }

  const onRun = async () => {
    setErr('')
    setOutput('Running...')
    try {
      const res = await runLua(code, 'default-script')
      setOutput(res)
    } catch (e) {
      setErr(String(e))
      setOutput('')
    }
  }

  // 状态管理测试函数
  const testBasicState = async () => {
    setErr('')
    setOutput('测试基础状态管理...')
    try {
      registerNamespaces('test_basic_v1', {
        'game.player': {
          read: true,
          write: true,
          shared: false,
          persistent: true
        }
      })

      const res = await runLua(`
-- State 表已由 Rust 注入，直接使用
local level = State.get("game.player.level", 1)
print("当前等级:", level)

State.set("game.player.level", level + 1)
print("升级到:", level + 1)

State.set("game.player.name", "勇者")
print("设置玩家名称: 勇者")

-- 验证读取
local new_level = State.get("game.player.level")
local name = State.get("game.player.name")

print("验证: 等级=" .. tostring(new_level) .. ", 名称=" .. tostring(name))

return string.format("✅ 测试完成！等级: %d, 名称: %s", new_level, name)
      `, 'test_basic_v1')
      setOutput(res)
    } catch (e) {
      setErr(String(e))
      setOutput('')
    }
  }

  const testSharedState = async () => {
    setErr('')
    setOutput('测试共享命名空间...')
    try {
      // 脚本 A：创建共享数据
      registerNamespaces('scriptA_v1', {
        'events.world': {
          read: true,
          write: true,
          shared: true,
          persistent: true
        }
      })

      await runLua(`
State.set("events.world.bossDefeated", true)
State.set("events.world.bossName", "炎龙")
print("[脚本A] 设置世界事件（共享）")
      `, 'scriptA_v1')

      // 脚本 B：读取共享数据
      registerNamespaces('scriptB_v1', {
        'events.world': {
          read: true,
          write: false,
          shared: true,
          persistent: true
        }
      })

      const res = await runLua(`
print("[脚本B] 尝试读取共享命名空间...")

local defeated = State.get("events.world.bossDefeated")
local name = State.get("events.world.bossName")

print("  - Boss已击败:", defeated)
print("  - Boss名称:", name)

-- 尝试写入（应该会失败）
local success, err = pcall(function()
  State.set("events.world.newData", "test")
end)

if not success then
  print("\\n❌ 预期的权限错误:", err)
end

return string.format("✅ 成功读取共享数据：%s 已被击败", name)
      `, 'scriptB_v1')
      setOutput(res)
    } catch (e) {
      setErr(String(e))
      setOutput('')
    }
  }

  const viewStateData = async () => {
    try {
      console.log('[viewStateData] Fetching all state records...')
      const records = await getAllStateRecords()
      console.log('[viewStateData] Retrieved records:', records.length, records)
      setStateData(records)
    } catch (e) {
      console.error('[viewStateData] Error:', e)
      setErr(String(e))
      setStateData([])
    }
  }

  const clearAllState = async () => {
    if (!confirm('确定要清除所有状态数据吗？这将删除所有数据并刷新页面。')) return
    
    try {
      // 通过 clearCache 清空所有数据
      clearCache()
      alert('✅ 数据已清除，页面即将刷新')
      window.location.reload()
    } catch (e) {
      setErr(String(e))
    }
  }

  const forceRecreateDB = () => {
    if (!confirm('强制刷新页面以重新初始化数据库？')) return
    // 简单刷新页面，让 state-manager 的自动恢复机制处理数据库问题
    window.location.reload()
  }

  return (
    <div style={{ maxWidth: 900, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui, Arial, sans-serif' }}>
      <h1>Lua Runner (mlua + WASM)</h1>
      <p>在下方输入 Lua 代码，点击"运行"查看结果。</p>
      
      {/* 标签页切换 */}
      <div style={{ margin: '1rem 0', borderBottom: '2px solid #e0e4ea' }}>
        <button 
          onClick={() => setActiveTab('lua')}
          style={{ 
            padding: '0.5rem 1rem', 
            border: 'none', 
            background: activeTab === 'lua' ? '#0066cc' : 'transparent',
            color: activeTab === 'lua' ? 'white' : '#666',
            cursor: 'pointer',
            borderRadius: '4px 4px 0 0'
          }}
        >
          Lua 代码运行
        </button>
        <button 
          onClick={() => { setActiveTab('state'); viewStateData(); }}
          style={{ 
            padding: '0.5rem 1rem', 
            border: 'none', 
            background: activeTab === 'state' ? '#0066cc' : 'transparent',
            color: activeTab === 'state' ? 'white' : '#666',
            cursor: 'pointer',
            borderRadius: '4px 4px 0 0',
            marginLeft: '0.25rem'
          }}
        >
          状态管理测试
        </button>
        <button 
          onClick={() => setActiveTab('namespace-test')}
          style={{ 
            padding: '0.5rem 1rem', 
            border: 'none', 
            background: activeTab === 'namespace-test' ? '#0066cc' : 'transparent',
            color: activeTab === 'namespace-test' ? 'white' : '#666',
            cursor: 'pointer',
            borderRadius: '4px 4px 0 0',
            marginLeft: '0.25rem'
          }}
        >
          命名空间隔离测试
        </button>
      </div>

      {activeTab === 'lua' ? (
        <>
          <div style={{ margin: '1rem 0', padding: '0.75rem', background: '#f8f9fb', borderRadius: 8, border: '1px solid #e0e4ea' }}>
            <strong>模块加载：</strong>
            <ul style={{ marginTop: '0.5rem' }}>
              <li><code>mediawiki://&lt;wiki&gt;/Module:Name</code> 将从 MediaWiki 站点拉取原始模块</li>
              <li><code>https://example.com/script.lua</code> 支持直接从 URL 获取 Lua 文件</li>
              <li>上传文件后使用 <code>require("file://文件名.lua")</code> 进行引用</li>
            </ul>
            <label style={{ display: 'inline-block', marginTop: '0.5rem' }}>
              <span style={{ marginRight: '0.75rem' }}>上传 Lua 模块文件：</span>
              <input type="file" accept=".lua" multiple onChange={onUploadFiles} />
            </label>
            {files.length > 0 && (
              <div style={{ marginTop: '0.75rem' }}>
                <span>已上传：</span>
                <ul style={{ marginTop: '0.35rem' }}>
                  {files.map(name => (
                    <li key={name} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <code>{name}</code>
                      <button type="button" onClick={() => onRemoveFile(name)} style={{ padding: '0 0.5rem' }}>移除</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <textarea
            value={code}
            onChange={e => setCode(e.target.value)}
            rows={12}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 14 }}
          />
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
            <button onClick={onRun} disabled={!ready}>
              {ready ? '运行' : '加载中...'}
            </button>
            {err && <span style={{ color: 'crimson' }}>{err}</span>}
          </div>
          <h3 style={{ marginTop: '1.5rem' }}>输出</h3>
          <pre style={{ background: '#f7f7f7', padding: '1rem', minHeight: '120px', whiteSpace: 'pre-wrap' }}>{output}</pre>
          <p style={{ color: '#666' }}>提示：print 输出会被捕获；表达式的返回值也会显示在输出尾部。</p>
        </>
      ) : activeTab === 'state' ? (
        <>
          <div style={{ margin: '1rem 0', padding: '0.75rem', background: '#f8f9fb', borderRadius: 8, border: '1px solid #e0e4ea' }}>
            <h3 style={{ marginTop: 0 }}>🧪 状态管理系统测试</h3>
            <p>测试 <strong>同步 API</strong>：State 表由 Rust 直接注入，支持持久化存储。</p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button onClick={testBasicState} disabled={!ready}>
                测试基础读写
              </button>
              <button onClick={testSharedState} disabled={!ready}>
                测试共享命名空间
              </button>
              <button onClick={viewStateData} disabled={!ready} style={{ background: '#28a745', color: 'white' }}>
                刷新状态数据
              </button>
              <button onClick={clearAllState} disabled={!ready} style={{ background: '#dc3545', color: 'white' }}>
                清除所有状态
              </button>
              <button onClick={forceRecreateDB} style={{ background: '#ff6600', color: 'white', fontWeight: 'bold' }}>
                🔧 强制重建数据库
              </button>
            </div>
          </div>

          {/* 输出区域 */}
          {output && (
            <>
              <h3 style={{ marginTop: '1.5rem' }}>输出</h3>
              <pre style={{ background: '#f7f7f7', padding: '1rem', minHeight: '120px', whiteSpace: 'pre-wrap' }}>{output}</pre>
            </>
          )}
          {err && <div style={{ color: 'crimson', marginTop: '1rem' }}>{err}</div>}

          {/* 状态数据查看器 */}
          <h3 style={{ marginTop: '1.5rem' }}>IndexedDB 状态数据</h3>
          {stateData.length === 0 ? (
            <p style={{ color: '#666' }}>暂无数据</p>
          ) : (
            <div style={{ background: '#f0f7ff', padding: '1rem', borderRadius: 8, border: '1px solid #4CAF50' }}>
              {stateData.map((record, idx) => (
                <div key={idx} style={{ 
                  background: 'white', 
                  padding: '0.75rem', 
                  marginBottom: '0.5rem', 
                  borderRadius: 4,
                  border: '1px solid #e0e4ea'
                }}>
                  <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
                    {record.fullKey || record.key}
                    {record.ttl && <span style={{ color: '#666', fontSize: '0.875rem', marginLeft: '0.5rem' }}>(TTL: {record.ttl}ms)</span>}
                  </div>
                  <code style={{ fontSize: '0.875rem', color: '#666' }}>
                    {JSON.stringify(record.value)}
                  </code>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <NamespaceTest />
      )}
    </div>
  )
}
