# Namespace 作用域设计分析

## 当前设计的问题

### 问题 1: 顶级 Namespace 容易冲突

```typescript
// 脚本 A 注册
registerNamespaces('script-A', {
  'user.profile': { read: true, write: true }  // ← 顶级是 'user'
})

// 脚本 B 注册（冲突！）
registerNamespaces('script-B', {
  'user.settings': { read: true, write: true }  // ← 也是 'user'
})
```

**问题：**
- 两个脚本都使用 `user.*` 作为顶级命名空间
- 如果不小心，可能会访问到对方的数据
- 命名空间管理变得复杂

### 问题 2: 全局 Namespace 空间

当前设计中，所有脚本共享一个全局的命名空间空间：

```typescript
// 所有脚本的命名空间都在同一个平面上
{
  'script-A': {
    'user.profile': {...},
    'game.state': {...}
  },
  'script-B': {
    'user.settings': {...},  // 可能与 script-A 冲突
    'game.config': {...}     // 可能与 script-A 冲突
  }
}
```

### 问题 3: require 的权限传播不清晰

```lua
-- 脚本 A
local B = require('script-B')

-- 现在脚本 A 执行 B 的代码
B.doSomething()

-- 问题：B.doSomething() 访问状态时使用谁的 scriptId？
-- 问题：B 能访问 A 的命名空间吗？
```

## 提议的新设计：Scoped Namespaces

### 核心思想

**命名空间的作用域仅限于单个 script**

```typescript
// 脚本 A 的命名空间
{
  'script-A': {
    'user.profile': {...},    // 完整路径：script-A/user.profile
    'game.state': {...}       // 完整路径：script-A/game.state
  }
}

// 脚本 B 的命名空间（完全独立）
{
  'script-B': {
    'user.settings': {...},   // 完整路径：script-B/user.settings
    'game.config': {...}      // 完整路径：script-B/game.config
  }
}
```

### 关键规则

#### 规则 1: Script 隔离

每个脚本只能访问自己声明的命名空间：

```typescript
registerNamespaces('script-A', {
  'user.profile': { read: true, write: true }
})

// script-A 只能访问
State.get('user.profile.name')      // ✅ OK
State.get('user.profile.age')       // ✅ OK

// script-A 不能访问 script-B 的命名空间
State.get('other.data')              // ❌ Error: No permission
```

#### 规则 2: require 时的作用域切换

当 A require B 时，执行上下文切换：

```lua
-- 脚本 A 的代码
State.set('user.profile.name', 'Alice')  -- 使用 script-A 的命名空间

local B = require('script-B')

-- 调用 B 的函数
B.doSomething()  
-- ↑ 在 B.doSomething() 内部执行时：
--   - scriptId 仍然是 'script-A'（调用者）
--   - 但是访问的命名空间是从 B 的源文件来的

-- 继续执行 A 的代码
State.set('user.profile.age', 25)  -- 又回到 script-A 的命名空间
```

**问题：** 这个设计有个根本问题！👇

## 问题分析

### 核心困境：静态作用域 vs 动态上下文

你的设计有一个矛盾：

> "只有在执行来自B脚本的代码后，才能访问到B脚本的namespace"

**问题：** 如何判断"来自 B 脚本的代码"？

#### 场景 1: 直接调用

```lua
-- script-A
local B = require('script-B')
B.doSomething()  -- B 的代码，使用 B 的命名空间 ✅
```

这个很清楚。

#### 场景 2: 回调函数

```lua
-- script-B 的代码
function B.registerCallback(callback)
  _G.CALLBACKS = _G.CALLBACKS or {}
  table.insert(_G.CALLBACKS, callback)
end

function B.runCallbacks()
  for _, cb in ipairs(_G.CALLBACKS or {}) do
    cb()  -- ← 这是谁的代码？
  end
end

-- script-A 的代码
local B = require('script-B')

B.registerCallback(function()
  State.set('user.profile.name', 'Alice')
  -- ↑ 这段代码是 A 写的，但在 B.runCallbacks() 中执行
  -- 问题：应该使用 A 的命名空间还是 B 的？
end)

B.runCallbacks()
```

#### 场景 3: 闭包

```lua
-- script-B
function B.makeCounter(namespace)
  local count = 0
  return function()
    count = count + 1
    State.set(namespace .. '.count', count)
    -- ↑ 这是 B 的代码，但 namespace 来自调用者
  end
end

-- script-A
local B = require('script-B')
local counter = B.makeCounter('user.profile')
counter()  -- 应该用 A 的命名空间还是 B 的？
```

### 根本问题

**Lua 的函数没有"来源"信息**

- Lua 函数只是 first-class 值
- 没有办法判断一个函数是在哪个文件中定义的
- 一旦 `require` 返回，所有的函数都只是普通的 Lua 值

**即使有来源信息，也不够**

```lua
-- script-B
function B.helper()
  return function()  -- 匿名函数，来源是 B
    State.set('data', 123)  -- 应该用 B 的命名空间
  end
end

-- script-A
local B = require('script-B')
local fn = B.helper()  -- fn 来自 B
fn()  -- 但是在 A 的上下文中调用，应该用谁的命名空间？
```

## 可行的设计方案

### 方案 1: 基于调用者的 scriptId（当前实现）✅

**原理：** 无论执行什么代码，都使用**调用 runLua 时的 scriptId**

```typescript
// 总是使用调用时的 scriptId
runLua(code, 'script-A')
// ↑ 所有 State API 调用都使用 'script-A' 的权限
```

**优势：**
- ✅ 简单明确
- ✅ 安全（脚本不能伪造身份）
- ✅ 易于理解和实现
- ✅ 符合"谁调用谁负责"的原则

**劣势：**
- ❌ require 的模块无法有自己的状态
- ❌ 无法实现真正的模块化

**示例：**
```lua
-- script-A 调用
runLua([[
  local B = require('script-B')
  B.saveData('test')  -- 使用 script-A 的命名空间
]], 'script-A')
```

### 方案 2: 显式的命名空间参数 ✅ (推荐)

**原理：** 让脚本显式指定要访问的命名空间

```lua
-- script-B 的代码（模块）
local M = {}

function M.saveUserData(scriptId, data)
  -- 显式传入 scriptId，访问调用者的命名空间
  State.set('user.data', data, { namespace = scriptId })
end

function M.saveModuleData(data)
  -- 访问自己的命名空间（需要知道自己的 scriptId）
  local myId = State.getScriptId()  -- 新 API
  State.set('module.cache', data, { namespace = myId })
end

return M

-- script-A 的代码
local B = require('script-B')
B.saveUserData('script-A', {name = 'Alice'})  -- 存到 A 的命名空间
```

**改进的 State API：**
```typescript
interface StateOptions {
  namespace?: string  // 显式指定命名空间作用域
}

State.set(key: string, value: any, options?: StateOptions)
State.get(key: string, default?: any, options?: StateOptions)
```

**优势：**
- ✅ 灵活：可以访问任意有权限的命名空间
- ✅ 明确：代码中清楚地知道访问谁的数据
- ✅ 安全：仍然受权限控制

**劣势：**
- ❌ 需要显式传递 scriptId
- ❌ API 更复杂

### 方案 3: 动态作用域栈 🤔

**原理：** 维护一个 require 栈，跟踪当前执行的模块

```rust
// Rust 端维护一个调用栈
struct RequireContext {
    caller_script_id: String,      // 最初的调用者
    current_module: Option<String>, // 当前执行的模块
}

// 在 Lua VM 的 app data 中存储
#[derive(Clone)]
struct RequireStack(Vec<String>);

// require 时 push
function require(module_name)
  REQUIRE_STACK.push(module_name)
  local result = original_require(module_name)
  REQUIRE_STACK.pop()
  return result
end

// State API 使用栈顶的 scriptId
State.get(key)
  -> 使用 REQUIRE_STACK.top() 的权限
```

**优势：**
- ✅ 自动跟踪执行上下文
- ✅ 符合直觉

**劣势：**
- ❌ 实现复杂
- ❌ 回调/闭包仍然有问题
- ❌ 栈可能错位（如果保存了函数引用）
- ❌ 性能开销

### 方案 4: 命名空间前缀（简单版本）✅ (推荐)

**原理：** 强制命名空间以 scriptId 为前缀

```typescript
// 自动添加前缀
registerNamespaces('script-A', {
  'user.profile': { read: true, write: true }
})

// 内部存储为：
{
  'script-A': {
    'script-A/user.profile': { ... }  // 自动加前缀
  }
}

// State API 自动加前缀
State.set('user.profile.name', 'Alice')
// ↓ 实际访问
State.set('script-A/user.profile.name', 'Alice')
```

**实现：**
```typescript
class NamespaceRegistry {
  private normalizeName(scriptId: string, namespace: string): string {
    // 如果已经有前缀，不重复添加
    if (namespace.startsWith(`${scriptId}/`)) {
      return namespace
    }
    return `${scriptId}/${namespace}`
  }
  
  checkPermission(scriptId: string, key: string, operation: 'read' | 'write') {
    // 1. 尝试匹配脚本自己的命名空间（自动加前缀）
    const prefixedKey = `${scriptId}/${key}`
    // ...
    
    // 2. 尝试匹配共享命名空间
    // ...
  }
}
```

**优势：**
- ✅ 完全隔离，不会冲突
- ✅ 实现简单
- ✅ 对用户透明（自动加前缀）
- ✅ 解决了顶级命名空间冲突问题

**劣势：**
- ❌ 共享命名空间需要特殊处理
- ❌ 调试时看到的 key 更长

## 推荐方案：方案 4 + 方案 2

### 组合设计

**1. 默认隔离（方案 4）**

所有命名空间自动加 scriptId 前缀：

```typescript
registerNamespaces('script-A', {
  'user.profile': { ... }
})

// 内部：script-A/user.profile

State.set('user.profile.name', 'Alice')
// 实际访问：script-A/user.profile.name
```

**2. 显式共享**

需要共享的命名空间显式声明：

```typescript
registerNamespaces('script-A', {
  'user.profile': { read: true, write: true, shared: false },
  'shared.events': { read: true, write: true, shared: true }  // 共享
})

// shared.events 不加前缀，所有脚本都能访问
```

**3. 显式跨脚本访问（可选）**

如果需要访问其他脚本的数据：

```lua
-- 访问自己的命名空间（默认）
State.set('user.profile.name', 'Alice')

-- 显式访问其他脚本的共享命名空间
State.get('shared.events', nil, { namespace = 'global' })

-- 或者访问特定脚本的共享数据（如果有权限）
State.get('user.profile.name', nil, { namespace = 'script-B' })
```

### 实现要点

```typescript
interface NamespaceConfig {
  read: boolean
  write: boolean
  shared: boolean      // true = 全局共享，不加前缀
  crossScript?: string[] // 允许哪些脚本访问（如果 shared=false）
  persistent: boolean
  ttl?: number
  quota?: number
}

class NamespaceRegistry {
  private resolveKey(scriptId: string, key: string, options?: { namespace?: string }): string {
    // 1. 如果显式指定了 namespace
    if (options?.namespace) {
      if (options.namespace === 'global') {
        return key  // 不加前缀
      }
      return `${options.namespace}/${key}`
    }
    
    // 2. 检查是否是共享命名空间
    const config = this.getConfig(scriptId, key)
    if (config?.shared) {
      return key  // 共享命名空间不加前缀
    }
    
    // 3. 默认加脚本前缀
    return `${scriptId}/${key}`
  }
}
```

## require 场景下的行为

### 场景 1: 模块有自己的状态

```lua
-- script-B (模块)
local M = {}
local cache = {}

function M.getData(id)
  if not cache[id] then
    -- 访问 script-B 的命名空间
    cache[id] = State.get('module.cache.' .. id)
  end
  return cache[id]
end

return M

-- script-A
local B = require('script-B')
local data = B.getData('user-123')
-- ↑ B.getData 内部访问 'module.cache.user-123'
-- → 实际访问 'script-A/module.cache.user-123'
-- 问题：这不是我们想要的！我们希望访问 B 的缓存
```

**解决方案：** 模块声明自己的共享缓存

```typescript
// script-B 注册时
registerNamespaces('script-B', {
  'module.cache': { read: true, write: true, shared: true }
  // shared: true → 不加前缀，所有脚本都能访问
})
```

或者使用私有命名空间：

```lua
-- script-B
function M.getData(id)
  -- 使用 script.{scriptId} 私有命名空间
  local key = 'script.script-B.cache.' .. id
  cache[id] = State.get(key)
end
```

### 场景 2: 模块操作调用者的数据

```lua
-- script-B (工具模块)
local M = {}

function M.saveUserProfile(data)
  -- 希望保存到调用者的命名空间
  State.set('user.profile', data)
  -- → 实际访问 'script-A/user.profile'（调用者）
  -- ✅ 正确！
end

return M

-- script-A
local B = require('script-B')
B.saveUserProfile({name = 'Alice'})
-- ✅ 保存到 script-A/user.profile
```

**这种情况下，当前设计就是正确的！**

## 结论

### 你的设计合理吗？

**部分合理，但需要调整**

你的核心思想是对的：
- ✅ 命名空间应该隔离
- ✅ 避免顶级命名空间冲突

但具体实现需要调整：
- ❌ "只有在执行 B 的代码时才能访问 B 的命名空间" → 技术上不可行
- ✅ 应该改为：**默认使用调用者的命名空间，模块通过共享命名空间或私有命名空间管理自己的状态**

### 推荐的最终设计

**1. 自动前缀隔离**
```typescript
State.set('user.profile.name', 'Alice')
// → 实际访问：{scriptId}/user.profile.name
```

**2. 共享命名空间**
```typescript
registerNamespaces('script-A', {
  'global.events': { shared: true }  // 所有脚本都能访问
})
```

**3. 私有命名空间**
```typescript
// 自动创建：script.{scriptId}.*
State.set('script.script-A.cache', data)
```

**4. 模块模式**
```lua
-- 模块应该：
-- a) 使用共享命名空间存储自己的状态
-- b) 或者使用 script.{scriptId} 私有命名空间
-- c) 操作调用者数据时，使用调用者的命名空间（默认行为）
```

### 这样设计的好处

- ✅ 完全隔离：scriptId 前缀保证不冲突
- ✅ 灵活：支持共享命名空间
- ✅ 简单：对用户透明
- ✅ 安全：权限控制仍然有效
- ✅ 符合直觉：模块操作调用者数据（类似传统的函数调用）

你觉得这个方案如何？我可以开始实现吗？
