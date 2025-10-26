# App Data 设计 - Newtype Pattern

## 为什么使用 Newtype Wrapper

在之前的实现中，我们直接使用 `String` 类型存储 scriptId：

```rust
// ❌ 问题：类型混淆
lua.set_app_data(script_id.clone());  // String
let script_id = lua.app_data_ref::<String>()?;  // 任何 String 都可以匹配
```

**问题：**
- 如果将来需要存储其他 `String` 类型的数据到 app_data，会产生类型冲突
- 无法区分不同用途的 `String`
- 容易误用错误的类型

**解决方案：使用 Newtype Pattern**

```rust
// ✅ 类型安全
#[derive(Clone)]
struct ScriptId(String);

lua.set_app_data(ScriptId(script_id));
let script_id = lua.app_data_ref::<ScriptId>()?;  // 只匹配 ScriptId
```

## 设计概览

### 存储在 Lua App Data 的类型

我们定义了两个 newtype wrappers：

```rust
/// 脚本ID - 用于权限控制和状态隔离
#[derive(Clone)]
struct ScriptId(String);

/// MediaWiki require 栈 - 用于嵌套 require 解析
#[derive(Clone, Default)]
struct MediaWikiStack(Vec<String>);
```

### 存储在 Thread-Local 的类型

```rust
thread_local! {
    // 用于返回结果给 JS 侧（跨调用共享）
    static LAST_RESULT: RefCell<Option<CString>> = RefCell::new(None);
}
```

## 为什么 MediaWikiStack 使用 App Data

### 之前的设计（Thread-Local）

```rust
// ❌ 使用 thread-local
thread_local! {
    static MEDIAWIKI_STACK: RefCell<Vec<String>> = RefCell::new(Vec::new());
}

struct MediaWikiGuard {
    pushed: bool,
}

impl MediaWikiGuard {
    fn new(spec: &str) -> Self {
        MEDIAWIKI_STACK.with(|stack| {
            stack.borrow_mut().push(base);
        });
        MediaWikiGuard { pushed: true }
    }
}
```

**问题：**
- 多个并发的 `runLua` 调用会共享同一个 thread-local 栈
- 如果调用 A 和调用 B 同时执行，栈会混乱：
  ```
  调用 A: push("mediawiki://example.org/Module:")
  调用 B: push("mediawiki://other.org/Module:")  // 覆盖！
  调用 A: resolve("Foo") → 错误！使用了 other.org
  ```

### 新的设计（App Data）

```rust
// ✅ 使用 Lua app data
#[derive(Clone, Default)]
struct MediaWikiStack(Vec<String>);

struct MediaWikiGuard<'lua> {
    lua: &'lua Lua,
    pushed: bool,
}

impl<'lua> MediaWikiGuard<'lua> {
    fn new(lua: &'lua Lua, spec: &str) -> Self {
        // 每个 Lua VM 有自己的栈
        let mut stack = lua.app_data_ref::<MediaWikiStack>()
            .map(|s| s.clone())
            .unwrap_or_default();
        
        stack.0.push(base);
        lua.set_app_data(stack);
        
        MediaWikiGuard { lua, pushed: true }
    }
}
```

**优势：**
- 每个 `runLua` 调用创建独立的 Lua VM
- 每个 VM 有自己的 `MediaWikiStack`
- 完全隔离，不会互相干扰

## 为什么 LAST_RESULT 保持 Thread-Local

`LAST_RESULT` 的用途是：
1. Rust 函数返回 `*const c_char` 给 JS
2. JS 读取字符串后调用 `lua_free_last` 释放
3. 这是**跨调用**的数据传递机制

```rust
// ✅ LAST_RESULT 必须是 thread-local
thread_local! {
    static LAST_RESULT: RefCell<Option<CString>> = RefCell::new(None);
}

fn set_last_result(s: String) -> *const c_char {
    let c = CString::new(s).unwrap();
    let ptr = c.as_ptr();
    
    // 保存在 thread-local 中，防止 CString 被释放
    LAST_RESULT.with(|cell| {
        *cell.borrow_mut() = Some(c);
    });
    
    ptr  // 返回指针给 JS
}
```

**为什么不能用 App Data：**
- `LAST_RESULT` 需要在 Lua VM 销毁后仍然存活
- JS 在 `lua_run` 返回后才读取结果
- 如果存在 app data 中，VM 销毁后数据也会丢失

## 使用模式对比

### ScriptId (App Data)

```rust
// 设置（在 lua_run 中）
let lua = Lua::new();
lua.set_app_data(ScriptId(script_id));

// 读取（在 State API 中）
let script_id = lua.app_data_ref::<ScriptId>()
    .ok_or_else(|| LuaError::external("Script ID not set"))?;

// 使用
let script_id_str = script_id.0.as_str();
```

**特点：**
- 每个 VM 实例独立
- Lua 代码无法访问
- 并发安全

### MediaWikiStack (App Data)

```rust
// 读取或创建
let mut stack = lua.app_data_ref::<MediaWikiStack>()
    .map(|s| s.clone())
    .unwrap_or_default();

// 修改
stack.0.push(base);

// 保存回去
lua.set_app_data(stack);
```

**特点：**
- 使用 Clone-on-Write 模式
- 每次修改都需要 clone 和 set
- 保证每个 VM 的栈独立

### LAST_RESULT (Thread-Local)

```rust
// 设置
LAST_RESULT.with(|cell| {
    *cell.borrow_mut() = Some(cstring);
});

// 清理（JS 调用）
LAST_RESULT.with(|cell| {
    *cell.borrow_mut() = None;
});
```

**特点：**
- 跨 Lua VM 生命周期
- 用于返回值管理
- 需要显式清理

## 类型安全的好处

### 编译时检查

```rust
// ❌ 如果使用错误的类型，编译器会报错
let wrong = lua.app_data_ref::<String>()?;  // 编译错误：找不到 String
let correct = lua.app_data_ref::<ScriptId>()?;  // ✅ 正确

// ❌ 如果混淆类型
lua.set_app_data("some string".to_string());  // 会覆盖 ScriptId！
lua.app_data_ref::<ScriptId>()?;  // None - BUG！

// ✅ 使用 newtype 避免混淆
lua.set_app_data(ScriptId("some string".to_string()));
lua.set_app_data(MediaWikiStack::default());  // 不会冲突
```

### 文档化意图

```rust
// ❌ 不清楚是什么
let data: String = lua.app_data_ref::<String>()?;

// ✅ 清晰表达意图
let script_id: &ScriptId = lua.app_data_ref::<ScriptId>()?;
let stack: &MediaWikiStack = lua.app_data_ref::<MediaWikiStack>()?;
```

## 性能考虑

### Clone 开销

`MediaWikiStack` 使用 Clone-on-Write：

```rust
// 每次修改都需要 clone
let mut stack = lua.app_data_ref::<MediaWikiStack>()
    .map(|s| s.clone())  // ← clone Vec<String>
    .unwrap_or_default();

stack.0.push(base);
lua.set_app_data(stack);
```

**开销分析：**
- `Vec<String>` 的 clone 是 O(n)
- 但嵌套深度通常 < 10
- 每次 require 只 push/pop 一次
- 相比网络请求，开销可忽略

**替代方案：**
```rust
// 如果性能关键，可以使用 Rc<RefCell<_>>
#[derive(Clone)]
struct MediaWikiStack(Rc<RefCell<Vec<String>>>);
```

但当前简单的 Clone 方案已足够：
- 代码更简单
- 更容易理解
- 性能瓶颈在网络 I/O，不在这里

### app_data_ref 开销

```rust
let script_id = lua.app_data_ref::<ScriptId>()?;  // O(1) 查找
```

- mlua 内部使用 `TypeId` 作为 key
- HashMap 查找，O(1)
- 可忽略不计

## 最佳实践

### 1. 为每个 App Data 类型创建 Newtype

```rust
// ✅ Good
#[derive(Clone)]
struct ScriptId(String);

#[derive(Clone)]
struct UserData(HashMap<String, String>);

// ❌ Bad - 容易混淆
lua.set_app_data("script-id".to_string());
lua.set_app_data(user_map);  // 覆盖了 script-id！
```

### 2. 使用描述性的名称

```rust
// ✅ Good
struct ScriptId(String);
struct MediaWikiStack(Vec<String>);

// ❌ Bad
struct Data1(String);
struct Data2(Vec<String>);
```

### 3. 实现必要的 Trait

```rust
#[derive(Clone)]  // 几乎总是需要
struct ScriptId(String);

#[derive(Clone, Default)]  // 如果有默认值
struct MediaWikiStack(Vec<String>);

#[derive(Clone, Debug)]  // 方便调试
struct DebugInfo(String);
```

### 4. 文档化用途

```rust
/// 脚本ID - 用于权限控制和状态隔离
/// 
/// 存储在 Lua VM 的 app_data 中，Lua 代码无法访问。
/// 每个 runLua 调用创建独立的 VM 和 ScriptId。
#[derive(Clone)]
struct ScriptId(String);
```

## 总结

### App Data vs Thread-Local 选择指南

**使用 App Data（存储在 Lua VM）：**
- ✅ 需要每个 runLua 调用独立
- ✅ 需要在 Lua 函数闭包中访问
- ✅ 数据的生命周期与 Lua VM 相同
- 例如：ScriptId, MediaWikiStack

**使用 Thread-Local（跨 VM 共享）：**
- ✅ 需要在 VM 销毁后仍然存活
- ✅ 需要跨多个 runLua 调用共享
- ✅ 用于返回值或全局状态管理
- 例如：LAST_RESULT

### Newtype 的价值

1. **类型安全**：编译器检查，防止混淆
2. **文档化**：代码自解释，易于理解
3. **零开销**：newtype 在运行时没有额外开销
4. **可扩展**：可以为 newtype 添加方法

**结论：总是为 App Data 使用 Newtype！**
