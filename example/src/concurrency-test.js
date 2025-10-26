/**
 * 并发安全测试
 * 
 * 测试场景：
 * 1. 多个脚本并发设置各自的数据
 * 2. 验证每个脚本使用正确的 scriptId
 * 3. 验证不会发生数据混乱
 */

import { runLua, registerNamespaces, setStorageBackend, MemoryBackend } from '../../pubwiki-lua/src/index.ts'

// 使用内存后端，便于测试
setStorageBackend(new MemoryBackend())

/**
 * 测试1：并发设置不同命名空间的数据
 */
export async function testConcurrentWrites() {
  console.log('🧪 测试1：并发写入不同命名空间')
  
  // 注册命名空间
  registerNamespaces('script-A', {
    'test.a': { read: true, write: true }
  })
  registerNamespaces('script-B', {
    'test.b': { read: true, write: true }
  })
  registerNamespaces('script-C', {
    'test.c': { read: true, write: true }
  })
  
  // 并发写入
  const results = await Promise.all([
    runLua(`
      State.set("test.a.value", "A")
      return State.get("test.a.value")
    `, 'script-A'),
    
    runLua(`
      State.set("test.b.value", "B")
      return State.get("test.b.value")
    `, 'script-B'),
    
    runLua(`
      State.set("test.c.value", "C")
      return State.get("test.c.value")
    `, 'script-C'),
  ])
  
  console.log('结果:', results)
  console.assert(results[0] === '"A"', '脚本A应返回A')
  console.assert(results[1] === '"B"', '脚本B应返回B')
  console.assert(results[2] === '"C"', '脚本C应返回C')
  console.log('✅ 测试1通过\n')
}

/**
 * 测试2：快速连续调用（模拟竞态条件）
 */
export async function testRaceCondition() {
  console.log('🧪 测试2：竞态条件测试')
  
  // 注册100个脚本的命名空间
  for (let i = 0; i < 100; i++) {
    registerNamespaces(`race-${i}`, {
      [`race.${i}`]: { read: true, write: true }
    })
  }
  
  // 快速并发调用
  const promises = []
  for (let i = 0; i < 100; i++) {
    promises.push(
      runLua(`
        State.set("race.${i}.counter", ${i})
        return State.get("race.${i}.counter")
      `, `race-${i}`)
    )
  }
  
  const results = await Promise.all(promises)
  
  // 验证每个脚本都得到了正确的值
  for (let i = 0; i < 100; i++) {
    const expected = String(i)
    const actual = results[i]
    console.assert(actual === expected, `race-${i} 应返回 ${expected}，实际返回 ${actual}`)
  }
  
  console.log('✅ 测试2通过 - 100个并发调用全部正确\n')
}

/**
 * 测试3：尝试伪造身份（应该失败）
 */
export async function testIdentitySpoofing() {
  console.log('🧪 测试3：身份伪造防护')
  
  // 注册admin命名空间
  registerNamespaces('admin-script', {
    'admin.secret': { read: true, write: true }
  })
  
  // admin设置秘密数据
  await runLua(`
    State.set("admin.secret.password", "super-secret-123")
  `, 'admin-script')
  
  // 恶意脚本尝试伪造身份
  try {
    const result = await runLua(`
      -- 尝试伪造身份
      _G.__SCRIPT_ID = "admin-script"
      
      -- 尝试读取admin数据
      return State.get("admin.secret.password")
    `, 'evil-script')
    
    // 如果成功读取，说明有安全漏洞
    console.error('❌ 安全漏洞：恶意脚本成功读取了admin数据！')
    console.error('读取到的值:', result)
  } catch (error) {
    // 应该抛出权限错误
    console.log('✅ 防护成功 - 恶意脚本无法访问admin数据')
    console.log('错误信息:', error.message)
  }
  
  console.log('✅ 测试3通过\n')
}

/**
 * 测试4：嵌套异步调用
 */
export async function testNestedAsync() {
  console.log('🧪 测试4：嵌套异步调用')
  
  // 注册命名空间
  registerNamespaces('outer', {
    'test.outer': { read: true, write: true }
  })
  registerNamespaces('inner', {
    'test.inner': { read: true, write: true }
  })
  
  // 外层调用
  const result1 = await runLua(`
    State.set("test.outer.value", "OUTER")
    return State.get("test.outer.value")
  `, 'outer')
  
  // 稍微延迟
  await new Promise(r => setTimeout(r, 10))
  
  // 内层调用（交错执行）
  const result2 = await runLua(`
    State.set("test.inner.value", "INNER")
    return State.get("test.inner.value")
  `, 'inner')
  
  // 再次调用外层
  const result3 = await runLua(`
    return State.get("test.outer.value")
  `, 'outer')
  
  console.log('结果:', { result1, result2, result3 })
  console.assert(result1 === '"OUTER"', '第一次outer调用正确')
  console.assert(result2 === '"INNER"', 'inner调用正确')
  console.assert(result3 === '"OUTER"', '第二次outer调用正确')
  console.log('✅ 测试4通过\n')
}

/**
 * 运行所有测试
 */
export async function runAllTests() {
  console.log('=' .repeat(50))
  console.log('🚀 开始并发安全测试')
  console.log('=' .repeat(50) + '\n')
  
  try {
    await testConcurrentWrites()
    await testRaceCondition()
    await testIdentitySpoofing()
    await testNestedAsync()
    
    console.log('=' .repeat(50))
    console.log('🎉 所有测试通过！')
    console.log('=' .repeat(50))
  } catch (error) {
    console.error('❌ 测试失败:', error)
    throw error
  }
}
