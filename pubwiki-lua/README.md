# pubwiki-lua

A small TypeScript library that wraps the Emscripten-compiled Lua runtime, including MediaWiki-style `require` resolution. Assets are bundled with the package so you can drop it into any web project without copying glue files by hand.

## Features

- Lazy-loads the WebAssembly Lua runner and keeps it cached while your app runs.
- `require` support for:
  - MediaWiki modules via the JSON API (`mediawiki://example.org/Module:Foo`).
  - Arbitrary HTTP/HTTPS URLs.
  - Ephemeral file uploads you register at runtime.
- Friendly helpers for managing file-module lifecycle and cache state.

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
