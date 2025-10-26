import React, { useState } from 'react';
import { runLua, registerNamespaces } from './wasmRunner';

/**
 * 测试命名空间隔离功能
 * 验证不同脚本的同名命名空间是否被正确隔离
 */
export default function NamespaceTest() {
  const [results, setResults] = useState([]);
  const [isRunning, setIsRunning] = useState(false);

  const addResult = (testName, success, details) => {
    setResults(prev => [...prev, {
      testName,
      success,
      details,
      timestamp: new Date().toISOString()
    }]);
  };

  const clearResults = () => {
    setResults([]);
  };

  const runTests = async () => {
    setIsRunning(true);
    clearResults();

    try {
      // 测试 1: 不同脚本的同名命名空间应该被隔离
      addResult('Test 1', null, '测试命名空间隔离...');
      
      // 注册 script-A 的命名空间
      registerNamespaces('script-A', {
        'user.profile': {
          read: true, write: true, shared: false, persistent: true
        }
      });

      // 注册 script-B 的同名命名空间
      registerNamespaces('script-B', {
        'user.profile': {
          read: true, write: true, shared: false, persistent: true
        }
      });

      // Script A 写入数据并读取验证
      const scriptA = `
        State.set('user.profile', { name = 'Alice', age = 30 })
        return State.get('user.profile')
      `;
      const resultA = await runLua('script-A', scriptA);
      
      // Script B 写入不同的数据并读取验证
      const scriptB = `
        State.set('user.profile', { name = 'Bob', age = 25 })
        return State.get('user.profile')
      `;
      const resultB = await runLua('script-B', scriptB);

      // 验证数据隔离
      console.log(resultA)
      const dataA = JSON.parse(resultA);
      const dataB = JSON.parse(resultB);
      
      const isolated = dataA.name === 'Alice' && dataB.name === 'Bob';
      addResult(
        'Test 1: 命名空间隔离',
        isolated,
        isolated 
          ? `✓ Script A: ${dataA.name}, Script B: ${dataB.name} - 数据正确隔离`
          : `✗ 数据未隔离: Script A: ${JSON.stringify(dataA)}, Script B: ${JSON.stringify(dataB)}`
      );

      // 测试 2: 共享命名空间应该被所有脚本访问
      addResult('Test 2', null, '测试共享命名空间...');
      
      registerNamespaces('script-A', {
        'global.events': {
          read: true,
          write: true,
          shared: true,
          persistent: true
        }
      });

      registerNamespaces('script-B', {
        'global.events': {
          read: true,
          write: true,
          shared: true,
          persistent: true
        }
      });

      // Script A 写入共享数据
      const scriptAShared = `
        State.set('global.events', { lastEvent = 'login', timestamp = 12345 })
        return 'written'
      `;
      await runLua('script-A', scriptAShared);

      // Script B 读取共享数据
      const scriptBShared = `
        return State.get('global.events')
      `;
      const resultShared = await runLua('script-B', scriptBShared);
      const sharedData = JSON.parse(resultShared);
      
      const shared = sharedData && sharedData.lastEvent === 'login';
      addResult(
        'Test 2: 共享命名空间',
        shared,
        shared 
          ? `✓ Script B 成功读取 Script A 写入的共享数据: ${JSON.stringify(sharedData)}`
          : `✗ 共享数据访问失败: ${JSON.stringify(sharedData)}`
      );

      // 测试 3: list() 应该只返回可访问的命名空间
      console.log(">>>>>");
      addResult('Test 3', null, '测试 list() 返回的命名空间...');
      
      // Script A 写入多个数据
      const scriptAList = `
        State.set('user.profile', { name = 'Alice' })
        State.set('user.settings', { theme = 'dark' })
        local items = State.list('user')
        local count = 0
        for _ in pairs(items) do count = count + 1 end
        return tostring(count)
      `;
      const countA = await runLua('script-A', scriptAList);
      
      // Script B 写入自己的数据
      registerNamespaces('script-B', {
        'user.settings': {
          read: true, write: true, shared: false, persistent: true
        }
      });
      
      const scriptBList = `
        State.set('user.settings', { theme = 'light' })
        local items = State.list('user')
        local count = 0
        for _ in pairs(items) do count = count + 1 end
        return tostring(count)
      `;
      const countB = await runLua('script-B', scriptBList);
      
      // Script A 应该看到 2 个项 (user.profile + user.settings)
      // Script B 应该只看到 1 个项 (user.settings)
      const listCorrect = parseInt(countA) === 2 && parseInt(countB) === 1;
      addResult(
        'Test 3: list() 命名空间过滤',
        listCorrect,
        listCorrect
          ? `✓ Script A 看到 ${countA} 项, Script B 看到 ${countB} 项 - 正确隔离`
          : `✗ Script A: ${countA} 项, Script B: ${countB} 项 - 预期 A=2, B=1`
      );
      console.log("<<<<<");

      // 测试 4: 删除操作应该只影响自己的命名空间
      addResult('Test 4', null, '测试 delete() 隔离...');
      
      registerNamespaces('script-A', {
        'data.temp': {
          read: true, write: true, shared: false, persistent: true
        }
      });

      registerNamespaces('script-B', {
        'data.temp': {
          read: true, write: true, shared: false, persistent: true
        }
      });

      // Script A 和 B 都写入 data.temp
      await runLua('script-A', `State.set('data.temp', { value = 'A' }) return 'ok'`);
      await runLua('script-B', `State.set('data.temp', { value = 'B' }) return 'ok'`);

      // Script A 删除自己的 data.temp
      await runLua('script-A', `State.delete('data.temp') return 'ok'`);

      // Script B 应该仍能访问自己的 data.temp
      const resultBAfterDelete = await runLua('script-B', `return State.get('data.temp')`);
      const dataBAfterDelete = JSON.parse(resultBAfterDelete);
      
      const deleteIsolated = dataBAfterDelete && dataBAfterDelete.value === 'B';
      addResult(
        'Test 4: delete() 隔离',
        deleteIsolated,
        deleteIsolated
          ? `✓ Script B 的数据在 Script A 删除后仍然存在: ${JSON.stringify(dataBAfterDelete)}`
          : `✗ Script B 的数据被错误删除: ${JSON.stringify(dataBAfterDelete)}`
      );

    } catch (error) {
      addResult(
        '测试执行',
        false,
        `✗ 测试过程中发生错误: ${error.message}`
      );
      console.error('Test error:', error);
    }

    setIsRunning(false);
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'monospace' }}>
      <h2>Namespace Isolation Tests</h2>
      <p>测试不同脚本间的命名空间隔离功能</p>
      
      <button 
        onClick={runTests} 
        disabled={isRunning}
        style={{
          padding: '10px 20px',
          fontSize: '16px',
          marginBottom: '20px',
          backgroundColor: isRunning ? '#ccc' : '#4CAF50',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: isRunning ? 'not-allowed' : 'pointer'
        }}
      >
        {isRunning ? '运行中...' : '运行所有测试'}
      </button>

      <button 
        onClick={clearResults}
        style={{
          padding: '10px 20px',
          fontSize: '16px',
          marginLeft: '10px',
          marginBottom: '20px',
          backgroundColor: '#f44336',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer'
        }}
      >
        清除结果
      </button>

      <div>
        <h3>测试结果:</h3>
        {results.length === 0 && <p style={{ color: '#666' }}>暂无测试结果</p>}
        
        {results.map((result, index) => (
          <div 
            key={index}
            style={{
              padding: '10px',
              marginBottom: '10px',
              backgroundColor: 
                result.success === null ? '#f0f0f0' :
                result.success ? '#d4edda' : '#f8d7da',
              border: `1px solid ${
                result.success === null ? '#ccc' :
                result.success ? '#28a745' : '#dc3545'
              }`,
              borderRadius: '4px'
            }}
          >
            <strong>{result.testName}</strong>
            <br />
            <span>{result.details}</span>
            <br />
            <small style={{ color: '#666' }}>{result.timestamp}</small>
          </div>
        ))}
      </div>

      <div style={{ marginTop: '30px', padding: '15px', backgroundColor: '#e7f3ff', borderRadius: '4px' }}>
        <h3>测试说明:</h3>
        <ul>
          <li><strong>Test 1:</strong> 不同脚本的同名命名空间 (user.profile) 应该被自动隔离</li>
          <li><strong>Test 2:</strong> 共享命名空间 (global.events) 应该被所有脚本访问</li>
          <li><strong>Test 3:</strong> list() 应该只返回脚本可访问的命名空间</li>
          <li><strong>Test 4:</strong> delete() 只应该删除脚本自己的数据</li>
        </ul>
      </div>
    </div>
  );
}
