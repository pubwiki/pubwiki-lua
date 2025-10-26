# runLua API 变更 - 强制 scriptId 参数

## 变更概述

`runLua` 函数现在**强制要求传入 `scriptId` 参数**，scriptId 通过 **Lua VM App Data** 管理，**完全隔离于 Lua 运行时**，脚本无法访问或修改。

**✅ 支持并发调用：** 多个 `runLua` 可以安全地并发执行，每个调用使用独立的 Lua VM 实例和 scriptId。详见 [CONCURRENT_SAFETY.md](./CONCURRENT_SAFETY.md)。

## 变更原因

### 安全性问题

之前的设计允许 Lua 脚本自己设置 `__SCRIPT_ID`：
```lua
-- ❌ 旧的方式（不安全）
_G.__SCRIPT_ID = "admin-script"  -- 脚本可以伪造身份！
State.set("admin.config", "malicious data")
```

这带来严重的安全风险：
- 🔴 **身份伪造**：脚本可以假装是其他脚本
- 🔴 **权限绕过**：脚本可以访问不应该访问的命名空间
- 🔴 **数据污染**：脚本可以修改其他脚本的状态

即使在 Rust 端设置 `__SCRIPT_ID` 全局变量也不够安全：
```lua
-- ❌ 即使 Rust 设置了，Lua 仍然可以覆盖
_G.__SCRIPT_ID = "admin-script"  -- 覆盖成功！不安全！
State.set("admin.config", "malicious")
```

### 新的设计（完全安全 + 并发安全）

现在使用 **Lua VM App Data**，scriptId 存储在每个 Lua VM 实例中，**Lua 脚本无法访问或修改**：

**Rust 实现：**
```rust
#[no_mangle]
pub extern "C" fn lua_run(code_ptr: *const c_char, script_id_ptr: *const c_char) -> *const c_char {
    let code = read_c_string(code_ptr)?;
    let script_id = read_c_string(script_id_ptr)?;
    
    // 创建新的 Lua VM 实例
    let lua = Lua::new();
    
    // 将 scriptId 存储在这个 VM 实例的 app data 中
    lua.set_app_data(script_id.clone());
    
    // State API 从 app data 读取（Lua 无法访问）
    install_state_api(&lua)?;
    
    // 执行代码
    lua.load(&code).eval()?;
}

// State API 实现
let get_fn = lua.create_function(|lua, (key, default)| {
    // 从当前 Lua VM 的 app data 获取 scriptId
    let script_id: String = lua.app_data_ref::<String>()
        .ok_or_else(|| LuaError::external("Script ID not set"))?
        .clone();
    // 使用 script_id 进行权限检查...
})?;
```

**JavaScript 使用：**
```typescript
// ✅ 新的方式（完全安全 + 并发安全）
await runLua(`
  State.set("user.config", "safe")  -- scriptId 存储在 Lua VM app data
  
  -- ❌ 即使尝试修改也无效
  _G.__SCRIPT_ID = "admin"  -- 这只是个普通 Lua 变量，不影响权限！
  State.set("admin.config", "...")  -- 仍然以 'user-script' 身份运行
`, 'user-script')

// ✅ 并发调用完全安全
Promise.all([
  runLua('State.set("a", 1)', 'script-A'),
  runLua('State.set("b", 2)', 'script-B'),
  runLua('State.set("c", 3)', 'script-C'),
])
// 每个调用使用独立的 Lua VM，互不干扰
```

**安全保证：**
- ✅ **完全隔离**：scriptId 存储在 Lua VM app data，Lua 完全无法访问
- ✅ **防止伪造**：即使脚本设置 `_G.__SCRIPT_ID`，也不会影响实际权限
- ✅ **不可变**：一旦 `lua_run` 开始执行，scriptId 就不可更改
- ✅ **明确控制**：应用层完全控制脚本权限
- ✅ **并发安全**：多个 `runLua` 调用可以并发执行，每个使用独立的 VM 实例

## API 变更

### TypeScript/JavaScript 层

**旧 API：**
```typescript
function runLua(code: string): Promise<string>
```

**新 API：**
```typescript
function runLua(code: string, scriptId: string): Promise<string>
```

**迁移示例：**
```typescript
// 旧代码
const result = await runLua(`
  _G.__SCRIPT_ID = "my-script"
  return State.get("count", 0)
`)

// 新代码
const result = await runLua(`
  return State.get("count", 0)
`, 'my-script')  // scriptId 作为参数传入
```

### Rust WASM 层

**旧签名：**
```rust
pub extern "C" fn lua_run(code_ptr: *const c_char) -> *const c_char
```

**新签名：**
```rust
pub extern "C" fn lua_run(code_ptr: *const c_char, script_id_ptr: *const c_char) -> *const c_char
```

**内部实现：**
```rust
// 在创建 Lua VM 后立即设置 __SCRIPT_ID（只读）
let lua = Lua::new();
lua.globals().set("__SCRIPT_ID", script_id.as_str())?;
```

现在 `__SCRIPT_ID` 由 Rust 设置，Lua 脚本无法修改。

## 迁移指南

### 1. 更新所有 runLua 调用

```typescript
// ❌ 旧代码
await runLua(`print("hello")`)

// ✅ 新代码
await runLua(`print("hello")`, 'my-script-id')
```

### 2. 移除 Lua 代码中的 __SCRIPT_ID 设置

```lua
-- ❌ 旧代码（不需要了）
_G.__SCRIPT_ID = "my-script"
State.set("key", "value")

-- ✅ 新代码（简洁）
State.set("key", "value")
```

### 3. 在注册命名空间时使用相同的 scriptId

```typescript
// 注册命名空间
registerNamespaces('user-script-123', {
  'user.data': { read: true, write: true }
})

// 运行脚本时使用相同的 ID
await runLua(`
  State.set("user.data.score", 100)
`, 'user-script-123')  // ✅ 必须匹配
```

## 示例对比

### 示例 1：基础使用

**旧代码：**
```typescript
registerNamespaces('game-script', {
  'game.player': { read: true, write: true }
})

await runLua(`
  _G.__SCRIPT_ID = "game-script"
  State.set("game.player.hp", 100)
  return State.get("game.player.hp")
`)
```

**新代码：**
```typescript
registerNamespaces('game-script', {
  'game.player': { read: true, write: true }
})

await runLua(`
  State.set("game.player.hp", 100)
  return State.get("game.player.hp")
`, 'game-script')  // scriptId 作为参数
```

### 示例 2：多脚本场景

**旧代码：**
```typescript
// 脚本 A
await runLua(`
  _G.__SCRIPT_ID = "scriptA"
  State.set("events.boss", "defeated")
`)

// 脚本 B（可能伪造身份）
await runLua(`
  _G.__SCRIPT_ID = "scriptA"  -- ❌ 伪造！
  State.set("events.boss", "active")  -- 篡改数据
`)
```

**新代码：**
```typescript
// 脚本 A
await runLua(`
  State.set("events.boss", "defeated")
`, 'scriptA')

// 脚本 B（无法伪造）
await runLua(`
  State.set("events.boss", "active")  -- ❌ 权限错误
`, 'scriptB')  // 只能以 scriptB 身份运行
```

## 破坏性变更

⚠️ **这是一个破坏性变更**，需要更新所有调用 `runLua` 的代码。

### 编译时检查

TypeScript 会在编译时捕获缺少 scriptId 的调用：
```typescript
// ❌ 编译错误：Expected 2 arguments, but got 1
await runLua(`print("hello")`)

// ✅ 正确
await runLua(`print("hello")`, 'my-script')
```

### 运行时行为

如果使用旧的 WASM 文件（没有重新编译），会导致运行时错误：
```
Error: Expected 2 arguments to _lua_run, but got 1
```

**解决方法**：重新编译 Rust WASM：
```bash
just wasm  # 需要 emsdk 环境
```

## 最佳实践

### 1. 使用有意义的 scriptId

```typescript
// ❌ 不好
await runLua(code, 'script1')

// ✅ 好
await runLua(code, 'user-profile-editor')
```

### 2. 在应用层管理 scriptId

```typescript
class ScriptRunner {
  constructor(private scriptId: string) {}
  
  async run(code: string) {
    return runLua(code, this.scriptId)
  }
}

const userScript = new ScriptRunner('user-script-123')
await userScript.run(`State.set("score", 100)`)
```

### 3. 验证 scriptId 格式

```typescript
function validateScriptId(id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('Invalid scriptId format')
  }
  return id
}

await runLua(code, validateScriptId(userInput))
```

## 技术细节

### 内存管理

新的实现需要为 `scriptId` 分配额外的内存：

```typescript
// 分配 code 字符串
const codeBytes = textEncoder.encode(`${code}\0`)
const codePtr = module._malloc(codeBytes.length)
module.HEAPU8.set(codeBytes, codePtr)

// 分配 scriptId 字符串
const scriptIdBytes = textEncoder.encode(`${scriptId}\0`)
const scriptIdPtr = module._malloc(scriptIdBytes.length)
module.HEAPU8.set(scriptIdBytes, scriptIdPtr)

// 调用 WASM 函数
const resultPtr = module._lua_run(codePtr, scriptIdPtr)

// 清理内存
module._free(codePtr)
module._free(scriptIdPtr)
```

### Rust 端实现

```rust
pub extern "C" fn lua_run(code_ptr: *const c_char, script_id_ptr: *const c_char) -> *const c_char {
    let code = read_c_string(code_ptr)?;
    let script_id = read_c_string(script_id_ptr)?;
    
    // 创建新的 Lua VM 实例
    let lua = Lua::new();
    
    // 将 scriptId 存储在这个 VM 的 app data 中（Lua 无法访问）
    lua.set_app_data(script_id.clone());
    
    // 安装 State API
    install_state_api(&lua)?;
    
    // 执行代码
    lua.load(&code).eval()?;
}
```

### State API 实现

State API 函数从 Lua VM 的 app data 读取 scriptId：

```rust
// State.get/set/delete/list 都从 app data 读取
let get_fn = lua.create_function(|lua, (key, default)| {
    // 从当前 Lua VM 的 app data 获取 scriptId（Lua 无法修改）
    let script_id: String = lua.app_data_ref::<String>()
        .ok_or_else(|| LuaError::external("Script ID not set"))?
        .clone();
    
    // 使用 script_id 进行权限检查...
    // 即使 Lua 设置了 _G.__SCRIPT_ID，也不会影响这里的 script_id
})?;
```

**关键优势：**
- Lua VM 的 app data 是每个 VM 实例独立的
- Lua 运行时完全无法访问 app data 中的数据
- 即使 Lua 脚本尝试修改任何全局变量，都不会影响权限检查
- **每个 `runLua` 调用创建新 VM，天然支持并发**

## 总结

### 变更前（不安全）
- ❌ 脚本可以伪造身份（通过设置 `_G.__SCRIPT_ID`）
- ❌ 权限控制不可靠
- ❌ API 不直观
- ❌ 即使 Rust 设置了全局变量，Lua 仍可覆盖

### 变更后（完全安全 + 并发安全）
- ✅ scriptId 存储在 Lua VM app data，Lua 完全无法访问
- ✅ 应用层控制脚本身份
- ✅ 权限检查100%可靠
- ✅ 即使脚本设置 `_G.__SCRIPT_ID = "admin"`，也不会影响权限
- ✅ API 更清晰
- ✅ 遵循最小权限原则
- ✅ **支持并发调用**：多个 `runLua` 可以安全地并发执行

**这个变更大大提升了系统的安全性和并发能力，建议所有用户尽快迁移！**

详细的并发安全说明请参考 [CONCURRENT_SAFETY.md](./CONCURRENT_SAFETY.md)。
