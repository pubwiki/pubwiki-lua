# Lua Runner Frontend

This is a minimal React + Vite frontend that loads the Emscripten-built `lua_runner_wasm` and lets users run Lua code in the browser.

## Dev

1) Build the wasm artifacts from `runner` and copy them into `frontend/public/wasm/`:
   - `lua_runner_wasm.js`
   - `lua_runner_wasm.wasm`

2) Start dev server:

```sh
npm install
npm run dev
```

Open the URL printed by Vite.
