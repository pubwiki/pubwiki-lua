#[cfg(test)]
mod tests {
    use crate::{lua_run, lua_free_result};
    use std::ffi::{CStr, CString, c_char, c_uchar};

    // 模拟 WASM 导入函数（测试时不需要实际实现）
    #[no_mangle]
    extern "C" fn fetch_lua_module(_url_ptr: *const c_char, len_out: *mut u32) -> *const c_uchar {
        unsafe {
            *len_out = 0;
        }
        std::ptr::null()
    }

    #[no_mangle]
    extern "C" fn free_lua_module(_ptr: *const c_uchar, _len: u32) {}

    #[no_mangle]
    extern "C" fn get_last_fetch_error(len_out: *mut u32) -> *const c_uchar {
        unsafe {
            *len_out = 0;
        }
        std::ptr::null()
    }

    #[test]
    fn test_print_basic() {
        let code = CString::new(r#"
print("Hello from Lua!")
return "test complete"
"#).unwrap();

        let result_ptr = lua_run(code.as_ptr());
        assert!(!result_ptr.is_null(), "Result pointer should not be null");

        let result = unsafe { CStr::from_ptr(result_ptr).to_string_lossy().into_owned() };
        
        println!("=== Test Output ===");
        println!("{}", result);
        println!("===================");

        // 验证输出包含 print 的内容
        assert!(result.contains("Hello from Lua!"), 
            "Output should contain printed text, but got: {}", result);
        
        // 验证返回值也在输出中
        assert!(result.contains("test complete"), 
            "Output should contain return value, but got: {}", result);

        // 清理
        lua_free_last(result_ptr);
    }

    #[test]
    fn test_print_multiple_values() {
        let code = CString::new(r#"
print("Line 1")
print("Value:", 123, true, nil)
return 42
"#).unwrap();

        let result_ptr = lua_run(code.as_ptr());
        let result = unsafe { CStr::from_ptr(result_ptr).to_string_lossy().into_owned() };
        
        println!("=== Test Output ===");
        println!("{}", result);
        println!("===================");

        assert!(result.contains("Line 1"), "Should contain first print");
        assert!(result.contains("Value:"), "Should contain second print");
        assert!(result.contains("123"), "Should contain number");
        assert!(result.contains("true"), "Should contain boolean");
        assert!(result.contains("42"), "Should contain return value");

        lua_free_last(result_ptr);
    }

    #[test]
    fn test_print_with_return_separator() {
        let code = CString::new(r#"
print("Before return")
return "after"
"#).unwrap();

        let result_ptr = lua_run(code.as_ptr());
        let result = unsafe { CStr::from_ptr(result_ptr).to_string_lossy().into_owned() };
        
        println!("=== Test Output ===");
        println!("{}", result);
        println!("===================");

        // 应该包含 print 输出
        assert!(result.contains("Before return"), "Should contain print output");
        
        // 应该包含分隔符
        assert!(result.contains("-- return --"), "Should contain separator");
        
        // 应该包含返回值
        assert!(result.contains("after"), "Should contain return value");

        lua_free_last(result_ptr);
    }

    #[test]
    fn test_print_without_return() {
        let code = CString::new(r#"
print("Only print, no explicit return")
"#).unwrap();

        let result_ptr = lua_run(code.as_ptr());
        let result = unsafe { CStr::from_ptr(result_ptr).to_string_lossy().into_owned() };
        
        println!("=== Test Output ===");
        println!("{}", result);
        println!("===================");

        assert!(result.contains("Only print, no explicit return"), 
            "Should contain print output");

        lua_free_last(result_ptr);
    }

    #[test]
    fn test_multiple_prints() {
        let code = CString::new(r#"
for i = 1, 3 do
    print("Iteration", i)
end
return "done"
"#).unwrap();

        let result_ptr = lua_run(code.as_ptr());
        let result = unsafe { CStr::from_ptr(result_ptr).to_string_lossy().into_owned() };
        
        println!("=== Test Output ===");
        println!("{}", result);
        println!("===================");

        assert!(result.contains("Iteration"), "Should contain print from loop");
        assert!(result.contains("1"), "Should contain first iteration");
        assert!(result.contains("2"), "Should contain second iteration");
        assert!(result.contains("3"), "Should contain third iteration");

        lua_free_last(result_ptr);
    }

    #[test]
    fn test_io_write_basic() {
        let code = CString::new(r#"
io.write("Hello from io.write!")
return "test complete"
"#).unwrap();

        let result_ptr = lua_run(code.as_ptr());
        assert!(!result_ptr.is_null(), "Result pointer should not be null");

        let result = unsafe { CStr::from_ptr(result_ptr).to_string_lossy().into_owned() };
        
        println!("=== Test Output ===");
        println!("{}", result);
        println!("===================");

        // 验证输出包含 io.write 的内容
        assert!(result.contains("Hello from io.write!"), 
            "Output should contain io.write text, but got: {}", result);
        
        // 验证返回值也在输出中
        assert!(result.contains("test complete"), 
            "Output should contain return value, but got: {}", result);

        // 清理
        lua_free_last(result_ptr);
    }

    #[test]
    fn test_io_write_multiple_values() {
        let code = CString::new(r#"
io.write("Part 1", " ", "Part 2", " ", 123)
return "done"
"#).unwrap();

        let result_ptr = lua_run(code.as_ptr());
        let result = unsafe { CStr::from_ptr(result_ptr).to_string_lossy().into_owned() };
        
        println!("=== Test Output ===");
        println!("{}", result);
        println!("===================");

        assert!(result.contains("Part 1 Part 2 123"), 
            "Should contain concatenated io.write output, but got: {}", result);

        lua_free_last(result_ptr);
    }

    #[test]
    fn test_io_write_no_newline() {
        let code = CString::new(r#"
io.write("Line1")
io.write("Line2")
return "done"
"#).unwrap();

        let result_ptr = lua_run(code.as_ptr());
        let result = unsafe { CStr::from_ptr(result_ptr).to_string_lossy().into_owned() };
        
        println!("=== Test Output ===");
        println!("{}", result);
        println!("===================");

        // io.write 不会自动添加换行，所以应该连在一起
        assert!(result.contains("Line1Line2"), 
            "io.write should not add newlines, but got: {}", result);

        lua_free_last(result_ptr);
    }

    #[test]
    fn test_print_and_io_write_mixed() {
        let code = CString::new(r#"
print("From print")
io.write("From io.write")
print("Another print")
return "done"
"#).unwrap();

        let result_ptr = lua_run(code.as_ptr());
        let result = unsafe { CStr::from_ptr(result_ptr).to_string_lossy().into_owned() };
        
        println!("=== Test Output ===");
        println!("{}", result);
        println!("===================");

        assert!(result.contains("From print"), "Should contain print output");
        assert!(result.contains("From io.write"), "Should contain io.write output");
        assert!(result.contains("Another print"), "Should contain second print");

        lua_free_last(result_ptr);
    }
}
