import { useState } from 'react'
import { 
  setStorageBackend, 
  MemoryBackend, 
  LocalStorageBackend, 
  IndexedDBBackend,
  loadRunner,
  runLua,
  registerNamespaces
} from 'pubwiki-lua'

export default function BackendExample() {
  const [selectedBackend, setSelectedBackend] = useState('indexeddb')
  const [isInitialized, setIsInitialized] = useState(false)
  const [output, setOutput] = useState('')
  const [loading, setLoading] = useState(false)

  const initializeWithBackend = async (backendType) => {
    setLoading(true)
    setOutput('')
    
    try {
      // Create backend based on selection
      let backend
      switch (backendType) {
        case 'memory':
          backend = new MemoryBackend()
          setOutput('Using MemoryBackend (data will not persist)...\n')
          break
        case 'localstorage':
          backend = new LocalStorageBackend()
          setOutput('Using LocalStorageBackend (persists in localStorage)...\n')
          break
        case 'indexeddb':
        default:
          backend = new IndexedDBBackend()
          setOutput('Using IndexedDBBackend (default, persists in IndexedDB)...\n')
          break
      }

      // Set the backend before loading runner
      setStorageBackend(backend)
      
      // Load the runner
      await loadRunner()
      
      // Register namespace for testing
      registerNamespaces('backend-test', {
        allowedNamespaces: ['default', 'test'],
        defaultNamespace: 'default'
      })

      setIsInitialized(true)
      setOutput(prev => prev + '✅ Initialized successfully!\n')
    } catch (error) {
      setOutput(prev => prev + `❌ Error: ${error.message}\n`)
    } finally {
      setLoading(false)
    }
  }

  const testState = async () => {
    setLoading(true)
    try {
      const script = `
        -- Test setting and getting state
        State.set("test_value", 12345)
        State.set("test_string", "Hello from " .. "${selectedBackend}")
        State.set("test_table", { foo = "bar", baz = 42 })
        
        -- Read them back
        local val = State.get("test_value")
        local str = State.get("test_string")
        local tbl = State.get("test_table")
        
        return string.format("Value: %d, String: %s, Table.foo: %s, Table.baz: %d", 
          val, str, tbl.foo, tbl.baz)
      `
      
      const result = await runLua(script, 'backend-test')
      setOutput(prev => prev + `📝 Test result:\n${result}\n`)
    } catch (error) {
      setOutput(prev => prev + `❌ Error: ${error.message}\n`)
    } finally {
      setLoading(false)
    }
  }

  const readState = async () => {
    setLoading(true)
    try {
      const script = `
        local val = State.get("test_value")
        local str = State.get("test_string")
        
        if val and str then
          return string.format("Found existing data: %d, %s", val, str)
        else
          return "No data found (try testing first)"
        end
      `
      
      const result = await runLua(script, 'backend-test')
      setOutput(prev => prev + `📖 Read result:\n${result}\n`)
    } catch (error) {
      setOutput(prev => prev + `❌ Error: ${error.message}\n`)
    } finally {
      setLoading(false)
    }
  }

  const clearState = async () => {
    setLoading(true)
    try {
      const script = `
        State.delete("test_value")
        State.delete("test_string")
        State.delete("test_table")
        return "Cleared all test data"
      `
      
      const result = await runLua(script, 'backend-test')
      setOutput(prev => prev + `🗑️ ${result}\n`)
    } catch (error) {
      setOutput(prev => prev + `❌ Error: ${error.message}\n`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
      <h1>🔧 Storage Backend Example</h1>
      
      <div style={{ marginBottom: '20px', padding: '15px', background: '#f0f0f0', borderRadius: '5px' }}>
        <h3>Step 1: Choose a Backend</h3>
        <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
          <label>
            <input
              type="radio"
              value="indexeddb"
              checked={selectedBackend === 'indexeddb'}
              onChange={(e) => setSelectedBackend(e.target.value)}
              disabled={isInitialized}
            />
            {' '}IndexedDB (Default)
          </label>
          <label>
            <input
              type="radio"
              value="memory"
              checked={selectedBackend === 'memory'}
              onChange={(e) => setSelectedBackend(e.target.value)}
              disabled={isInitialized}
            />
            {' '}Memory (No persistence)
          </label>
          <label>
            <input
              type="radio"
              value="localstorage"
              checked={selectedBackend === 'localstorage'}
              onChange={(e) => setSelectedBackend(e.target.value)}
              disabled={isInitialized}
            />
            {' '}LocalStorage
          </label>
        </div>
        
        <button
          onClick={() => initializeWithBackend(selectedBackend)}
          disabled={loading || isInitialized}
          style={{
            padding: '10px 20px',
            background: isInitialized ? '#ccc' : '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            cursor: isInitialized ? 'not-allowed' : 'pointer'
          }}
        >
          {isInitialized ? '✅ Initialized' : '🚀 Initialize Runner'}
        </button>
        
        {isInitialized && (
          <p style={{ marginTop: '10px', fontSize: '14px', color: '#666' }}>
            ⚠️ Reload the page to test a different backend
          </p>
        )}
      </div>

      <div style={{ marginBottom: '20px', padding: '15px', background: '#f0f0f0', borderRadius: '5px' }}>
        <h3>Step 2: Test State Operations</h3>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button
            onClick={testState}
            disabled={loading || !isInitialized}
            style={{
              padding: '10px 20px',
              background: !isInitialized ? '#ccc' : '#28a745',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              cursor: !isInitialized ? 'not-allowed' : 'pointer'
            }}
          >
            📝 Write Test Data
          </button>
          
          <button
            onClick={readState}
            disabled={loading || !isInitialized}
            style={{
              padding: '10px 20px',
              background: !isInitialized ? '#ccc' : '#17a2b8',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              cursor: !isInitialized ? 'not-allowed' : 'pointer'
            }}
          >
            📖 Read Data
          </button>
          
          <button
            onClick={clearState}
            disabled={loading || !isInitialized}
            style={{
              padding: '10px 20px',
              background: !isInitialized ? '#ccc' : '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              cursor: !isInitialized ? 'not-allowed' : 'pointer'
            }}
          >
            🗑️ Clear Data
          </button>
        </div>
      </div>

      <div style={{ padding: '15px', background: '#000', color: '#0f0', borderRadius: '5px', fontFamily: 'monospace', minHeight: '200px', whiteSpace: 'pre-wrap' }}>
        <h3 style={{ color: '#0f0', marginTop: 0 }}>Output:</h3>
        {output || '(waiting for actions...)'}
      </div>

      <div style={{ marginTop: '20px', padding: '15px', background: '#fff3cd', borderRadius: '5px', fontSize: '14px' }}>
        <h4>💡 Tips:</h4>
        <ul>
          <li><strong>IndexedDB:</strong> Data persists across page reloads (default)</li>
          <li><strong>Memory:</strong> Fast but data is lost on page reload (good for testing)</li>
          <li><strong>LocalStorage:</strong> Simple persistence with 5-10MB limit</li>
          <li>Try writing data, reloading the page with the same backend, then reading to see persistence!</li>
        </ul>
      </div>
    </div>
  )
}
