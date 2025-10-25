#[cfg(test)]
mod debug_test {
    use crate::install_print_collector;
    use mlua::prelude::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    #[test]
    fn test_print_directly() {
        let output = Rc::new(RefCell::new(String::new()));
        let lua = Lua::new();
        
        // 测试 buffer 是否可以正常工作
        {
            output.borrow_mut().push_str("Test write\n");
            println!("=== After manual write: '{}'", output.borrow());
        }
        
        // 安装 print collector
        install_print_collector(&lua, &output).unwrap();
        
        // 检查 print 是否被正确设置
        let print_type: String = lua.load("return type(print)").eval().unwrap();
        println!("=== Type of print: {}", print_type);
        
        // 尝试直接调用 print
        lua.load(r#"print("Direct call test")"#).exec().unwrap();
        println!("=== After direct print call: '{}'", output.borrow());
        
        // 直接运行 Lua 代码
        let result = lua.load(r#"
print("Debug: Hello from Lua")
print("Debug: Line 2", 123)
return "done"
        "#).eval::<LuaValue>();
        
        println!("=== Lua execution result: {:?}", result);
        println!("=== Output buffer content: '{}'", output.borrow());
        println!("=== Output buffer length: {}", output.borrow().len());
        
        let output_str = output.borrow().clone();
        assert!(output_str.contains("Debug: Hello from Lua"), 
            "Buffer should contain first print, got: '{}'", output_str);
    }

    #[test]
    fn test_full_lua_run_flow() {
        let code_str = r#"
print("Flow test: First line")
print("Flow test: Second", 456)
return "result"
"#;
        
        // 模拟完整流程
        let output = Rc::new(RefCell::new(String::new()));
        let lua = Lua::new();
        
        println!("=== Before install_print_collector");
        install_print_collector(&lua, &output).unwrap();
        println!("=== After install_print_collector");
        
        println!("=== Before load and eval");
        let value = lua.load(code_str).set_name("input").eval::<LuaValue>().unwrap();
        println!("=== After load and eval");
        
        println!("=== Output buffer: '{}'", output.borrow());
        println!("=== Return value: {:?}", value);
        
        let buffer_content = output.borrow().clone();
        assert!(buffer_content.contains("Flow test: First line"), 
            "Buffer should contain prints, got: '{}'", buffer_content);
    }
}
