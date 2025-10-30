# One-command dev workflow for the Lua runner workspace (Rust -> TS package -> React app)

set shell := ["/bin/sh", "-cu"]

EXAMPLE := "example"
RUNNER := "runner"
LIB := "pubwiki-lua"

# Default target
default: dev

# Check Emscripten availability
ensure-emsdk:
	if command -v emcc >/dev/null 2>&1; then \
	  echo "[ok] emscripten: $(emcc --version | head -n 1)"; \
	else \
	  echo "[err] Emscripten not found. Please install/activate emsdk in this shell."; \
	  echo "      See runner/README.md for setup."; \
	  exit 1; \
	fi

# Build the Rust WASM runner and copy artifacts into the TypeScript package
wasm: ensure-emsdk
	rustup target add wasm32-unknown-emscripten
	cd {{justfile_directory()}}/{{RUNNER}} && cargo build --release --target wasm32-unknown-emscripten 
	mkdir -p {{justfile_directory()}}/{{LIB}}/wasm
	if [ -f {{justfile_directory()}}/{{RUNNER}}/target/wasm32-unknown-emscripten/release/lua_runner_wasm.js ]; then \
	  cp -f {{justfile_directory()}}/{{RUNNER}}/target/wasm32-unknown-emscripten/release/lua_runner_wasm.js {{justfile_directory()}}/{{LIB}}/wasm/lua_runner_glue.js; \
	else \
	  echo "[warn] JS glue not found at target/release/lua_runner_wasm.js"; \
	fi
	cp -f {{justfile_directory()}}/{{RUNNER}}/target/wasm32-unknown-emscripten/release/lua_runner_wasm.wasm {{justfile_directory()}}/{{LIB}}/wasm/
	echo "[ok] Copied wasm + glue to {{LIB}}/wasm"
	echo "      Run 'just lib-build' to regenerate the package outputs."

# Install npm dependencies for both the library and the EXAMPLE
deps:
	cd {{justfile_directory()}}/{{LIB}} && npm install
	cd {{justfile_directory()}}/{{EXAMPLE}} && npm install

# Build the TypeScript library (emits dist/ for pubwiki-lua)
lib-build:
	cd {{justfile_directory()}}/{{LIB}} && npm run build


# Dev: install deps, ensure library built, then start Vite dev server (holds the terminal)
dev: deps lib-build
	if [ ! -f {{justfile_directory()}}/{{LIB}}/wasm/lua_runner_glue.js ] || [ ! -f {{justfile_directory()}}/{{LIB}}/wasm/lua_runner_wasm.wasm ]; then \
		echo "[warn] WASM artifacts missing under {{LIB}}/wasm. Lua runner may not load."; \
		echo "       Run 'just wasm' in a shell with emsdk activated to rebuild them."; \
	fi
	cd {{justfile_directory()}}/{{EXAMPLE}} && npm run dev

# Build for production and run Vite preview server
preview: deps lib-build
	if [ ! -f {{justfile_directory()}}/{{LIB}}/wasm/lua_runner_glue.js ] || [ ! -f {{justfile_directory()}}/{{LIB}}/wasm/lua_runner_wasm.wasm ]; then \
		echo "[warn] WASM artifacts missing under {{LIB}}/wasm. Lua runner may not load."; \
		echo "       Run 'just wasm' in a shell with emsdk activated to rebuild them."; \
	fi
	cd {{justfile_directory()}}/{{EXAMPLE}} && npm run build && npm run preview

# Clean generated artifacts
clean:
	rm -rf {{justfile_directory()}}/{{LIB}}/dist {{justfile_directory()}}/{{LIB}}/node_modules || true
	rm -rf {{justfile_directory()}}/{{EXAMPLE}}/node_modules {{justfile_directory()}}/{{EXAMPLE}}/dist || true
	rm -rf {{justfile_directory()}}/{{RUNNER}}/target || true
	echo "[ok] Cleaned build artifacts"
