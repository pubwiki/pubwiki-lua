# pubwiki-lua

A TypeScript library that wraps an Emscripten-compiled Lua 5.4 runtime with RDF triple store integration and MediaWiki module support.

## Features

- **Lua 5.4 Runtime**: Full-featured Lua VM compiled to WebAssembly
- **RDF State API**: Built-in triple store for semantic data management
- **MediaWiki require()**: Load modules from MediaWiki sites via JSON API
- **HTTP/HTTPS modules**: Fetch Lua code from any URL
- **In-memory modules**: Register ephemeral file modules at runtime
- **Pluggable Storage**: Integrate with any RDF store (Quadstore, N3.js, custom backends)
- **Type-Safe**: Full TypeScript support with comprehensive type definitions

## Installation

```sh
npm install pubwiki-lua
```

## Quick Start

```ts
import { loadRunner, runLua } from 'pubwiki-lua'
import { QuadstoreRDFStore } from './your-rdf-store'

// Initialize the Lua runtime
await loadRunner()

// Create an RDF store instance
const store = new QuadstoreRDFStore()

// Run Lua code with RDF state access
const result = await runLua(`
  -- Insert RDF triples
  State.insert('user:alice', 'name', 'Alice')
  State.insert('user:alice', 'age', 30)
  State.insert('user:alice', 'city', 'Tokyo')
  
  -- Query triples
  local user_data = State.query({subject = 'user:alice'})
  
  print('Alice has ' .. #user_data .. ' properties')
  for i, triple in ipairs(user_data) do
    print(triple.predicate .. ': ' .. tostring(triple.object))
  end
  
  return 'Done'
`, store)

console.log(result)
```

## RDF State API

The Lua `State` object provides methods for working with RDF triples:

### State.insert(subject, predicate, object)

Insert a single triple into the store.

```lua
State.insert('book:1984', 'title', '1984')
State.insert('book:1984', 'author', 'George Orwell')
State.insert('book:1984', 'year', 1949)
State.insert('book:1984', 'genre', 'dystopian')
```

### State.delete(subject, predicate, object?)

Delete triples matching the pattern. If `object` is omitted, deletes all triples with matching subject and predicate.

```lua
-- Delete a specific triple
State.delete('book:1984', 'year', 1949)

-- Delete all triples with subject + predicate
State.delete('book:1984', 'genre')
```

### State.query(pattern)

Query triples matching a pattern. Use `nil` for wildcards.

```lua
-- Find all books (any subject with 'title' predicate)
local books = State.query({predicate = 'title'})

-- Find all properties of a specific book
local book_data = State.query({subject = 'book:1984'})

-- Find books of a specific genre
local dystopian = State.query({
  predicate = 'genre',
  object = 'dystopian'
})

-- Get book titles from results
for i, triple in ipairs(dystopian) do
  local titles = State.query({
    subject = triple.subject,
    predicate = 'title'
  })
  if #titles > 0 then
    print(titles[1].object)
  end
end
```

### State.batchInsert(triples)

Insert multiple triples at once for better performance.

```lua
local products = {
  {subject = 'product:p1', predicate = 'name', object = 'Laptop'},
  {subject = 'product:p1', predicate = 'price', object = 999},
  {subject = 'product:p2', predicate = 'name', object = 'Mouse'},
  {subject = 'product:p2', predicate = 'price', object = 29},
}

State.batchInsert(products)
```

## RDFStore Interface

To use pubwiki-lua, you need to provide an RDFStore implementation. The library provides a sync adapter for async stores.

### Interface

```typescript
export interface RDFStore {
  insert(subject: string, predicate: string, object: any): Promise<void> | void
  delete(subject: string, predicate: string, object?: any): Promise<void> | void
  query(pattern: TriplePattern): Promise<Triple[]> | Triple[]
  batchInsert?(triples: Triple[]): Promise<void> | void
}

export interface Triple {
  subject: string
  predicate: string
  object: any
}

export interface TriplePattern {
  subject?: string | null
  predicate?: string | null
  object?: any | null
}
```

### Example: Quadstore Backend

```typescript
import { Quadstore } from 'quadstore'
import { MemoryLevel } from 'memory-level'
import { DataFactory } from 'n3'

export class QuadstoreRDFStore implements RDFStore {
  private store: Quadstore
  
  constructor() {
    const backend = new MemoryLevel()
    this.store = new Quadstore({
      backend,
      dataFactory: DataFactory
    })
  }
  
  async insert(subject: string, predicate: string, object: any) {
    await this.store.put(this.tripleToQuad({ subject, predicate, object }))
  }
  
  async delete(subject: string, predicate: string, object?: any) {
    const pattern = { subject, predicate, object }
    await this.store.deleteMatches(/* ... */)
  }
  
  async query(pattern: TriplePattern): Promise<Triple[]> {
    const results = await this.store.getStream(/* ... */)
    return results.map(this.quadToTriple)
  }
  
  // ... helper methods
}
```

### Sync Adapter

For async stores, use the provided sync adapter:

```typescript
import { createSyncAdapter } from 'pubwiki-lua/rdf-bridge'

const asyncStore = new QuadstoreRDFStore()
const syncStore = createSyncAdapter(asyncStore)

await runLua(luaCode, syncStore)
```

The sync adapter uses N3.js Store as an in-memory cache, providing synchronous access while persisting to the async store in the background.

## MediaWiki require() Support

Load Lua modules from MediaWiki sites, HTTP endpoints, or in-memory files.

### Basic Usage

```ts
import { registerFileModule } from 'pubwiki-lua'

// Register an in-memory module
registerFileModule('Module:MyHelpers', `
return {
  greet = function(name)
    return 'Hello, ' .. name
  end
}
`)

// Use in Lua
const result = await runLua(`
  local helpers = require('file://Module:MyHelpers')
  return helpers.greet('World')
`, store)
```

### MediaWiki Modules

```lua
-- Load from MediaWiki site
local module = require('mediawiki://en.wikipedia.org/Module:String')
return module.upper('hello')
```

### HTTP/HTTPS Modules

```lua
-- Load from any URL
local lib = require('https://example.com/lua/mylib.lua')
return lib.someFunction()
```

### Module Management

```ts
import { 
  uploadFileModule,
  clearModuleCache,
  registerFileModule 
} from 'pubwiki-lua'

// Upload a module
uploadFileModule('file://Module:Utils', luaCode)

// Clear remote module cache
clearModuleCache()
```

## Advanced Configuration

### Custom WASM Path

If you need to host WASM files on a CDN:

```ts
import { loadRunner } from 'pubwiki-lua'

await loadRunner('/cdn/path/to/lua_runner_glue.js')
```

### Print Output

The `runLua` function returns both print output and return values:

```ts
const output = await runLua(`
  print('Debug message')
  print('Another message')
  return 42
`, store)

// Output includes both prints and return value:
// "Debug message\nAnother message\n42"
```

## Resource URIs

Strings starting with `resource://` are treated as RDF resource URIs (NamedNodes), all other values are literals:

```lua
-- This creates a NamedNode → Literal relationship
State.insert('resource://user:alice', 'name', 'Alice')

-- This creates a NamedNode → NamedNode relationship
State.insert('resource://post:1', 'author', 'resource://user:alice')
```

## Building Locally

```sh
pnpm install
pnpm run build
```

The build emits ESM JavaScript and type declarations into `dist/`.

## TypeScript API

```typescript
// Core functions
export function loadRunner(customGluePath?: string): Promise<void>
export function runLua(code: string, store: SyncRDFStore): Promise<string>

// Module management
export function registerFileModule(name: string, content: string): void
export function uploadFileModule(name: string, content: string): void
export function clearModuleCache(): void

// RDF bridge
export function createSyncAdapter(store: RDFStore): SyncRDFStore
export function setRDFStore(store: SyncRDFStore): void
export function clearRDFStore(): void

// Types
export interface RDFStore { /* ... */ }
export interface SyncRDFStore { /* ... */ }
export interface Triple { /* ... */ }
export interface TriplePattern { /* ... */ }
```

## License

MIT

