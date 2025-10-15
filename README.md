# Lua Front (mlua WASM + React)

A minimal Lua playground:
- `runner/`: Rust + mlua compiled to WebAssembly via Emscripten.
- `frontend/`: React + Vite app that loads the wasm and runs Lua code.

## Prerequisites

- Linux recommended
- Rust toolchain (`rustup`)
- Emscripten SDK installed and activated in your current shell
- Node.js 18+ and npm

## Build and run (fish shell)

1) 一键开发（推荐）：

```fish
just dev
```

这会检查 emscripten、构建 wasm、复制产物到前端、安装依赖，并启动 Vite 开发服务器。

2) 或者分步执行（如果你更喜欢手动）：

2.1) Build WASM runner (activate emsdk first in this terminal):

```fish
rustup target add wasm32-unknown-emscripten
cd runner
cargo build --release --target wasm32-unknown-emscripten
cd ..
```

2.2) Copy wasm artifacts to frontend public:

```fish
mkdir -p frontend/public/wasm
cp runner/target/wasm32-unknown-emscripten/release/lua_runner_wasm.* frontend/public/wasm/
```

2.3) Start frontend dev server:

```fish
cd frontend
npm install
npm run dev
```

Open the URL shown by Vite and try:

```
print('Hello from Lua!')
return 1+2
```

## Notes

- `mlua` is configured with `features = ["lua54", "vendored"]` for easier builds.
- We export C symbols and use Emscripten `-sMODULARIZE=1` so the JS glue can be dynamically imported by Vite.
- For production, run `npm run build` in `frontend` and serve the `dist/` folder.

## Justfile shortcuts

- `just dev`：构建 wasm、复制产物、安装前端依赖并启动 Vite。
- `just preview`：构建 wasm + 前端产物，并启动 Vite 预览服务器。
- `just clean`：清理所有构建产物。
