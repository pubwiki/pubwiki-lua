# 命名空间状态管理系统

用户自定义命名空间的持久化状态管理系统，基于 IndexedDB，支持细粒度权限控制。

## 🌟 特性

- **✅ 用户自定义命名空间**：脚本可以声明任意命名空间结构
- **✅ 细粒度权限控制**：每个命名空间独立配置 read/write/shared/persistent
- **✅ IndexedDB 持久化**：数据保存在浏览器本地，刷新不丢失
- **✅ 内存缓存加速**：热点数据缓存，减少数据库访问
- **✅ 临时存储**：支持非持久化的临时数据（`temp.*` 命名空间）
- **✅ 过期时间（TTL）**：支持设置数据自动过期时间
- **✅ 状态监听**：响应式数据变化通知
- **✅ 安全隔离**：脚本间数据隔离，系统保留命名空间保护

## 📦 安装

```bash
npm install pubwiki-lua
```

## 🚀 快速开始

### 1. TypeScript/JavaScript 端

```typescript
import {
  loadRunner,
  registerFileModule,
  registerNamespaces,
  getState,
  setState,
  runLua
} from 'pubwiki-lua'

// 加载 Lua 运行时
await loadRunner()

// 注册 state.lua 模块
const stateLuaCode = await fetch('/path/to/state.lua').then(r => r.text())
registerFileModule('state.lua', stateLuaCode)

// 注册脚本的命名空间配置
registerNamespaces('myScript_v1', {
  'myApp.player': {
    read: true,
    write: true,
    shared: false,
    persistent: true
  },
  'events.global': {
    read: true,
    write: true,
    shared: true,  // 其他脚本也可访问
    persistent: true,
    ttl: 60000  // 60秒后自动过期
  }
})

// 运行 Lua 脚本
const output = await runLua(`
  local State = require("file://state.lua")
  _G.__SCRIPT_ID = "myScript_v1"
  
  State.async(function()
    local level = State.get("myApp.player.level", 1)
    print("Level:", level)
    State.set("myApp.player.level", level + 1)
  end)
`)
```

### 2. Lua 端

```lua
local State = require("file://state.lua")

-- 设置当前脚本 ID
_G.__SCRIPT_ID = "myScript_v1"

-- 注册命名空间配置
State.register("myScript_v1", {
  ["myApp.player"] = {
    read = true,
    write = true,
    shared = false,
    persistent = true
  },
  ["myApp.inventory"] = {
    read = true,
    write = true,
    shared = false,
    persistent = true
  },
  ["events.boss"] = {
    read = true,
    write = true,
    shared = true,       -- 共享给其他脚本
    persistent = true,
    ttl = 3600000        -- 1小时后过期
  }
})

-- 在协程中使用状态管理
State.async(function()
  -- 读取状态（带默认值）
  local level = State.get("myApp.player.level", 1)
  print("当前等级:", level)
  
  -- 写入状态
  State.set("myApp.player.level", level + 1)
  State.set("myApp.player.name", "Hero")
  
  -- 写入复杂数据
  State.set("myApp.inventory.items", {
    {name = "剑", damage = 50},
    {name = "盾", defense = 30}
  })
  
  -- 使用临时存储（非持久化）
  State.set("temp.cache", {key = "value"})
  
  -- 设置带过期时间的数据
  State.set("events.boss.defeated", true, {ttl = 10000})  -- 10秒后过期
  
  -- 列出所有匹配的 key
  local keys = State.list("myApp.player")
  for _, key in ipairs(keys) do
    print("Key:", key)
  end
  
  -- 监听状态变化
  local unwatch = State.watch("events.boss.defeated", function(value)
    print("Boss状态变化:", value)
  end)
  
  -- 取消监听
  -- unwatch()
end)
```

## 📖 API 文档

### TypeScript API

#### `registerNamespaces(scriptId, config)`

注册脚本的命名空间配置。

**参数：**
- `scriptId` (string): 脚本唯一标识符
- `config` (ScriptNamespaceConfig): 命名空间配置对象

**配置选项：**
```typescript
{
  "namespace.path": {
    read: boolean      // 是否可读
    write: boolean     // 是否可写
    shared: boolean    // 是否跨脚本共享
    persistent: boolean // 是否持久化到 IndexedDB
    ttl?: number       // 可选：过期时间（毫秒）
    quota?: number     // 可选：存储配额（字节）
  }
}
```

#### `getState(scriptId, key, defaultValue?)`

获取状态值。

**返回：** `Promise<unknown>`

#### `setState(scriptId, key, value, options?)`

设置状态值。

**选项：**
- `ttl?: number` - 覆盖配置中的 TTL

#### `deleteState(scriptId, key)`

删除状态值。

#### `listKeys(scriptId, prefix)`

列出匹配前缀的所有 key。

**返回：** `Promise<string[]>`

#### `watchState(scriptId, key, callback)`

监听状态变化。

**返回：** 取消监听的函数 `() => void`

#### `cleanupExpiredState()`

清理过期数据。

**返回：** `Promise<number>` - 清理的条数

#### `clearAllState()`

清空所有状态数据。

### Lua API

#### `State.register(scriptId, config)`

注册命名空间配置。必须在使用其他 API 前调用。

#### `State.get(key, default?)`

获取状态值。必须在协程中调用。

#### `State.set(key, value, options?)`

设置状态值。必须在协程中调用。

**选项：**
```lua
{
  ttl = 毫秒数  -- 过期时间
}
```

#### `State.delete(key)`

删除状态值。必须在协程中调用。

#### `State.list(prefix)`

列出匹配前缀的所有 key。必须在协程中调用。

**返回：** `table` - key 数组

#### `State.watch(key, callback)`

监听状态变化。

**返回：** 取消监听的函数

**示例：**
```lua
local unwatch = State.watch("events.boss", function(value)
  print("Value changed:", value)
end)

-- 取消监听
unwatch()
```

#### `State.listNamespaces()`

列出当前脚本可访问的所有命名空间。

**返回：** `table` - 命名空间数组

#### `State.async(fn, ...)`

便利函数，自动创建协程并捕获错误。

**示例：**
```lua
State.async(function()
  local value = State.get("key", "default")
  print(value)
end)
```

## 🎯 命名空间规则

### 系统保留命名空间

以下命名空间由系统保留，脚本不可使用：
- `system.*` - 系统内部使用
- `_internal.*` - 内部实现

### 自动命名空间

以下命名空间自动可用，无需声明：

#### `script.{scriptId}.*`
每个脚本自动拥有的私有命名空间。

**示例：**
```lua
State.set("script.myScript.data", "private data")
```

#### `temp.*`
临时存储，非持久化，刷新页面后清空。

**示例：**
```lua
State.set("temp.cache", {key = "value"})
```

### 用户自定义命名空间

用户可以定义任意命名空间，只要：
1. 至少包含一个点（`.`）
2. 只包含字母、数字、下划线和点
3. 不与系统保留命名空间冲突

## 🔒 权限模型

### 私有命名空间（shared: false）

只有声明该命名空间的脚本可以访问。

```typescript
{
  "myApp.player": {
    read: true,
    write: true,
    shared: false  // 私有
  }
}
```

### 共享命名空间（shared: true）

所有脚本都可以访问（需要声明）。

```typescript
// 脚本 A 声明并写入
{
  "events.global": {
    read: true,
    write: true,
    shared: true  // 共享
  }
}

// 脚本 B 可以读取
State.get("events.global.message")
```

### 只读命名空间（write: false）

可以读取但不能写入。

```typescript
{
  "config.settings": {
    read: true,
    write: false  // 只读
  }
}
```

## ⏰ 过期时间（TTL）

### 在配置中设置全局 TTL

```typescript
registerNamespaces('script1', {
  'temp.data': {
    read: true,
    write: true,
    shared: false,
    persistent: true,
    ttl: 60000  // 60秒后自动过期
  }
})
```

### 在写入时覆盖 TTL

```lua
-- 覆盖配置中的 TTL
State.set("temp.data.key", "value", {ttl = 10000})  -- 10秒
```

### 自动清理

```typescript
// 手动触发清理
const count = await cleanupExpiredState()
console.log(`清理了 ${count} 条过期数据`)
```

## 💡 最佳实践

### 1. 命名空间设计

```lua
-- ✅ 推荐：清晰的层级结构
"myGame.player.stats"
"myGame.player.inventory"
"myGame.world.events"

-- ❌ 避免：过于扁平
"playerStats"
"playerInventory"
```

### 2. 权限最小化

```lua
-- ✅ 只读取不写入的数据设置为只读
{
  ["config.settings"] = {
    read = true,
    write = false  -- 只读
  }
}
```

### 3. 使用临时存储缓存

```lua
-- ✅ 临时缓存使用 temp.* 命名空间
State.set("temp.cache.result", expensiveComputation())
```

### 4. 设置合理的 TTL

```lua
-- ✅ 短期事件设置过期时间
State.set("events.flash_sale", true, {ttl = 3600000})  -- 1小时
```

## 🎮 完整示例

查看 `example/state-demo.html` 获取完整的交互式示例。

## 📝 许可证

MIT
