import React, { useEffect, useState } from 'react'
import { loadRunner, runLua, registerFileModule, removeFileModule, listFileModules } from 'pubwiki-lua'

export default function App() {
  const [ready, setReady] = useState(false)
  const [code, setCode] = useState(`print('Hello from Lua!')\nreturn 1+2`)
  const [output, setOutput] = useState('')
  const [err, setErr] = useState('')
  const [files, setFiles] = useState([])

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
      const res = await runLua(code)
      setOutput(res)
    } catch (e) {
      setErr(String(e))
      setOutput('')
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui, Arial, sans-serif' }}>
      <h1>Lua Runner (mlua + WASM)</h1>
      <p>在下方输入 Lua 代码，点击“运行”查看结果。</p>
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
    </div>
  )
}
