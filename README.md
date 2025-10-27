# pubwiki-lua

A browser-friendly Lua runtime with RDF triple store integration.

## Project Structure

- `runner/`: Rust + mlua compiled to WebAssembly via Emscripten
- `pubwiki-lua/`: TypeScript library that wraps the WASM runtime
- `example/`: React + Vite demo application

## Features

- **Lua 5.4 Runtime**: Full Lua VM running in WebAssembly
- **RDF Triple Store**: Built-in State API for semantic data management
- **MediaWiki require()**: Load modules from MediaWiki sites, HTTP/HTTPS, or in-memory files
- **Pluggable Storage**: Use Quadstore, N3.js, or implement custom RDFStore backends
- **Type-Safe**: Full TypeScript support with type definitions

## Quick Start

### Prerequisites

- Linux recommended
- Rust toolchain (`rustup`)
- Emscripten SDK (for rebuilding WASM)
- Node.js 18+ and pnpm

### Development

```fish
# Build everything and start dev server
just dev

# Or step by step:
just wasm        # Build WASM (requires emsdk)
just lib-build   # Build TypeScript library
just example     # Start example app
```

### Try it in the browser

Open the example app and run:

```lua
-- Insert RDF triples
State.insert('book:1984', 'title', '1984')
State.insert('book:1984', 'author', 'George Orwell')
State.insert('book:1984', 'year', 1949)

-- Query by predicate
local books = State.query({predicate = 'title'})
for i, triple in ipairs(books) do
  print(string.format('%s: %s', triple.subject, triple.object))
end

-- Query with multiple conditions
local orwell_books = State.query({
  predicate = 'author',
  object = 'George Orwell'
})

return string.format('Found %d books by Orwell', #orwell_books)
```

## Documentation

- [Library README](./pubwiki-lua/README.md) - API reference and usage guide
- [Example README](./example/README.md) - Demo app documentation
- [RDF Refactoring Summary](./RDF_REFACTORING_SUMMARY.md) - Architecture changes

## Building from Source

### Build WASM runner

```fish
# Activate emsdk first
rustup target add wasm32-unknown-emscripten
cd runner
cargo build --release --target wasm32-unknown-emscripten
cd ..
```

### Build TypeScript library

```fish
cd pubwiki-lua
pnpm install
pnpm run build
cd ..
```

### Build example app

```fish
cd example
pnpm install
pnpm run dev  # or pnpm run build
```

## Justfile Commands

- `just dev` - Build all and start development server
- `just wasm` - Build WASM module only
- `just lib-build` - Build TypeScript library only
- `just example` - Start example app only
- `just clean` - Clean all build artifacts

## License

MIT

