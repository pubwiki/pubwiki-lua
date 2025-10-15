# Lua Runner (Rust + mlua -> WASM)

Build a WebAssembly module using mlua (vendored Lua 5.4) that exposes C ABI functions callable from JS.

## Prerequisites

- Rust toolchain
- Emscripten SDK (emsdk) installed and activated in your shell
- Rust target `wasm32-unknown-emscripten` installed

## Build

```sh
# activate emsdk in this shell first
rustup target add wasm32-unknown-emscripten
cargo build --release --target wasm32-unknown-emscripten
```

Artifacts will be under:
- `target/wasm32-unknown-emscripten/release/lua_runner_wasm.wasm`
- `target/wasm32-unknown-emscripten/release/lua_runner_wasm.js`

Copy these two files into `../frontend/public/wasm/`.

## Exported C ABI

- `lua_run(code_ptr: *const c_char) -> *const c_char`
- `lua_free_last(ptr: *const c_char)`