# 并发安全 - 支持异步多次调用 runLua

## 问题

之前的 thread-local 实现存在并发问题：

```typescript
// ❌ 潜在的竞态条件（thread-local 方案）
Promise.all([
  runLua('State.get("key")', 'script-A'),  // 设置 CURRENT_SCRIPT_ID = "script-A"
  runLua('State.get("key")', 'script-B'),  // 立即覆盖 CURRENT_SCRIPT_ID = "script-B"
])
// script-A 的执行可能会使用 script-B 的身份！
```

**问题原因：**
- Thread-local 变量是每个线程一个
- 在 WASM 单线程环境中，所有调用共享同一个 thread-local
- 如果多个 `runLua` 调用交错执行，后面的调用会覆盖前面的 scriptId

## 解决方案：Lua App Data

使用 **Lua 的 App Data** 而不是 thread-local：
- 每个 Lua VM 实例都有自己的 app data
- 不同的 `runLua` 调用创建不同的 Lua VM 实例
- 完全隔离，互不影响

## 实现

### Rust 端

```rust
// 不再使用 thread-local
// ❌ 删除了：static CURRENT_SCRIPT_ID: RefCell<String> = ...

#[no_mangle]
pub extern "C" fn lua_run(code_ptr: *const c_char, script_id_ptr: *const c_char) -> *const c_char {
    let code = read_c_string(code_ptr)?;
    let script_id = read_c_string(script_id_ptr)?;
    
    // 创建新的 Lua VM 实例
    let lua = Lua::new();
    
    // ✅ 将 scriptId 存储在这个 VM 实例的 app data 中
    lua.set_app_data(script_id.clone());
    
    // 安装 State API
    install_state_api(&lua)?;
    
    // 执行代码
    lua.load(&code).eval()?;
}
```

### State API 读取

```rust
// State API 从 Lua 的 app data 读取 scriptId
let get_fn = lua.create_function(|lua, (key, default)| {
    // 从当前 Lua VM 的 app data 获取 scriptId
    let script_id: String = lua.app_data_ref::<String>()
        .ok_or_else(|| LuaError::external("Script ID not set"))?
        .clone();
    
    // 使用 script_id 进行权限检查...
})?;
```

## 并发安全保证

### 测试场景 1：并发调用不同 scriptId

```typescript
// ✅ 现在完全安全
const results = await Promise.all([
  runLua(`
    State.set("script-a.data", "A")
    return State.get("script-a.data")
  `, 'script-A'),
  
  runLua(`
    State.set("script-b.data", "B")
    return State.get("script-b.data")
  `, 'script-B'),
  
  runLua(`
    State.set("script-c.data", "C")
    return State.get("script-c.data")
  `, 'script-C'),
])

// 结果：
// results[0] = "A" (使用 script-A 身份)
// results[1] = "B" (使用 script-B 身份)
// results[2] = "C" (使用 script-C 身份)
// ✅ 每个调用都使用正确的身份
```

### 测试场景 2：快速连续调用

```typescript
// ✅ 即使调用间隔很短也安全
for (let i = 0; i < 100; i++) {
  runLua(`State.set("count", ${i})`, `script-${i}`)
}
// ✅ 每个脚本都使用自己的身份
```

### 测试场景 3：嵌套 Promise

```typescript
// ✅ 复杂的异步场景也安全
async function complexScenario() {
  const p1 = runLua('...', 'script-A')
  await new Promise(r => setTimeout(r, 10))
  const p2 = runLua('...', 'script-B')
  await new Promise(r => setTimeout(r, 10))
  const p3 = runLua('...', 'script-C')
  
  return Promise.all([p1, p2, p3])
}
// ✅ 所有脚本都使用正确的身份
```

## 技术原理

### Lua VM 实例隔离

```
调用 1: runLua(code1, 'script-A')
  ↓
  创建 Lua VM 实例 1
  ↓
  VM1.app_data = "script-A"
  ↓
  执行 code1（读取 VM1.app_data）
  
调用 2: runLua(code2, 'script-B')
  ↓
  创建 Lua VM 实例 2
  ↓
  VM2.app_data = "script-B"
  ↓
  执行 code2（读取 VM2.app_data）

✅ VM1 和 VM2 完全独立，互不影响
```

### 与 Thread-Local 的对比

| 特性 | Thread-Local 方案 | App Data 方案 |
|-----|------------------|--------------|
| 存储位置 | 每线程一个 | 每 VM 实例一个 |
| 并发安全 | ❌ 不安全（单线程环境） | ✅ 完全安全 |
| 隔离性 | ❌ 调用之间共享 | ✅ 完全隔离 |
| 适用场景 | 多线程环境 | 单线程 + 多 VM |

## 安全性验证

### 尝试访问其他脚本的数据

```typescript
// 设置数据
await runLua(`State.set("secret", "admin-password")`, 'admin-script')

// 尝试用另一个脚本访问（应该失败）
const result = await runLua(`
  -- 即使尝试修改身份也无效
  _G.__SCRIPT_ID = "admin-script"
  
  -- 尝试访问 admin 数据（会被拒绝）
  return State.get("secret")  -- 权限错误
`, 'user-script')

// ✅ 返回权限错误，无法访问
```

### 并发修改测试

```typescript
// 多个脚本并发修改各自的数据
await Promise.all([
  runLua(`
    for i = 1, 1000 do
      State.set("counter", i)
    end
  `, 'script-A'),
  
  runLua(`
    for i = 1, 1000 do
      State.set("counter", i)
    end
  `, 'script-B'),
])

// ✅ script-A 和 script-B 的 counter 是隔离的
```

## 性能影响

**App Data 方案没有性能损失：**
- 每个 `runLua` 调用本来就会创建新的 Lua VM
- App Data 只是在创建时存储一个额外的 String
- 读取 App Data 是 O(1) 操作
- 没有额外的锁或同步开销

## 总结

### 变更前（Thread-Local）
- ❌ 并发调用会互相覆盖 scriptId
- ❌ 可能导致权限混乱
- ❌ 不支持异步场景

### 变更后（App Data）
- ✅ 每个 Lua VM 实例独立的 scriptId
- ✅ 完全隔离，互不影响
- ✅ 支持任意并发和异步调用
- ✅ 100%线程安全（虽然是单线程环境）

**现在可以安全地并发调用 `runLua`！** 🎉
