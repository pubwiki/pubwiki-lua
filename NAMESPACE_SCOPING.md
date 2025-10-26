# 命名空间作用域与隔离机制

## 概述

从 v1.0.0 开始，pubwiki-lua 实现了自动命名空间隔离机制，防止不同脚本之间的命名空间冲突。

## 问题背景

在之前的设计中，不同脚本的顶级命名空间很容易发生冲突：

```typescript
// Script A
registerNamespaces('script-A', {
  'user.profile': { permissions: { read: true, write: true } }
})

// Script B  
registerNamespaces('script-B', {
  'user.settings': { permissions: { read: true, write: true } }
})

// 问题：两个脚本都使用了 'user' 作为顶级命名空间
// 可能导致意外的数据访问或覆盖
```

## 解决方案：自动前缀机制

系统现在会自动为非共享命名空间添加 `scriptId` 前缀：

```typescript
// 用户写：
State.set('user.profile', { name: 'Alice' })

// 实际存储为：
'script-A/user.profile'

// 不同脚本的数据完全隔离
```

## 命名空间类型

### 1. 私有命名空间（默认）

**行为**：自动添加 scriptId 前缀，完全隔离

```typescript
registerNamespaces('script-A', {
  'user.profile': {
    permissions: { read: true, write: true }
    // shared: false (默认值)
  }
})

// Script A 中：
State.set('user.profile', { name: 'Alice' })
// 存储为：'script-A/user.profile'

// Script B 中：
State.set('user.profile', { name: 'Bob' })
// 存储为：'script-B/user.profile'

// 两个脚本的数据互不影响
```

> **注意**：私有命名空间提供了完全的数据隔离。即使两个脚本注册了完全相同的命名空间名称，它们的数据也不会冲突，因为系统会自动添加不同的 scriptId 前缀。

### 2. 共享命名空间

**行为**：不添加前缀，所有脚本都可以访问（需要相应权限）

```typescript
registerNamespaces('script-A', {
  'global.events': {
    shared: true,  // 标记为共享
    permissions: { read: true, write: true }
  }
})

registerNamespaces('script-B', {
  'global.events': {
    shared: true,
    permissions: { read: true, write: false }  // 只读
  }
})

// Script A 中：
State.set('global.events', { lastEvent: 'login' })
// 存储为：'global.events'（无前缀）

// Script B 中：
const events = State.get('global.events')
// 可以读取 Script A 写入的数据
```

## API 说明

### normalizeNamespace (内部方法)

自动添加 scriptId 前缀（如果不是共享命名空间）：

```typescript
private normalizeNamespace(
  scriptId: string,
  namespace: string,
  isShared: boolean
): string {
  if (isShared) {
    return namespace  // 共享命名空间不加前缀
  }
  return `${scriptId}/${namespace}`  // 私有命名空间加前缀
}
```

### denormalizeNamespace (内部方法)

移除 scriptId 前缀，用于向用户显示：

```typescript
private denormalizeNamespace(
  scriptId: string,
  normalizedNamespace: string
): string {
  const prefix = `${scriptId}/`
  if (normalizedNamespace.startsWith(prefix)) {
    return normalizedNamespace.slice(prefix.length)
  }
  return normalizedNamespace
}
```

### resolveKey (公开方法)

将用户提供的 key 转换为完整的存储 key：

```typescript
resolveKey(scriptId: string, key: string): string {
  // 1. 查找匹配的命名空间配置
  const ns = this.findMatchingNamespace(scriptId, key)
  
  // 2. 获取完整的存储 key（带前缀）
  const fullKey = ns.fullKey + key.slice(ns.namespace.length)
  
  return fullKey
}
```

### State API 自动处理

所有 State API 方法都会自动使用 `resolveKey` 进行转换：

```typescript
// State.get
async get(scriptId: string, key: string, defaultValue?: any): Promise<any> {
  const fullKey = this.registry.resolveKey(scriptId, key)
  // 使用 fullKey 访问存储
}

// State.set
async set(scriptId: string, key: string, value: any, ttl?: number): Promise<void> {
  const fullKey = this.registry.resolveKey(scriptId, key)
  // 使用 fullKey 写入存储
}

// State.delete
async delete(scriptId: string, key: string): Promise<void> {
  const fullKey = this.registry.resolveKey(scriptId, key)
  // 使用 fullKey 删除数据
}

// State.list
async list(scriptId: string, prefix: string): Promise<Record<string, any>> {
  const fullPrefix = this.registry.resolveKey(scriptId, prefix)
  // 使用 fullPrefix 列出数据
}
```

## 使用示例

### 示例 1：完全隔离的用户数据

```typescript
// 初始化
import { registerNamespaces, runLua } from 'pubwiki-lua'

// Script A 注册命名空间
registerNamespaces('script-A', {
  'user.profile': {
    permissions: { read: true, write: true, delete: false }
  }
})

// Script B 注册同名命名空间
registerNamespaces('script-B', {
  'user.profile': {
    permissions: { read: true, write: true, delete: false }
  }
})

// Script A 写入数据
await runLua('script-A', `
  State.set('user.profile', { name = 'Alice', level = 10 })
`)
// 实际存储：'script-A/user.profile'

// Script B 写入数据
await runLua('script-B', `
  State.set('user.profile', { name = 'Bob', level = 5 })
`)
// 实际存储：'script-B/user.profile'

// Script A 读取数据
await runLua('script-A', `
  local data = State.get('user.profile')
  print(data.name)  -- 输出：Alice
`)

// Script B 读取数据
await runLua('script-B', `
  local data = State.get('user.profile')
  print(data.name)  -- 输出：Bob
`)
```

### 示例 2：共享全局事件

```typescript
// Script A：发布全局事件
registerNamespaces('script-A', {
  'global.events': {
    shared: true,
    permissions: { read: true, write: true, delete: false }
  }
})

await runLua('script-A', `
  State.set('global.events', {
    type = 'boss_defeated',
    bossName = '炎龙',
    timestamp = 1234567890
  })
`)
// 存储为：'global.events'（无前缀）

// Script B：订阅全局事件
registerNamespaces('script-B', {
  'global.events': {
    shared: true,
    permissions: { read: true, write: false, delete: false }  // 只读
  }
})

await runLua('script-B', `
  local event = State.get('global.events')
  if event.type == 'boss_defeated' then
    print('恭喜击败Boss：' .. event.bossName)
  end
`)
// 输出：恭喜击败Boss：炎龙
```

### 示例 3：私有配置数据

```typescript
// Script A 的私有配置（自动隔离）
registerNamespaces('script-A', {
  'config.api': {
    permissions: { read: true, write: true, delete: true }
  }
})

await runLua('script-A', `
  State.set('config.api', {
    apiKey = 'secret_key_123',
    apiEndpoint = 'https://api.example.com'
  })
`)
// 存储为：'script-A/config.api'

// Script B 有自己的配置（自动隔离）
registerNamespaces('script-B', {
  'config.api': {
    permissions: { read: true, write: true, delete: true }
  }
})

await runLua('script-B', `
  State.set('config.api', {
    apiKey = 'different_key_456',
    apiEndpoint = 'https://different-api.example.com'
  })
`)
// 存储为：'script-B/config.api'

// Script B 读取配置（只能读到自己的）
await runLua('script-B', `
  local config = State.get('config.api')
  print(config.apiKey)  -- 输出：different_key_456
`)
```

## 最佳实践

### 1. 命名空间命名规范

```typescript
// ✓ 推荐：使用有意义的顶级命名空间
'user.profile'
'game.settings'
'quest.progress'

// ✗ 避免：使用脚本 ID 作为顶级命名空间
'script-A.user.profile'  // 系统会自动添加前缀，无需手动
```

### 2. 共享数据设计

```typescript
// ✓ 推荐：明确的共享命名空间
'global.events'        // 全局事件
'global.config'        // 全局配置
'shared.resources'     // 共享资源

// ✗ 避免：滥用共享命名空间
'user.profile' (shared: true)  // 用户数据不应共享
```

### 3. 权限最小化原则

```typescript
// ✓ 推荐：只授予必要的权限
registerNamespaces('script-B', {
  'global.events': {
    shared: true,
    permissions: { read: true, write: false, delete: false }
  }
})

// ✗ 避免：授予过多权限
registerNamespaces('script-B', {
  'global.events': {
    shared: true,
    permissions: { read: true, write: true, delete: true }
  }
})
```

## 迁移指南

### 从旧版本升级

如果你的代码使用了旧版本（无自动前缀），需要注意：

**旧代码（v0.x）**：
```typescript
registerNamespaces('script-A', {
  'user.profile': { /* ... */ }
})
// 存储为：'user.profile'
```

**新代码（v1.x）**：
```typescript
registerNamespaces('script-A', {
  'user.profile': { /* ... */ }
})
// 存储为：'script-A/user.profile'（自动前缀）

// 如果需要保持旧的共享行为：
registerNamespaces('script-A', {
  'user.profile': { 
    shared: true,  // 添加 shared: true
    /* ... */
  }
})
// 存储为：'user.profile'（无前缀）
```

### 数据迁移

如果需要迁移旧数据，可以使用以下方法：

```typescript
import { getAllStateRecords, State } from 'pubwiki-lua'

// 1. 读取所有旧数据
const oldRecords = await getAllStateRecords()

// 2. 重新注册命名空间（带前缀）
registerNamespaces('script-A', {
  'user.profile': { /* ... */ }
})

// 3. 迁移数据
for (const record of oldRecords) {
  if (record.fullKey.startsWith('user.profile')) {
    // 写入新的命名空间
    await State.set('script-A', record.fullKey, record.value)
  }
}

// 4. 删除旧数据（可选）
// await State.delete('script-A', 'user.profile')
```

## 技术细节

### 存储键格式

```
私有命名空间：{scriptId}/{namespace}.{key}
共享命名空间：{namespace}.{key}
```

**示例**：

| 用户输入 | scriptId | shared | 实际存储键 |
|---------|----------|--------|----------|
| `user.profile` | `script-A` | false | `script-A/user.profile` |
| `user.profile` | `script-B` | false | `script-B/user.profile` |
| `global.events` | `script-A` | true | `global.events` |
| `global.events` | `script-B` | true | `global.events` |

### 权限检查顺序

1. **命名空间匹配**：
   - 使用前缀匹配找到对应的命名空间配置
   - 如果找不到匹配的命名空间，抛出权限错误

2. **权限验证**：
   - 检查操作类型（read/write/delete）
   - 验证是否有相应权限

3. **键转换**：
   - 调用 `resolveKey` 获取完整存储键
   - 如果是共享命名空间，不添加前缀
   - 如果是私有命名空间，添加 scriptId 前缀

## 常见问题

### Q1: 为什么需要自动前缀？

**A**: 防止不同脚本间的命名空间冲突。多个脚本可能使用相同的顶级命名空间（如 `user.*`），自动前缀确保它们的数据完全隔离。

### Q2: 如何查看实际的存储键？

**A**: 使用 `getAllStateRecords()` 查看所有数据：

```typescript
import { getAllStateRecords } from 'pubwiki-lua'

const records = await getAllStateRecords()
console.log(records)
// [
//   { fullKey: 'script-A/user.profile', value: {...} },
//   { fullKey: 'script-B/user.profile', value: {...} },
//   { fullKey: 'global.events', value: {...} }
// ]
```

### Q3: 共享命名空间的权限如何管理？

**A**: 每个脚本独立配置共享命名空间的权限：

```typescript
// Script A：可读写
registerNamespaces('script-A', {
  'global.events': {
    shared: true,
    permissions: { read: true, write: true, delete: false }
  }
})

// Script B：只读
registerNamespaces('script-B', {
  'global.events': {
    shared: true,
    permissions: { read: true, write: false, delete: false }
  }
})
```

### Q4: 可以禁用自动前缀吗？

**A**: 不推荐。如果确实需要旧的行为，将所有命名空间标记为 `shared: true`：

```typescript
// 不推荐：全部共享
registerNamespaces('script-A', {
  'user.profile': { shared: true, /* ... */ }
})
```

### Q5: list() 方法返回的键是否带前缀？

**A**: 不带。系统会自动移除前缀（denormalize），用户看到的是原始命名空间：

```typescript
const items = await runLua('script-A', `
  State.set('user.profile', { name = 'Alice' })
  State.set('user.settings', { theme = 'dark' })
  
  local items = State.list('user')
  for k, v in pairs(items) do
    print(k)  -- 输出：user.profile, user.settings（无前缀）
  end
`)
```

## 相关文档

- [状态管理 API](./README.md#state-api)
- [命名空间权限](./README.md#registernamespaces)
- [命名空间作用域分析](./NAMESPACE_SCOPING_ANALYSIS.md)
