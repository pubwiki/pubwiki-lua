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

const output = await runLua(`
  local helpers = require('file://Module:MyHelpers')
  return helpers.greet('世界')
`)

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

// Use state in Lua
const result = await runLua(`
  -- Set state (persists across page reloads)
  State.set("count", 42)
  
  -- Get state
  local count = State.get("count")
  
  -- Use with default value
  local name = State.get("username", "anonymous")
  
  return "Count: " .. count
`, 'my-script')
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
