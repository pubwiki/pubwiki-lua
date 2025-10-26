# pubwiki-lua 包使用说明

## 包结构

发布到 npm 的包包含以下内容：

```
pubwiki-lua/
├── dist/              # 编译后的 JavaScript 和类型定义
│   ├── index.js      # 主入口文件
│   ├── index.d.ts    # TypeScript 类型定义
│   ├── *.js.map      # Source maps
│   └── ...
├── wasm/             # WebAssembly 文件（自动包含）
│   ├── lua_runner_glue.js
│   └── lua_runner_wasm.wasm
├── src/              # TypeScript 源码（可选，用于调试）
└── package.json
```

## 安装

```bash
npm install pubwiki-lua
# 或
pnpm add pubwiki-lua
# 或
yarn add pubwiki-lua
```

## 使用方式

### 基础使用

```typescript
import { loadRunner, runLua } from 'pubwiki-lua'

// 加载 Lua 运行时（会自动加载 WASM 文件）
await loadRunner()

// 运行 Lua 代码
const result = await runLua('return "Hello from Lua!"')
console.log(result) // "Hello from Lua!"
```

### WASM 文件处理

**不需要手动拷贝 WASM 文件！** 

包的设计会自动处理 WASM 文件的加载：

1. **默认行为**：`loadRunner()` 会使用 `import.meta.url` 自动定位包内的 `wasm/` 目录
2. **自动包含**：`wasm/` 目录已在 `package.json` 的 `files` 字段中声明，npm 安装时会自动包含
3. **模块解析**：通过 `"./wasm/*": "./wasm/*"` 导出配置，打包工具可以正确解析 WASM 文件

### 自定义 WASM 路径（可选）

如果你需要从 CDN 或其他位置加载 WASM 文件：

```typescript
import { setGluePath, loadRunner } from 'pubwiki-lua'

// 在 loadRunner() 之前设置自定义路径
setGluePath('https://cdn.example.com/lua_runner_glue.js')
await loadRunner()
```

## Vite 项目配置

在 Vite 项目中使用时，**无需额外配置**。Vite 会自动处理：

```typescript
// vite.config.js - 不需要特殊配置
export default {
  // ... 你的其他配置
}
```

Vite 会：
- 自动处理 `import.meta.url` 路径解析
- 正确打包 WASM 文件到输出目录
- 在开发和生产环境中都能正常工作

## Webpack 项目配置

Webpack 5+ 原生支持 WASM，无需额外插件：

```javascript
// webpack.config.js
module.exports = {
  experiments: {
    asyncWebAssembly: true, // 启用异步 WASM 支持
  },
  // ... 其他配置
}
```

## 打包工具支持

| 打包工具 | 版本要求 | 支持情况 | 额外配置 |
|---------|---------|---------|---------|
| Vite    | 4.0+    | ✅ 完全支持 | 无需配置 |
| Webpack | 5.0+    | ✅ 完全支持 | 需启用 experiments.asyncWebAssembly |
| Rollup  | 3.0+    | ✅ 完全支持 | 使用 @rollup/plugin-wasm |
| esbuild | 0.17+   | ✅ 完全支持 | 无需配置 |

## 常见问题

### Q: 为什么发布的是编译后的 JS 而不是 TS 源码？

**A:** 编译后发布有以下优势：
1. **WASM 路径可靠**：`new URL('../wasm/...', import.meta.url)` 在编译后能正确解析
2. **兼容性更好**：不依赖用户项目的 TypeScript 配置
3. **加载更快**：用户不需要编译 TS 源码
4. **标准实践**：这是 npm 包发布的标准做法

### Q: 我能访问 TypeScript 源码吗？

**A:** 可以！包中包含 `src/` 目录供调试使用。你可以：
```typescript
// 查看源码进行调试
import type { StorageBackend } from 'pubwiki-lua/src/storage-backend'
```

但在生产中请使用编译后的版本：
```typescript
import type { StorageBackend } from 'pubwiki-lua'
```

### Q: 遇到 "Failed to fetch WASM" 错误怎么办？

**A:** 检查以下几点：
1. 确保在浏览器环境中运行（不支持 Node.js）
2. 检查网络请求，确认 WASM 文件能正确加载
3. 如果使用 CDN，使用 `setGluePath()` 设置正确的路径
4. 检查打包工具是否正确处理了 WASM 文件

### Q: 如何在生产环境优化 WASM 加载？

**A:** 可以使用 CDN 并添加预加载：

```html
<!-- 在 HTML 中预加载 -->
<link rel="modulepreload" href="/assets/lua_runner_glue.js">
<link rel="prefetch" href="/assets/lua_runner_wasm.wasm">
```

```typescript
// 在代码中使用 CDN
import { setGluePath, loadRunner } from 'pubwiki-lua'

setGluePath('https://cdn.example.com/pubwiki-lua/wasm/lua_runner_glue.js')
await loadRunner()
```

## 本地开发

如果你要开发 pubwiki-lua 本身：

```bash
# 克隆仓库
git clone https://github.com/pubwiki/pubwiki-lua.git
cd pubwiki-lua/pubwiki-lua

# 安装依赖
npm install

# 构建
npm run build

# 类型检查
npm run typecheck

# 本地链接测试
npm link
cd /your/project
npm link pubwiki-lua
```

## 发布清单

发布前自动执行的操作（通过 `prepublishOnly` 脚本）：
1. ✅ 清理旧的 dist 目录
2. ✅ 重新编译 TypeScript
3. ✅ 生成类型定义和 source maps
4. ✅ 包含 wasm 文件

发布时包含的文件（由 `package.json` 的 `files` 字段控制）：
- ✅ `dist/` - 编译后的 JavaScript 和类型定义
- ✅ `wasm/` - WebAssembly 文件
- ✅ `src/` - TypeScript 源码（可选，用于调试）
- ✅ `README.md` - 文档
- ✅ `STORAGE_BACKENDS.md` - Storage backend 文档

## 总结

✅ **无需手动拷贝 WASM 文件** - 包会自动处理  
✅ **开箱即用** - 大多数打包工具无需配置  
✅ **类型安全** - 完整的 TypeScript 类型定义  
✅ **标准发布** - 遵循 npm 包最佳实践  
✅ **源码可访问** - 包含 src 目录供调试  

如有问题，请访问 [GitHub Issues](https://github.com/pubwiki/pubwiki-lua/issues)
