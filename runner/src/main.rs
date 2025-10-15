// Minimal binary to force Emscripten to generate JS glue alongside the WASM.
// The exported C ABI functions are defined in lib.rs; they are retained
// by the -sEXPORTED_FUNCTIONS link flag configured in .cargo/config.toml.

use mlua::prelude::*;
use mlua::{Table, Variadic};
use std::cell::RefCell;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_uchar};
use std::slice;

thread_local! {
    static LAST_RESULT: RefCell<Option<CString>> = RefCell::new(None);
}

#[link(wasm_import_module = "env")]
extern "C" {
    fn fetch_lua_module(url_ptr: *const c_char, len_out: *mut u32) -> *const c_uchar;
    fn free_lua_module(ptr: *const c_uchar, len: u32);
    fn get_last_fetch_error(len_out: *mut u32) -> *const c_uchar;
}

fn set_last_result(s: String) -> *const c_char {
    let c = CString::new(s).unwrap_or_else(|_| CString::new("\0").unwrap());
    let ptr = c.as_ptr();
    LAST_RESULT.with(|cell| {
        *cell.borrow_mut() = Some(c);
    });
    ptr
}

fn read_c_string(ptr: *const c_char) -> LuaResult<String> {
    if ptr.is_null() {
        return Ok(String::new());
    }
    unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .map(|s| s.to_string())
        .map_err(|e| LuaError::external(e))
}

fn install_print_collector(lua: &Lua, buffer: &RefCell<String>) -> LuaResult<()> {
    // Override global print to capture output
    let print_fn = {
        let buffer = buffer.clone();
        lua.create_function(move |_lua, values: Variadic<LuaValue>| {
            let mut parts = Vec::with_capacity(values.len());
            for v in values.iter() {
                parts.push(match v {
                    LuaValue::Nil => "nil".to_string(),
                    LuaValue::Boolean(b) => b.to_string(),
                    LuaValue::LightUserData(_) => "lightuserdata".to_string(),
                    LuaValue::Integer(i) => i.to_string(),
                    LuaValue::Number(n) => {
                        if n.fract() == 0.0 { format!("{:.0}", n) } else { n.to_string() }
                    }
                    LuaValue::String(s) => match s.to_str() {
                        Ok(t) => t.to_string(),
                        Err(_) => "<invalid utf8>".to_string(),
                    },
                    LuaValue::Table(_) => "table".to_string(),
                    LuaValue::Function(_) => "function".to_string(),
                    LuaValue::Thread(_) => "thread".to_string(),
                    LuaValue::UserData(_) => "userdata".to_string(),
                    LuaValue::Error(e) => e.to_string(),
                    _ => "<unknown>".to_string(),
                });
            }
            let line = parts.join("\t");
            buffer.borrow_mut().push_str(&line);
            buffer.borrow_mut().push('\n');
            // Return nil to match Lua's print semantics
            Ok(())
        })?
    };
    lua.globals().set("print", print_fn)?;

    // Also capture io.write (no trailing newline)
    if let Ok(io_table) = lua.globals().get::<Table>("io") {
        let write_fn = {
            let buffer = buffer.clone();
            lua.create_function(move |_lua, values: Variadic<LuaValue>| {
                for (i, v) in values.iter().enumerate() {
                    if i > 0 {
                        // io.write doesn't insert separators by default
                    }
                    let s = match v {
                        LuaValue::Nil => "nil".to_string(),
                        LuaValue::Boolean(b) => b.to_string(),
                        LuaValue::LightUserData(_) => "lightuserdata".to_string(),
                        LuaValue::Integer(i) => i.to_string(),
                        LuaValue::Number(n) => {
                            if n.fract() == 0.0 { format!("{:.0}", n) } else { n.to_string() }
                        }
                        LuaValue::String(s) => match s.to_str() {
                            Ok(t) => t.to_string(),
                            Err(_) => "<invalid utf8>".to_string(),
                        },
                        LuaValue::Table(_) => "table".to_string(),
                        LuaValue::Function(_) => "function".to_string(),
                        LuaValue::Thread(_) => "thread".to_string(),
                        LuaValue::UserData(_) => "userdata".to_string(),
                        LuaValue::Error(e) => e.to_string(),
                        _ => "<unknown>".to_string(),
                    };
                    buffer.borrow_mut().push_str(&s);
                }
                Ok(())
            })?
        };
        let _ = io_table.set("write", write_fn);
    }
    Ok(())
}

fn fetch_module_source(name: &str) -> LuaResult<String> {
    let name_c = CString::new(name).map_err(|e| LuaError::external(e))?;
    let mut len: u32 = 0;
    let ptr = unsafe { fetch_lua_module(name_c.as_ptr(), &mut len) };
    if ptr.is_null() {
        let message = unsafe {
            let mut err_len: u32 = 0;
            let err_ptr = get_last_fetch_error(&mut err_len);
            if err_ptr.is_null() || err_len == 0 {
                "unknown module fetch error".to_string()
            } else {
                let slice = slice::from_raw_parts(err_ptr, err_len as usize);
                let msg = String::from_utf8_lossy(slice).into_owned();
                free_lua_module(err_ptr, err_len);
                msg
            }
        };
        return Err(LuaError::external(message));
    }

    let slice = unsafe { slice::from_raw_parts(ptr, len as usize) };
    let source = std::str::from_utf8(slice)
        .map(|s| s.to_string())
        .map_err(|e| LuaError::external(e.to_string()))?;
    unsafe { free_lua_module(ptr, len) };
    Ok(source)
}

fn install_require_loader(lua: &Lua) -> LuaResult<()> {
    let package: Table = lua.globals().get("package")?;
    let searchers: Table = package.get("searchers")?;

    let loader = lua.create_function(|lua, module: String| -> LuaResult<LuaValue> {
        match fetch_module_source(&module) {
            Ok(source) => {
                let func = lua.load(&source).set_name(&module).into_function()?;
                Ok(LuaValue::Function(func))
            }
            Err(err) => {
                let msg = format!("error loading module '{}': {}", module, err);
                Ok(LuaValue::String(lua.create_string(&msg)?))
            }
        }
    })?;

    // Insert custom loader after the Lua preload loader (index 1)
    searchers.raw_insert(2, loader)?;
    Ok(())
}

#[no_mangle]
pub extern "C" fn lua_run(code_ptr: *const c_char) -> *const c_char {
    let code = match read_c_string(code_ptr) {
        Ok(s) => s,
        Err(e) => return set_last_result(format!("error: {}", e)),
    };

    let output = RefCell::new(String::new());
    let lua = Lua::new();

    if let Err(e) = install_print_collector(&lua, &output) {
        return set_last_result(format!("error: {}", e));
    }

    if let Err(e) = install_require_loader(&lua) {
        return set_last_result(format!("error: {}", e));
    }

    let res = lua.load(&code).set_name("input").eval::<LuaValue>();

    match res {
        Ok(val) => {
            if !output.borrow().is_empty() {
                output.borrow_mut().push_str("-- return --\n");
            }
            let ret = match val {
                LuaValue::Nil => "nil".to_string(),
                LuaValue::Boolean(b) => b.to_string(),
                LuaValue::Integer(i) => i.to_string(),
                LuaValue::Number(n) => n.to_string(),
                LuaValue::String(s) => match s.to_str() {
                    Ok(t) => t.to_string(),
                    Err(_) => "<invalid utf8>".to_string(),
                },
                _ => "<non-serializable return>".to_string(),
            };
            output.borrow_mut().push_str(&ret);
            set_last_result(output.borrow().clone())
        }
        Err(e) => set_last_result(format!("error: {}", e)),
    }
}

#[no_mangle]
pub extern "C" fn lua_free_last(ptr: *const c_char) {
    LAST_RESULT.with(|cell| {
        let mut guard = cell.borrow_mut();
        if let Some(cstr) = guard.as_ref() {
            if cstr.as_ptr() == ptr {
                *guard = None;
            }
        }
    });
}

fn main() {}
