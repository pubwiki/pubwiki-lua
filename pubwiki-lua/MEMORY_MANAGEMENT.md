# 内存管理 - 避免共享可变状态

## 问题：Thread-Local 导致的潜在竞态条件

### 之前的设计

```rust
thread_local! {
    static LAST_RESULT: RefCell<Option<CString>> = RefCell::new(None);
}

fn set_last_result(s: String) -> *const c_char {
    let c = CString::new(s).unwrap();
    let ptr = c.as_ptr();
    
    // 存储在 thread-local 中
    LAST_RESULT.with(|cell| {
        *cell.borrow_mut() = Some(c);  // ← 覆盖之前的结果！
    });
    
    ptr
}

#[no_mangle]
pub extern "C" fn lua_run(...) -> *const c_char {
    // ... 执行 Lua 代码 ...
    set_last_result(final_output)
}

#[no_mangle]
pub extern "C" fn lua_free_last(ptr: *const c_char) {
    LAST_RESULT.with(|cell| {
        let mut guard = cell.borrow_mut();
        if let Some(cstr) = guard.as_ref() {
            if cstr.as_ptr() == ptr {
                *guard = None;
            }
        }
    });
}
```

### 问题场景

虽然 JavaScript 是单线程的，但这个设计存在问题：

#### 1. 依赖单线程假设

```typescript
// JavaScript 事件循环中
Promise.all([
  runLua('return "A"', 'script-A'),  
  runLua('return "B"', 'script-B'),
])
```

**执行顺序（JS 单线程）：**
```
1. 调用 runLua A
2. _lua_run(A) 执行
3. 设置 LAST_RESULT = "A"
4. 返回 ptrA
5. JS 读取 ptrA
6. JS 调用 _lua_free_last(ptrA)
7. 清空 LAST_RESULT
8. 调用 runLua B
9. _lua_run(B) 执行
10. 设置 LAST_RESULT = "B"
11. 返回 ptrB
12. JS 读取 ptrB
13. JS 调用 _lua_free_last(ptrB)
14. 清空 LAST_RESULT
```

**看起来安全**，因为 JS 是单线程的，每个调用都会完整执行。

#### 2. 但这不够健壮

**问题 1: 未来可能引入多线程**
- Web Workers
- SharedArrayBuffer + Atomics
- WASM 线程

**问题 2: 代码不够清晰**
- 依赖全局可变状态
- 生命周期管理复杂
- 需要配对的 `_lua_run` 和 `_lua_free_last`

**问题 3: 错误处理复杂**
```rust
if let Err(e) = install_print_collector(&lua, &output) {
    return set_last_result(format!("error: {}", e));
}

if let Err(e) = install_io_write_collector(&lua, &output) {
    return set_last_result(format!("error: {}", e));
    // ← 如果这里 early return，LAST_RESULT 会被覆盖
}
```

## 新的设计：直接分配内存

### Rust 端

```rust
#[no_mangle]
pub extern "C" fn lua_run(code_ptr: *const c_char, script_id_ptr: *const c_char) -> *const c_char {
    // 辅助函数：创建错误结果
    let make_error = |msg: String| -> *const c_char {
        CString::new(format!("error: {}", msg))
            .unwrap_or_else(|_| CString::new("error: <invalid utf8>").unwrap())
            .into_raw()  // ← 转移所有权
    };
    
    // ... 执行 Lua 代码 ...
    
    // 分配新的 CString 并转移所有权给 JS
    CString::new(final_output)
        .unwrap_or_else(|_| CString::new("<invalid utf8>").unwrap())
        .into_raw()  // ← 每次调用都分配新内存
}

/// 释放由 lua_run 返回的结果字符串
/// 必须由 JS 调用以释放内存
#[no_mangle]
pub extern "C" fn lua_free_result(ptr: *const c_char) {
    if !ptr.is_null() {
        unsafe {
            // 从原始指针恢复 CString，Drop 时自动释放内存
            let _ = CString::from_raw(ptr as *mut c_char);
        }
    }
}
```

### TypeScript 端

```typescript
export async function runLua(code: string, scriptId: string): Promise<string> {
  await loadRunner()
  const module = ensureModule()
  
  // 编码输入
  const codePtr = allocateCString(code, module)
  const scriptIdPtr = allocateCString(scriptId, module)
  
  // 调用 WASM
  const resultPtr = module._lua_run(codePtr, scriptIdPtr)
  
  let output = ''
  if (resultPtr) {
    output = readCString(resultPtr, module)
    
    // ✅ 释放 Rust 分配的内存
    module._lua_free_result(resultPtr)
  }
  
  // 释放输入内存
  module._free(codePtr)
  module._free(scriptIdPtr)
  
  return output
}
```

## 对比

### 内存所有权

| 方案 | 内存所有权 | 生命周期 |
|------|-----------|---------|
| Thread-Local | Rust 持有 | 下次调用前 |
| Direct Allocation | JS 负责释放 | 显式管理 |

### Thread-Local 方案

```
调用 1: 
  Rust 分配 CString A → 存储在 LAST_RESULT
                     ↓
                  返回 ptr A
                     ↓
         JS 读取 ptr A → 调用 lua_free_last
                     ↓
               清空 LAST_RESULT
                     
调用 2:
  Rust 分配 CString B → 存储在 LAST_RESULT（覆盖）
                     ↓
                  返回 ptr B
```

**问题：**
- 共享全局状态
- 如果 JS 忘记调用 `lua_free_last`，会内存泄漏
- 如果 JS 调用两次 `lua_free_last`，会 panic

### Direct Allocation 方案

```
调用 1:
  Rust 分配 CString A → 转移所有权
                     ↓
                  返回 ptr A
                     ↓
         JS 读取 ptr A → 调用 lua_free_result(A)
                     ↓
               释放 CString A
                     
调用 2:
  Rust 分配 CString B → 转移所有权
                     ↓
                  返回 ptr B
                     ↓
         JS 读取 ptr B → 调用 lua_free_result(B)
                     ↓
               释放 CString B
```

**优势：**
- 无共享状态
- 每个调用独立
- 所有权清晰

## 并发安全性

### Thread-Local 方案（理论风险）

假设未来引入 Web Workers：

```typescript
// Worker 1
runLua('return "A"', 'script-A')
// ↓ 设置 LAST_RESULT = "A"

// Worker 2（同时执行）
runLua('return "B"', 'script-B')
// ↓ 覆盖 LAST_RESULT = "B"

// Worker 1 读取结果
// ↓ 读取到 "B"！❌ BUG
```

**注意：** 实际上 WASM 实例在不同 Worker 中是独立的，所以 thread-local 也是独立的。但这种设计仍然不够清晰。

### Direct Allocation 方案（完全安全）

```typescript
// Worker 1
const ptrA = _lua_run(...)  // 分配内存 A
readCString(ptrA)           // 读取 A
_lua_free_result(ptrA)      // 释放 A

// Worker 2（同时执行）
const ptrB = _lua_run(...)  // 分配内存 B（独立）
readCString(ptrB)           // 读取 B
_lua_free_result(ptrB)      // 释放 B
```

**优势：**
- 完全独立
- 无共享状态
- 天然线程安全

## 性能考虑

### 内存分配开销

**Thread-Local:**
```rust
// 每次调用都需要分配
let c = CString::new(s).unwrap();

// 但需要额外的 RefCell 和 Option 包装
thread_local! {
    static LAST_RESULT: RefCell<Option<CString>> = ...;
}
```

**Direct Allocation:**
```rust
// 每次调用分配
CString::new(s).unwrap().into_raw()

// 无额外包装
```

**结论：** 性能几乎相同，Direct Allocation 甚至可能更快（无 RefCell 开销）。

### 内存泄漏风险

**Thread-Local:**
- 如果 JS 忘记调用 `lua_free_last`，内存会在下次调用时释放
- 最多泄漏一个结果的内存

**Direct Allocation:**
- 如果 JS 忘记调用 `lua_free_result`，内存会永久泄漏
- 需要确保总是调用 `lua_free_result`

**缓解措施：**
```typescript
export async function runLua(code: string, scriptId: string): Promise<string> {
  const module = ensureModule()
  const codePtr = allocateCString(code, module)
  const scriptIdPtr = allocateCString(scriptId, module)
  
  try {
    const resultPtr = module._lua_run(codePtr, scriptIdPtr)
    
    try {
      if (resultPtr) {
        return readCString(resultPtr, module)
      }
      return ''
    } finally {
      // ✅ 确保总是释放结果内存
      if (resultPtr) {
        module._lua_free_result(resultPtr)
      }
    }
  } finally {
    // ✅ 确保总是释放输入内存
    module._free(codePtr)
    module._free(scriptIdPtr)
  }
}
```

## API 对比

### 旧 API

```rust
pub extern "C" fn lua_run(...) -> *const c_char;
pub extern "C" fn lua_free_last(ptr: *const c_char);
```

### 新 API

```rust
pub extern "C" fn lua_run(...) -> *const c_char;
pub extern "C" fn lua_free_result(ptr: *const c_char);
```

**变更：**
- `lua_free_last` → `lua_free_result`（名称更清晰）
- 语义从"释放最后的结果"变为"释放指定的结果"

## 最佳实践

### 1. 总是配对分配和释放

```typescript
const ptr = module._lua_run(...)
try {
  // 使用 ptr
} finally {
  module._lua_free_result(ptr)  // ✅ 确保释放
}
```

### 2. 封装资源管理

```typescript
class ManagedCString {
  ptr: number
  module: LuaModule
  
  constructor(ptr: number, module: LuaModule) {
    this.ptr = ptr
    this.module = module
  }
  
  read(): string {
    return readCString(this.ptr, this.module)
  }
  
  free() {
    this.module._lua_free_result(this.ptr)
  }
}

// 使用
const result = new ManagedCString(module._lua_run(...), module)
try {
  return result.read()
} finally {
  result.free()
}
```

### 3. 使用 RAII 模式

虽然 JavaScript 没有析构函数，但可以用 `try-finally`：

```typescript
function withCString<T>(
  ptr: number,
  module: LuaModule,
  fn: (s: string) => T
): T {
  try {
    const str = readCString(ptr, module)
    return fn(str)
  } finally {
    module._lua_free_result(ptr)
  }
}

// 使用
return withCString(
  module._lua_run(...),
  module,
  (output) => processOutput(output)
)
```

## 迁移指南

### 1. 更新 Rust 代码

```rust
// 删除
thread_local! {
    static LAST_RESULT: RefCell<Option<CString>> = ...;
}

fn set_last_result(s: String) -> *const c_char { ... }

pub extern "C" fn lua_free_last(ptr: *const c_char) { ... }

// 添加
pub extern "C" fn lua_run(...) -> *const c_char {
    CString::new(result).unwrap().into_raw()
}

pub extern "C" fn lua_free_result(ptr: *const c_char) {
    unsafe { CString::from_raw(ptr as *mut c_char); }
}
```

### 2. 更新 TypeScript 接口

```typescript
interface LuaModule {
  _lua_run(...): number
  _lua_free_result(ptr: number): void  // 改名
}
```

### 3. 更新调用代码

```typescript
// 旧代码
const resultPtr = module._lua_run(...)
output = readCString(resultPtr, module)
module._lua_free_last(resultPtr)

// 新代码
const resultPtr = module._lua_run(...)
output = readCString(resultPtr, module)
module._lua_free_result(resultPtr)  // 改名
```

### 4. 重新编译 WASM

```bash
cd runner
cargo build --release --target wasm32-unknown-emscripten
cp target/wasm32-unknown-emscripten/release/lua_runner_wasm.* ../pubwiki-lua/wasm/
```

## 总结

### 变更前（Thread-Local）
- ❌ 共享全局可变状态
- ❌ 依赖单线程假设
- ❌ 生命周期管理复杂
- ✅ 自动清理（某种程度）

### 变更后（Direct Allocation）
- ✅ 无共享状态
- ✅ 完全并发安全
- ✅ 所有权清晰
- ✅ 更简单的 Rust 代码
- ⚠️ 需要显式释放（但有 try-finally 保护）

**推荐：使用 Direct Allocation 方案**

这是更现代、更健壮的 FFI 内存管理方式，符合 Rust 的所有权原则，也更容易理解和维护。
