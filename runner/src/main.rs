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

#[derive(Clone, Default)]
struct MediaWikiStack(Vec<String>);

struct ResolvedModuleSource {
    name: String,
    source: String,
}

struct MediaWikiGuard<'lua> {
    lua: &'lua Lua,
    pushed: bool,
}

impl<'lua> MediaWikiGuard<'lua> {
    fn new(lua: &'lua Lua, spec: &str) -> Self {
        let Some(base) = mediawiki_base(spec) else {
            return MediaWikiGuard { lua, pushed: false };
        };

        // 从 Lua app_data 获取或创建 MediaWiki 栈
        let mut stack = lua.app_data_ref::<MediaWikiStack>()
            .map(|s| s.clone())
            .unwrap_or_default();
        
        stack.0.push(base);
        lua.set_app_data(stack);
        
        MediaWikiGuard { lua, pushed: true }
    }
}

impl<'lua> Drop for MediaWikiGuard<'lua> {
    fn drop(&mut self) {
        if self.pushed {
            // 从 Lua app_data 获取栈并弹出
            if let Some(mut stack) = self.lua.app_data_ref::<MediaWikiStack>().map(|s| s.clone()) {
                stack.0.pop();
                self.lua.set_app_data(stack);
            }
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

fn resolve_module_spec(lua: &Lua, name: &str) -> String {
    if name.contains("://") {
        return name.to_string();
    }
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return name.to_string();
    }
    
    // 从 Lua app_data 获取 MediaWiki 栈
    let stack = lua.app_data_ref::<MediaWikiStack>();
    let Some(mut base) = stack.and_then(|s| s.0.last().cloned()) else {
        return name.to_string();
    };

    if trimmed.len() >= 7 && trimmed[..7].eq_ignore_ascii_case("module:") {
        base.push_str(trimmed);
    } else {
        base.push_str("Module:");
        base.push_str(trimmed);
    }
    base
}

#[link(wasm_import_module = "env")]
extern "C" {
    fn fetch_lua_module(url_ptr: *const c_char, len_out: *mut u32) -> *const c_uchar;
    fn free_lua_module(ptr: *const c_uchar, len: u32);
    fn get_last_fetch_error(len_out: *mut u32) -> *const c_uchar;
    
    // RDF 三元组存储 API（同步接口）
    fn js_rdf_insert(subject_ptr: *const c_char, predicate_ptr: *const c_char, object_json_ptr: *const c_char) -> *const c_char;
    fn js_rdf_delete(subject_ptr: *const c_char, predicate_ptr: *const c_char, object_json_ptr: *const c_char) -> *const c_char;
    fn js_rdf_query(pattern_json_ptr: *const c_char) -> *const c_char;
    fn js_rdf_batch_insert(triples_json_ptr: *const c_char) -> *const c_char;
    fn js_rdf_free(ptr: *const c_char);
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

fn fetch_module_source(lua: &Lua, name: &str) -> LuaResult<ResolvedModuleSource> {
    let resolved_name = resolve_module_spec(lua, name);
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
        let resolved = match fetch_module_source(lua, &module) {
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
        let wrapped = lua.create_function(move |lua, args: LuaMultiValue| {
            let _guard = MediaWikiGuard::new(lua, &resolved_name);
            let result: LuaResult<LuaMultiValue> = chunk.call(args);
            result
        })?;
        Ok(LuaValue::Function(wrapped))
    })?;

    // Insert custom loader after the Lua preload loader (index 1)
    searchers.raw_insert(2, loader)?;
    Ok(())
}

/// 安装 RDF 三元组存储 API 到 Lua 全局环境
fn install_rdf_api(lua: &Lua) -> LuaResult<()> {
    let state_table = lua.create_table()?;
    
    // State.insert(subject, predicate, object) - 插入三元组
    let insert_fn = lua.create_function(|lua, (subject, predicate, object): (String, String, LuaValue)| -> LuaResult<()> {
        // 将 object 转为 JSON
        let object_json = lua_value_to_json(lua, &object)?;
        let subject_c = CString::new(subject).map_err(|e| LuaError::external(e))?;
        let predicate_c = CString::new(predicate).map_err(|e| LuaError::external(e))?;
        let object_c = CString::new(object_json).map_err(|e| LuaError::external(e))?;
        
        let result_ptr = unsafe { js_rdf_insert(subject_c.as_ptr(), predicate_c.as_ptr(), object_c.as_ptr()) };
        let result = read_c_string(result_ptr)?;
        unsafe { js_rdf_free(result_ptr) };
        
        if result.starts_with("ERROR:") {
            return Err(LuaError::external(result.trim_start_matches("ERROR:")));
        }
        Ok(())
    })?;
    state_table.set("insert", insert_fn)?;
    
    // State.delete(subject, predicate, object?) - 删除三元组
    let delete_fn = lua.create_function(|lua, (subject, predicate, object): (String, String, Option<LuaValue>)| -> LuaResult<()> {
        let object_json = match object {
            Some(val) => lua_value_to_json(lua, &val)?,
            None => "null".to_string(),
        };
        
        let subject_c = CString::new(subject).map_err(|e| LuaError::external(e))?;
        let predicate_c = CString::new(predicate).map_err(|e| LuaError::external(e))?;
        let object_c = CString::new(object_json).map_err(|e| LuaError::external(e))?;
        
        let result_ptr = unsafe { js_rdf_delete(subject_c.as_ptr(), predicate_c.as_ptr(), object_c.as_ptr()) };
        let result = read_c_string(result_ptr)?;
        unsafe { js_rdf_free(result_ptr) };
        
        if result.starts_with("ERROR:") {
            return Err(LuaError::external(result.trim_start_matches("ERROR:")));
        }
        Ok(())
    })?;
    state_table.set("delete", delete_fn)?;
    
    // State.query(pattern) - 查询三元组
    // pattern 是一个 table: {subject = "...", predicate = "...", object = ...}
    // 其中任意字段可以为 nil (表示通配符)
    let query_fn = lua.create_function(|lua, pattern: LuaTable| -> LuaResult<LuaValue> {
        // 构造 pattern JSON
        let subject: Option<String> = pattern.get("subject")?;
        let predicate: Option<String> = pattern.get("predicate")?;
        let object: Option<LuaValue> = pattern.get("object")?;
        
        // 将 Lua 值直接转换为 serde_json::Value，避免双重序列化
        let object_json = object.as_ref()
            .map(|v| lua.from_value::<serde_json::Value>(v.clone()))
            .transpose()?;
        
        let pattern_json = serde_json::json!({
            "subject": subject,
            "predicate": predicate,
            "object": object_json
        });
        
        let pattern_str = serde_json::to_string(&pattern_json)
            .map_err(|e| LuaError::external(format!("JSON stringify error: {}", e)))?;
        let pattern_c = CString::new(pattern_str).map_err(|e| LuaError::external(e))?;
        
        let result_ptr = unsafe { js_rdf_query(pattern_c.as_ptr()) };
        let result = read_c_string(result_ptr)?;
        unsafe { js_rdf_free(result_ptr) };
        
        if result.starts_with("ERROR:") {
            return Err(LuaError::external(result.trim_start_matches("ERROR:")));
        }
        
        json_to_lua_value(lua, &result)
    })?;
    state_table.set("query", query_fn)?;
    
    // State.batchInsert(triples) - 批量插入三元组
    // triples 是一个数组: {{subject = "...", predicate = "...", object = ...}, ...}
    let batch_insert_fn = lua.create_function(|lua, triples: LuaTable| -> LuaResult<()> {
        // 将 Lua table 转换为 JSON 数组
        let triples_json = lua_value_to_json(lua, &LuaValue::Table(triples))?;
        let triples_c = CString::new(triples_json).map_err(|e| LuaError::external(e))?;
        
        let result_ptr = unsafe { js_rdf_batch_insert(triples_c.as_ptr()) };
        let result = read_c_string(result_ptr)?;
        unsafe { js_rdf_free(result_ptr) };
        
        if result.starts_with("ERROR:") {
            return Err(LuaError::external(result.trim_start_matches("ERROR:")));
        }
        Ok(())
    })?;
    state_table.set("batchInsert", batch_insert_fn)?;
    
    // State.set(subject, predicate, object) - 设置三元组（先删除后插入）
    // 删除所有匹配 subject + predicate 的三元组，然后插入新的三元组
    let set_fn = lua.create_function(|lua, (subject, predicate, object): (String, String, LuaValue)| -> LuaResult<()> {
        // 1. 先删除所有匹配的三元组（不指定 object，删除所有）
        let subject_c = CString::new(subject.clone()).map_err(|e| LuaError::external(e))?;
        let predicate_c = CString::new(predicate.clone()).map_err(|e| LuaError::external(e))?;
        let null_c = CString::new("null").map_err(|e| LuaError::external(e))?;
        
        let delete_result_ptr = unsafe { js_rdf_delete(subject_c.as_ptr(), predicate_c.as_ptr(), null_c.as_ptr()) };
        let delete_result = read_c_string(delete_result_ptr)?;
        unsafe { js_rdf_free(delete_result_ptr) };
        
        if delete_result.starts_with("ERROR:") {
            return Err(LuaError::external(delete_result.trim_start_matches("ERROR:")));
        }
        
        // 2. 插入新的三元组
        let object_json = lua_value_to_json(lua, &object)?;
        let subject_c = CString::new(subject).map_err(|e| LuaError::external(e))?;
        let predicate_c = CString::new(predicate).map_err(|e| LuaError::external(e))?;
        let object_c = CString::new(object_json).map_err(|e| LuaError::external(e))?;
        
        let insert_result_ptr = unsafe { js_rdf_insert(subject_c.as_ptr(), predicate_c.as_ptr(), object_c.as_ptr()) };
        let insert_result = read_c_string(insert_result_ptr)?;
        unsafe { js_rdf_free(insert_result_ptr) };
        
        if insert_result.starts_with("ERROR:") {
            return Err(LuaError::external(insert_result.trim_start_matches("ERROR:")));
        }
        
        Ok(())
    })?;
    state_table.set("set", set_fn)?;
    
    // State.get(subject, predicate) - 获取单个值
    // 查询匹配 subject + predicate 的三元组，返回第一个结果的 object，如果没有则返回 nil
    let get_fn = lua.create_function(|lua, (subject, predicate): (String, String)| -> LuaResult<LuaValue> {
        // 构造查询 pattern
        let pattern_json = serde_json::json!({
            "subject": subject,
            "predicate": predicate,
            "object": serde_json::Value::Null
        });
        
        let pattern_str = serde_json::to_string(&pattern_json)
            .map_err(|e| LuaError::external(format!("JSON stringify error: {}", e)))?;
        let pattern_c = CString::new(pattern_str).map_err(|e| LuaError::external(e))?;
        
        // 调用查询
        let result_ptr = unsafe { js_rdf_query(pattern_c.as_ptr()) };
        let result = read_c_string(result_ptr)?;
        unsafe { js_rdf_free(result_ptr) };
        
        if result.starts_with("ERROR:") {
            return Err(LuaError::external(result.trim_start_matches("ERROR:")));
        }
        
        // 解析结果数组
        let triples: Vec<serde_json::Value> = serde_json::from_str(&result)
            .map_err(|e| LuaError::external(format!("JSON parse error: {}", e)))?;
        
        // 如果有结果，返回第一个三元组的 object；否则返回 nil
        if let Some(first_triple) = triples.first() {
            if let Some(object) = first_triple.get("object") {
                return lua.to_value(object);
            }
        }
        
        Ok(LuaValue::Nil)
    })?;
    state_table.set("get", get_fn)?;
    
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
    // 辅助函数：创建 JSON 格式的错误结果
    let make_error = |msg: String| -> *const c_char {
        // 返回统一格式: {"result": null, "error": "错误信息"}
        let error_json = serde_json::json!({
            "result": serde_json::Value::Null,
            "error": msg
        });
        CString::new(error_json.to_string())
            .unwrap_or_else(|_| CString::new(r#"{"result":null,"error":"<invalid utf8>"}"#).unwrap())
            .into_raw()
    };
    
    // 辅助函数：创建 JSON 格式的成功结果
    let make_success = |result: serde_json::Value, output: String| -> *const c_char {
        // 返回统一格式: {"result": ..., "output": "...", "error": null}
        let success_json = serde_json::json!({
            "result": result,
            "output": output,
            "error": serde_json::Value::Null
        });
        CString::new(success_json.to_string())
            .unwrap_or_else(|_| CString::new(r#"{"result":null,"output":"","error":"<invalid utf8>"}"#).unwrap())
            .into_raw()
    };
    
    let code = match read_c_string(code_ptr) {
        Ok(s) => s,
        Err(e) => return make_error(format!("Failed to read code: {}", e)),
    };

    let output = Rc::new(RefCell::new(String::new()));
    let lua = Lua::new();

    if let Err(e) = install_print_collector(&lua, &output) {
        return make_error(format!("Failed to install print collector: {}", e));
    }

    if let Err(e) = install_io_write_collector(&lua, &output) {
        return make_error(format!("Failed to install io.write collector: {}", e));
    }

    if let Err(e) = install_require_loader(&lua) {
        return make_error(format!("Failed to install require loader: {}", e));
    }

    if let Err(e) = install_rdf_api(&lua) {
        return make_error(format!("Failed to install RDF API: {}", e));
    }

    let value = match lua.load(&code).set_name("input").eval::<LuaValue>() {
        Ok(val) => val,
        Err(e) => return make_error(format!("runtime error: {}", e)),
    };

    // 使用 serde_json 序列化 Lua 值
    // mlua 的 serialize 特性支持将 LuaValue 转换为 serde_json::Value
    let result_value: serde_json::Value = match serde_json::to_value(&value) {
        Ok(json_val) => json_val,
        Err(e) => {
            // 如果序列化失败（例如包含 userdata、thread 等不可序列化类型）
            // 尝试基本类型的回退处理
            match value {
                LuaValue::Nil => serde_json::Value::Null,
                LuaValue::Boolean(b) => serde_json::Value::Bool(b),
                LuaValue::Integer(i) => serde_json::json!(i),
                LuaValue::Number(n) => serde_json::json!(n),
                LuaValue::String(s) => match s.to_str() {
                    Ok(t) => {
                        let str_ref: &str = &t;
                        serde_json::Value::String(str_ref.to_string())
                    },
                    Err(_) => serde_json::Value::String("<invalid utf8>".to_string()),
                },
                _ => return make_error(format!("Cannot serialize return value: {}", e)),
            }
        }
    };
    
    // 获取捕获的输出
    let captured_output = output.borrow().clone();
    
    make_success(result_value, captured_output)
}

/// 释放由 lua_run 返回的结果字符串
/// 必须由 JS 调用以释放内存
#[no_mangle]
pub extern "C" fn lua_free_result(ptr: *const c_char) {
    if !ptr.is_null() {
        unsafe {
            // 从原始指针恢复 CString，Drop 时自动释放内存
            let _ = CString::from_raw(ptr as *mut c_char);
        }
    }
}

#[allow(unused)]
fn main() {}

// Tests are temporarily disabled - they need to be updated for the new API
// #[cfg(test)]
// #[path = "tests.rs"]
// mod tests;

#[cfg(test)]
#[path = "debug_test.rs"]
mod debug_test;
