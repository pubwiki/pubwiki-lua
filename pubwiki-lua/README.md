# pubwiki-lua

A small TypeScript library that wraps the Emscripten-compiled Lua runtime, including MediaWiki-style `require` resolution. Assets are bundled with the package so you can drop it into any web project without copying glue files by hand.

## Features

- Lazy-loads the WebAssembly Lua runner and keeps it cached while your app runs.
- `require` support for:
  - MediaWiki modules via the JSON API (`mediawiki://example.org/Module:Foo`).
  - Arbitrary HTTP/HTTPS URLs.
  - Ephemeral file uploads you register at runtime.
- Friendly helpers for managing file-module lifecycle and cache state.
- **Namespace state management** with pluggable storage backends:
  - Built-in IndexedDB backend (default)
  - Built-in Memory backend (for testing)
  - Built-in LocalStorage backend (for simple cases)
  - Custom backend interface for advanced use cases
- **Concurrent-safe**: Multiple `runLua` calls can execute concurrently with different `scriptId`s
- **Secure**: Scripts cannot forge their identity or access other scripts' namespaces

## Installation

```sh
npm install pubwiki-lua
```

## Usage

```ts
import {
  loadRunner,
  runLua,
  registerFileModule,
  clearRemoteModuleCache
} from 'pubwiki-lua'

await loadRunner()

registerFileModule('Module:MyHelpers', `return {
  greet = function(name)
    return 'Hi, ' .. name
  end
}`)

// runLua requires a scriptId for permission control and state isolation
const output = await runLua(`
  local helpers = require('file://Module:MyHelpers')
  return helpers.greet('世界')
`, 'my-script')

console.log(output) // => Hi, 世界

clearRemoteModuleCache()
```

## State Management

pubwiki-lua includes a built-in state management system with pluggable storage backends. By default, state is persisted in IndexedDB.

### Basic Usage

```ts
import { loadRunner, runLua, registerNamespaces } from 'pubwiki-lua'

await loadRunner()

// Register namespace access for a script
registerNamespaces('my-script', {
  allowedNamespaces: ['default', 'user-data'],
  defaultNamespace: 'default'
})

// Use state in Lua - scriptId is passed as the second parameter
const result = await runLua(`
  -- Set state (persists across page reloads)
  State.set("count", 42)
  
  -- Get state
  local count = State.get("count")
  
  -- Use with default value
  local name = State.get("username", "anonymous")
  
  return "Count: " .. count
`, 'my-script'), 'my-script')
```

### Custom Storage Backends

You can use a different storage backend or implement your own:

```ts
import { loadRunner, setStorageBackend, MemoryBackend } from 'pubwiki-lua'

// Use in-memory storage (doesn't persist)
setStorageBackend(new MemoryBackend())
await loadRunner()
```

See [STORAGE_BACKENDS.md](./STORAGE_BACKENDS.md) for complete documentation on:
- Built-in backends (IndexedDB, Memory, LocalStorage)
- Creating custom backends
- Advanced examples (Remote API, Hybrid caching, Encryption)
- Testing and best practices

### Namespace Isolation

From v1.0.0+, pubwiki-lua automatically isolates namespaces between different scripts to prevent collisions. Each script's private namespaces are automatically prefixed with its `scriptId`:

```ts
// Script A
registerNamespaces('script-A', {
  'user.profile': {
    permissions: { read: true, write: true, delete: false }
  }
})

await runLua('script-A', `
  State.set('user.profile', { name = 'Alice' })
`)
// Actually stored as: 'script-A/user.profile'

// Script B
registerNamespaces('script-B', {
  'user.profile': {
    permissions: { read: true, write: true, delete: false }
  }
})

await runLua('script-B', `
  State.set('user.profile', { name = 'Bob' })
`)
// Actually stored as: 'script-B/user.profile'

// Data is completely isolated between scripts
```

**Shared Namespaces**: If you want multiple scripts to share data, mark the namespace as `shared: true`:

```ts
registerNamespaces('script-A', {
  'global.events': {
    shared: true,
    permissions: { read: true, write: true, delete: false }
  }
})

registerNamespaces('script-B', {
  'global.events': {
    shared: true,
    permissions: { read: true, write: false, delete: false }
  }
})

// Both scripts can access 'global.events' (no prefix added)
```

See [NAMESPACE_SCOPING.md](../NAMESPACE_SCOPING.md) for complete documentation on:
- Namespace types (private, shared, script-specific)
- Auto-prefix mechanism
- Permission management for shared namespaces
- Migration guide from older versions
- Best practices and common patterns

## Assets

The package publishes its WebAssembly glue in `wasm/`. If you need to host those files elsewhere (for example, behind a CDN path), call `setGluePath()` once before `loadRunner()`.

```ts
import { setGluePath } from 'pubwiki-lua'

setGluePath('/static/pubwiki-lua/lua_runner_glue.js')
```

## Building locally

```sh
npm install
npm run build
```

The build emits ESM JavaScript and type declarations into `dist/`.
