use mlua::prelude::*;
use std::cell::RefCell;

fn main() {
    let output = RefCell::new(String::new());
    let lua = Lua::new();
    
    // Install print collector
    let buffer = output.clone();
    let print_fn = lua.create_function(move |_lua, values: Variadic<LuaValue>| {
        let mut parts = Vec::with_capacity(values.len());
        for v in values.iter() {
            parts.push(match v {
                LuaValue::Nil => "nil".to_string(),
                LuaValue::Boolean(b) => b.to_string(),
                LuaValue::Integer(i) => i.to_string(),
                LuaValue::Number(n) => n.to_string(),
                LuaValue::String(s) => match s.to_str() {
                    Ok(t) => t.to_string(),
                    Err(_) => "<invalid utf8>".to_string(),
                },
                _ => format!("{:?}", v),
            });
        }
        let line = parts.join("\t");
        buffer.borrow_mut().push_str(&line);
        buffer.borrow_mut().push('\n');
        Ok(())
    }).unwrap();
    
    lua.globals().set("print", print_fn).unwrap();
    
    // Run Lua code with print
    lua.load(r#"
print("Hello")
print("World", 123)
return "done"
    "#).eval::<LuaValue>().unwrap();
    
    println!("Output buffer: '{}'", output.borrow());
}
