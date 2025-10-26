// Minimal binary to force Emscripten to generate JS glue alongside the WASM.
// The exported C ABI functions are defined in lib.rs; they are retained
// by the -sEXPORTED_FUNCTIONS link flag configured in .cargo/config.toml.

use mlua::prelude::*;
use mlua::{prelude::LuaMultiValue, Table, Variadic};
use std::cell::RefCell;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_uchar};
use std::rc::Rc;
use std::slice;

thread_local! {
    static LAST_RESULT: RefCell<Option<CString>> = RefCell::new(None);
    static MEDIAWIKI_STACK: RefCell<Vec<String>> = RefCell::new(Vec::new());
}

struct ResolvedModuleSource {
    name: String,
    source: String,
}

struct MediaWikiGuard {
    pushed: bool,
}

impl MediaWikiGuard {
    fn new(spec: &str) -> Self {
        let Some(base) = mediawiki_base(spec) else {
            return MediaWikiGuard { pushed: false };
        };

        MEDIAWIKI_STACK.with(|stack| stack.borrow_mut().push(base));
        MediaWikiGuard { pushed: true }
    }
}

impl Drop for MediaWikiGuard {
    fn drop(&mut self) {
        if self.pushed {
            MEDIAWIKI_STACK.with(|stack| {
                stack.borrow_mut().pop();
            });
        }
    }
}

fn mediawiki_base(spec: &str) -> Option<String> {
    if !spec.starts_with("mediawiki://") {
        return None;
    }
    let marker = "Module:";
    let idx = spec.find(marker)?;
    Some(spec[..idx].to_string())
}

fn resolve_module_spec(name: &str) -> String {
    if name.contains("://") {
        return name.to_string();
    }
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return name.to_string();
    }
    MEDIAWIKI_STACK.with(|stack| {
        let Some(mut base) = stack.borrow().last().cloned() else {
            return name.to_string();
        };

        if trimmed.len() >= 7 && trimmed[..7].eq_ignore_ascii_case("module:") {
            base.push_str(trimmed);
        } else {
            base.push_str("Module:");
            base.push_str(trimmed);
        }
        base
    })
}

#[link(wasm_import_module = "env")]
extern "C" {
    fn fetch_lua_module(url_ptr: *const c_char, len_out: *mut u32) -> *const c_uchar;
    fn free_lua_module(ptr: *const c_uchar, len: u32);
    fn get_last_fetch_error(len_out: *mut u32) -> *const c_uchar;
    
    // 状态管理 API（同步接口）
    fn js_state_register(script_id_ptr: *const c_char, config_json_ptr: *const c_char) -> *const c_char;
    fn js_state_get(script_id_ptr: *const c_char, key_ptr: *const c_char, default_json_ptr: *const c_char) -> *const c_char;
    fn js_state_set(script_id_ptr: *const c_char, key_ptr: *const c_char, value_json_ptr: *const c_char, ttl: i32) -> *const c_char;
    fn js_state_delete(script_id_ptr: *const c_char, key_ptr: *const c_char) -> *const c_char;
    fn js_state_list(script_id_ptr: *const c_char, prefix_ptr: *const c_char) -> *const c_char;
    fn js_state_free(ptr: *const c_char);
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

fn install_print_collector(lua: &Lua, buffer: &Rc<RefCell<String>>) -> LuaResult<()> {
    let buffer = Rc::clone(buffer);
    lua.globals().set(
        "print",
        lua.create_function(move |_lua, values: Variadic<LuaValue>| {
            let mut output = String::new();
            let mut first = true;

            for value in values.iter() {
                if first {
                    first = false;
                } else {
                    output.push('\t');
                }

                let value_str = match value {
                    LuaValue::String(s) => s.to_str()?.to_string(),
                    LuaValue::Number(n) => n.to_string(),
                    LuaValue::Integer(i) => i.to_string(),
                    LuaValue::Boolean(b) => b.to_string(),
                    LuaValue::Nil => "nil".to_string(),
                    LuaValue::Table(_) => "table".to_string(),
                    LuaValue::Function(_) => "function".to_string(),
                    LuaValue::Thread(_) => "thread".to_string(),
                    LuaValue::UserData(_) => "userdata".to_string(),
                    LuaValue::LightUserData(_) => "userdata".to_string(),
                    LuaValue::Error(e) => format!("error: {}", e),
                    _ => "unknown".to_string(),
                };
                output.push_str(&value_str);
            }

            let line = output + "\n";
            buffer.borrow_mut().push_str(&line);

            Ok(())
        })?,
    )?;
    Ok(())
}

fn install_io_write_collector(lua: &Lua, buffer: &Rc<RefCell<String>>) -> LuaResult<()> {
    let buffer = Rc::clone(buffer);
    
    // 获取或创建 io 表
    let io: LuaTable = match lua.globals().get("io")? {
        LuaValue::Table(t) => t,
        _ => {
            let t = lua.create_table()?;
            lua.globals().set("io", t.clone())?;
            t
        }
    };
    
    // 替换 io.write 函数
    io.set(
        "write",
        lua.create_function(move |_lua, values: Variadic<LuaValue>| {
            let mut output = String::new();

            for value in values.iter() {
                let value_str = match value {
                    LuaValue::String(s) => s.to_str()?.to_string(),
                    LuaValue::Number(n) => n.to_string(),
                    LuaValue::Integer(i) => i.to_string(),
                    LuaValue::Boolean(b) => b.to_string(),
                    LuaValue::Nil => "nil".to_string(),
                    _ => return Err(LuaError::external("io.write expects string or number")),
                };
                output.push_str(&value_str);
            }

            buffer.borrow_mut().push_str(&output);

            Ok(())
        })?,
    )?;
    
    Ok(())
}

fn fetch_module_source(name: &str) -> LuaResult<ResolvedModuleSource> {
    let resolved_name = resolve_module_spec(name);
    let name_c = CString::new(resolved_name.clone()).map_err(|e| LuaError::external(e))?;
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
    Ok(ResolvedModuleSource {
        name: resolved_name,
        source,
    })
}

fn install_require_loader(lua: &Lua) -> LuaResult<()> {
    let package: Table = lua.globals().get("package")?;
    let searchers: Table = package.get("searchers")?;

    let loader = lua.create_function(|lua, module: String| -> LuaResult<LuaValue> {
        let resolved = match fetch_module_source(&module) {
            Ok(resolved) => resolved,
            Err(err) => {
                let msg = format!("error loading module '{}': {}", module, err);
                let text = lua.create_string(&msg)?;
                return Ok(LuaValue::String(text));
            }
        };

        let chunk = lua
            .load(&resolved.source)
            .set_name(&resolved.name)
            .into_function()?;

        if !resolved.name.starts_with("mediawiki://") {
            return Ok(LuaValue::Function(chunk));
        }

        let resolved_name = resolved.name.clone();
        let wrapped = lua.create_function(move |_lua, args: LuaMultiValue| {
            let _guard = MediaWikiGuard::new(&resolved_name);
            let result: LuaResult<LuaMultiValue> = chunk.call(args);
            result
        })?;
        Ok(LuaValue::Function(wrapped))
    })?;

    // Insert custom loader after the Lua preload loader (index 1)
    searchers.raw_insert(2, loader)?;
    Ok(())
}

/// 安装状态管理 API 到 Lua 全局环境
fn install_state_api(lua: &Lua) -> LuaResult<()> {
    let state_table = lua.create_table()?;
    
    // State.register(config) - 注册命名空间
    let register_fn = lua.create_function(|lua, config: LuaValue| -> LuaResult<()> {
        // 获取当前脚本ID
        let script_id: String = lua.globals().get("__SCRIPT_ID")
            .unwrap_or_else(|_| "unknown".to_string());
        
        // 将 config 转为 JSON
        let config_json = lua_value_to_json(lua, &config)?;
        let script_id_c = CString::new(script_id).map_err(|e| LuaError::external(e))?;
        let config_c = CString::new(config_json).map_err(|e| LuaError::external(e))?;
        
        let result_ptr = unsafe { js_state_register(script_id_c.as_ptr(), config_c.as_ptr()) };
        let result = read_c_string(result_ptr)?;
        unsafe { js_state_free(result_ptr) };
        
        if result.starts_with("ERROR:") {
            return Err(LuaError::external(result.trim_start_matches("ERROR:")));
        }
        Ok(())
    })?;
    state_table.set("register", register_fn)?;
    
    // State.get(key, default) - 获取状态
    let get_fn = lua.create_function(|lua, (key, default): (String, Option<LuaValue>)| -> LuaResult<LuaValue> {
        let script_id: String = lua.globals().get("__SCRIPT_ID")
            .unwrap_or_else(|_| "unknown".to_string());
        
        let default_json = match default {
            Some(val) => lua_value_to_json(lua, &val)?,
            None => "null".to_string(),
        };
        
        let script_id_c = CString::new(script_id).map_err(|e| LuaError::external(e))?;
        let key_c = CString::new(key).map_err(|e| LuaError::external(e))?;
        let default_c = CString::new(default_json).map_err(|e| LuaError::external(e))?;
        
        let result_ptr = unsafe { js_state_get(script_id_c.as_ptr(), key_c.as_ptr(), default_c.as_ptr()) };
        let result = read_c_string(result_ptr)?;
        unsafe { js_state_free(result_ptr) };
        
        if result.starts_with("ERROR:") {
            return Err(LuaError::external(result.trim_start_matches("ERROR:")));
        }
        
        json_to_lua_value(lua, &result)
    })?;
    state_table.set("get", get_fn)?;
    
    // State.set(key, value, ttl?) - 设置状态
    let set_fn = lua.create_function(|lua, (key, value, ttl): (String, LuaValue, Option<i32>)| -> LuaResult<()> {
        let script_id: String = lua.globals().get("__SCRIPT_ID")
            .unwrap_or_else(|_| "unknown".to_string());
        
        let value_json = lua_value_to_json(lua, &value)?;
        let script_id_c = CString::new(script_id).map_err(|e| LuaError::external(e))?;
        let key_c = CString::new(key).map_err(|e| LuaError::external(e))?;
        let value_c = CString::new(value_json).map_err(|e| LuaError::external(e))?;
        
        let result_ptr = unsafe { js_state_set(script_id_c.as_ptr(), key_c.as_ptr(), value_c.as_ptr(), ttl.unwrap_or(-1)) };
        let result = read_c_string(result_ptr)?;
        unsafe { js_state_free(result_ptr) };
        
        if result.starts_with("ERROR:") {
            return Err(LuaError::external(result.trim_start_matches("ERROR:")));
        }
        Ok(())
    })?;
    state_table.set("set", set_fn)?;
    
    // State.delete(key) - 删除状态
    let delete_fn = lua.create_function(|lua, key: String| -> LuaResult<()> {
        let script_id: String = lua.globals().get("__SCRIPT_ID")
            .unwrap_or_else(|_| "unknown".to_string());
        
        let script_id_c = CString::new(script_id).map_err(|e| LuaError::external(e))?;
        let key_c = CString::new(key).map_err(|e| LuaError::external(e))?;
        
        let result_ptr = unsafe { js_state_delete(script_id_c.as_ptr(), key_c.as_ptr()) };
        let result = read_c_string(result_ptr)?;
        unsafe { js_state_free(result_ptr) };
        
        if result.starts_with("ERROR:") {
            return Err(LuaError::external(result.trim_start_matches("ERROR:")));
        }
        Ok(())
    })?;
    state_table.set("delete", delete_fn)?;
    
    // State.list(prefix) - 列出键
    let list_fn = lua.create_function(|lua, prefix: String| -> LuaResult<LuaValue> {
        let script_id: String = lua.globals().get("__SCRIPT_ID")
            .unwrap_or_else(|_| "unknown".to_string());
        
        let script_id_c = CString::new(script_id).map_err(|e| LuaError::external(e))?;
        let prefix_c = CString::new(prefix).map_err(|e| LuaError::external(e))?;
        
        let result_ptr = unsafe { js_state_list(script_id_c.as_ptr(), prefix_c.as_ptr()) };
        let result = read_c_string(result_ptr)?;
        unsafe { js_state_free(result_ptr) };
        
        if result.starts_with("ERROR:") {
            return Err(LuaError::external(result.trim_start_matches("ERROR:")));
        }
        
        json_to_lua_value(lua, &result)
    })?;
    state_table.set("list", list_fn)?;
    
    lua.globals().set("State", state_table)?;
    Ok(())
}

/// 将 Lua 值转换为 JSON 字符串（使用 serde_json）
fn lua_value_to_json(lua: &Lua, value: &LuaValue) -> LuaResult<String> {
    // 使用 mlua 的序列化功能
    let json_value: serde_json::Value = lua.from_value(value.clone())?;
    serde_json::to_string(&json_value)
        .map_err(|e| LuaError::external(format!("JSON stringify error: {}", e)))
}

/// 将 JSON 字符串转换为 Lua 值（使用 serde_json）
fn json_to_lua_value(lua: &Lua, json: &str) -> LuaResult<LuaValue> {
    let json_value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| LuaError::external(format!("JSON parse error: {}", e)))?;
    
    lua.to_value(&json_value)
}

#[no_mangle]
pub extern "C" fn lua_run(code_ptr: *const c_char) -> *const c_char {
    let code = match read_c_string(code_ptr) {
        Ok(s) => s,
        Err(e) => return set_last_result(format!("error: {}", e)),
    };

    let output = Rc::new(RefCell::new(String::new()));
    let lua = Lua::new();

    if let Err(e) = install_print_collector(&lua, &output) {
        return set_last_result(format!("error: {}", e));
    }

    if let Err(e) = install_io_write_collector(&lua, &output) {
        return set_last_result(format!("error: {}", e));
    }

    if let Err(e) = install_require_loader(&lua) {
        return set_last_result(format!("error: {}", e));
    }

    if let Err(e) = install_state_api(&lua) {
        return set_last_result(format!("error: {}", e));
    }

    let value = match lua.load(&code).set_name("input").eval::<LuaValue>() {
        Ok(val) => val,
        Err(e) => return set_last_result(format!("error: {}", e)),
    };

    if !output.borrow().is_empty() {
        output.borrow_mut().push_str("\n-- return --\n");
    }

    let ret = match value {
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
    let final_output = {
        let borrowed = output.borrow();
        borrowed.clone()
    };
    set_last_result(final_output)
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

#[allow(unused)]
fn main() {}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

#[cfg(test)]
#[path = "debug_test.rs"]
mod debug_test;
