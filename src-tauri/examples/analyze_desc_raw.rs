#![allow(clippy::unwrap_used, clippy::expect_used)]
#![allow(warnings)]
//! ABR Raw Desc Section Analyzer
//!
//! 直接分析 desc section 的原始字节，找出结构问题

use byteorder::{BigEndian, ReadBytesExt};
use std::io::{Cursor, Read, Seek, SeekFrom};

fn main() {
    println!("═══════════════════════════════════════════════════════════════════════════");
    println!("  ABR Raw Desc Section Analyzer");
    println!("═══════════════════════════════════════════════════════════════════════════\n");

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    let data = std::fs::read(&path).expect("Failed to read file");

    // Find desc section
    let mut cursor = Cursor::new(data.as_slice());
    cursor.seek(SeekFrom::Start(4)).ok();

    let mut desc_data: Option<Vec<u8>> = None;

    loop {
        let mut sig = [0u8; 4];
        if cursor.read_exact(&mut sig).is_err() {
            break;
        }
        if &sig != b"8BIM" {
            break;
        }

        let mut tag = [0u8; 4];
        if cursor.read_exact(&mut tag).is_err() {
            break;
        }
        let tag_str = std::str::from_utf8(&tag).unwrap_or("????");

        let size = cursor.read_u32::<BigEndian>().unwrap_or(0) as usize;

        if tag_str == "desc" {
            let mut section = vec![0u8; size];
            cursor.read_exact(&mut section).ok();
            desc_data = Some(section);
            break;
        } else {
            cursor.seek(SeekFrom::Current(size as i64)).ok();
            if size % 2 != 0 {
                cursor.seek(SeekFrom::Current(1)).ok();
            }
        }
    }

    let desc_data = desc_data.expect("No desc section found");
    println!("desc section 大小: {} bytes\n", desc_data.len());

    // 打印头部结构
    let mut cursor = Cursor::new(desc_data.as_slice());

    // version (4 bytes)
    let version = cursor.read_u32::<BigEndian>().unwrap();
    println!("Descriptor Version: {}", version);

    // name (unicode string)
    let name_len = cursor.read_u32::<BigEndian>().unwrap();
    println!("Name Length: {} chars", name_len);
    let mut name_utf16 = Vec::new();
    for _ in 0..name_len {
        name_utf16.push(cursor.read_u16::<BigEndian>().unwrap());
    }
    let name = String::from_utf16_lossy(&name_utf16);
    println!("Name: '{}'", name);

    // class ID
    let class_key_len = cursor.read_u32::<BigEndian>().unwrap();
    let class_id = if class_key_len == 0 {
        let mut key = [0u8; 4];
        cursor.read_exact(&mut key).ok();
        String::from_utf8_lossy(&key).to_string()
    } else {
        let mut key = vec![0u8; class_key_len as usize];
        cursor.read_exact(&mut key).ok();
        String::from_utf8_lossy(&key).to_string()
    };
    println!("Class ID: '{}'", class_id);

    // item count
    let count = cursor.read_u32::<BigEndian>().unwrap();
    println!("Item Count: {}\n", count);

    println!("═══════════════════════════════════════════════════════════════════════════");
    println!("  解析顶级项");
    println!("═══════════════════════════════════════════════════════════════════════════\n");

    // Parse each top-level item
    for i in 0..count {
        let item_start = cursor.position();

        // Key
        let key_len = cursor.read_u32::<BigEndian>().unwrap();
        let key = if key_len == 0 {
            let mut key = [0u8; 4];
            cursor.read_exact(&mut key).ok();
            String::from_utf8_lossy(&key).to_string()
        } else {
            let mut key = vec![0u8; key_len as usize];
            cursor.read_exact(&mut key).ok();
            String::from_utf8_lossy(&key).to_string()
        };

        // Type
        let mut type_id = [0u8; 4];
        cursor.read_exact(&mut type_id).ok();
        let type_str = String::from_utf8_lossy(&type_id).to_string();

        println!(
            "项 #{}: Key='{}', Type='{}' (offset={})",
            i, key, type_str, item_start
        );

        // 针对 VlLs (List) 类型进行深入分析
        if type_str == "VlLs" {
            let list_count = cursor.read_u32::<BigEndian>().unwrap();
            println!("  VlLs 包含 {} 个元素", list_count);

            // 分析前几个元素
            for j in 0..list_count.min(5) {
                let elem_pos = cursor.position();

                let mut elem_type = [0u8; 4];
                cursor.read_exact(&mut elem_type).ok();
                let elem_type_str = String::from_utf8_lossy(&elem_type).to_string();

                println!(
                    "    元素 #{}: Type='{}' (offset={})",
                    j, elem_type_str, elem_pos
                );

                if elem_type_str == "Objc" {
                    // 这是一个对象，需要解析其 descriptor
                    let inner_version = cursor.read_u32::<BigEndian>().unwrap();
                    if inner_version != 16 {
                        println!("      ⚠️ 意外的版本号: {} (期望 16)", inner_version);
                    }

                    let inner_name_len = cursor.read_u32::<BigEndian>().unwrap();
                    let mut inner_name_utf16 = Vec::new();
                    for _ in 0..inner_name_len {
                        inner_name_utf16.push(cursor.read_u16::<BigEndian>().unwrap());
                    }
                    let inner_name = String::from_utf16_lossy(&inner_name_utf16);

                    let inner_class_len = cursor.read_u32::<BigEndian>().unwrap();
                    let inner_class = if inner_class_len == 0 {
                        let mut key = [0u8; 4];
                        cursor.read_exact(&mut key).ok();
                        String::from_utf8_lossy(&key).to_string()
                    } else {
                        let mut key = vec![0u8; inner_class_len as usize];
                        cursor.read_exact(&mut key).ok();
                        String::from_utf8_lossy(&key).to_string()
                    };

                    let inner_count = cursor.read_u32::<BigEndian>().unwrap();

                    println!(
                        "      Objc: Name='{}', Class='{}', {} items",
                        inner_name, inner_class, inner_count
                    );

                    // 打印该对象的所有键
                    let mut keys = Vec::new();
                    for _ in 0..inner_count.min(50) {
                        let _key_start = cursor.position();

                        let k_len = cursor.read_u32::<BigEndian>().unwrap_or(0);
                        let k = if k_len == 0 {
                            let mut key = [0u8; 4];
                            if cursor.read_exact(&mut key).is_err() {
                                break;
                            }
                            String::from_utf8_lossy(&key).to_string()
                        } else {
                            let mut key = vec![0u8; k_len as usize];
                            if cursor.read_exact(&mut key).is_err() {
                                break;
                            }
                            String::from_utf8_lossy(&key).to_string()
                        };
                        keys.push(k);

                        // Skip value (we just want keys for now)
                        let mut v_type = [0u8; 4];
                        if cursor.read_exact(&mut v_type).is_err() {
                            break;
                        }
                        let v_type_str = String::from_utf8_lossy(&v_type);

                        // Skip value data based on type
                        match v_type_str.as_ref() {
                            "bool" => {
                                cursor.read_u8().ok();
                            }
                            "long" => {
                                cursor.read_i32::<BigEndian>().ok();
                            }
                            "doub" | "Doub" => {
                                cursor.read_f64::<BigEndian>().ok();
                            }
                            "UntF" => {
                                cursor.seek(SeekFrom::Current(4)).ok(); // unit
                                cursor.read_f64::<BigEndian>().ok();
                            }
                            "TEXT" => {
                                let len = cursor.read_u32::<BigEndian>().unwrap_or(0);
                                cursor.seek(SeekFrom::Current(len as i64 * 2)).ok();
                            }
                            "enum" => {
                                // type_id
                                let len = cursor.read_u32::<BigEndian>().unwrap_or(0);
                                if len == 0 {
                                    cursor.seek(SeekFrom::Current(4)).ok();
                                } else {
                                    cursor.seek(SeekFrom::Current(len as i64)).ok();
                                }
                                // value
                                let len = cursor.read_u32::<BigEndian>().unwrap_or(0);
                                if len == 0 {
                                    cursor.seek(SeekFrom::Current(4)).ok();
                                } else {
                                    cursor.seek(SeekFrom::Current(len as i64)).ok();
                                }
                            }
                            "Objc" | "GlbO" => {
                                // Recursively skip - for now just print that we hit nested
                                println!(
                                    "        (nested Objc at key '{}', skipping analysis)",
                                    keys.last().unwrap_or(&"?".to_string())
                                );
                                // We can't easily skip without full parsing
                                break;
                            }
                            "VlLs" => {
                                let list_len = cursor.read_u32::<BigEndian>().unwrap_or(0);
                                println!(
                                    "        (nested VlLs[{}] at key '{}', skipping)",
                                    list_len,
                                    keys.last().unwrap_or(&"?".to_string())
                                );
                                break;
                            }
                            "tdta" => {
                                let len = cursor.read_u32::<BigEndian>().unwrap_or(0);
                                cursor.seek(SeekFrom::Current(len as i64)).ok();
                            }
                            "obj " => {
                                println!(
                                    "        (reference at key '{}', skipping)",
                                    keys.last().unwrap_or(&"?".to_string())
                                );
                                break;
                            }
                            _ => {
                                println!(
                                    "        ⚠️ 未知类型 '{}' at key '{}'",
                                    v_type_str,
                                    keys.last().unwrap_or(&"?".to_string())
                                );
                                break;
                            }
                        }
                    }

                    println!("      Keys: {:?}", keys);
                } else {
                    println!("      (非 Objc 类型，需要不同处理)");
                    // Skip based on type
                    match elem_type_str.as_str() {
                        "bool" => {
                            cursor.read_u8().ok();
                        }
                        "long" => {
                            cursor.read_i32::<BigEndian>().ok();
                        }
                        _ => {}
                    }
                }
            }

            if list_count > 5 {
                println!("    ... 还有 {} 个元素", list_count - 5);
            }
        }
    }

    // 找第一个 Txtr 的位置并分析周围结构
    println!("\n═══════════════════════════════════════════════════════════════════════════");
    println!("  分析第一个 Txtr 的上下文");
    println!("═══════════════════════════════════════════════════════════════════════════\n");

    let txtr_bytes = b"Txtr";
    for i in 0..desc_data.len().saturating_sub(4) {
        if &desc_data[i..i + 4] == txtr_bytes {
            println!("找到 Txtr 在偏移 {}", i);

            // 向前找 context
            let start = i.saturating_sub(100);
            println!("\n前 100 字节 (ASCII 可打印字符):");
            let before = &desc_data[start..i];
            let mut readable = String::new();
            for b in before {
                if b.is_ascii_graphic() || *b == b' ' {
                    readable.push(*b as char);
                } else if readable.ends_with('.') || readable.is_empty() {
                    readable.push('.');
                } else {
                    readable.push('.');
                }
            }
            println!("{}", readable);

            // 向后找 context
            let end = (i + 200).min(desc_data.len());
            println!("\n后 200 字节 (ASCII 可打印字符):");
            let after = &desc_data[i..end];
            let mut readable = String::new();
            for b in after {
                if b.is_ascii_graphic() || *b == b' ' {
                    readable.push(*b as char);
                } else if readable.ends_with('.') || readable.is_empty() {
                    readable.push('.');
                } else {
                    readable.push('.');
                }
            }
            println!("{}", readable);

            // 从 Txtr 位置开始尝试解析
            println!("\n尝试从 Txtr 位置解析:");
            let mut tcursor = Cursor::new(&desc_data[i..]);

            // Txtr 是 key name (4 bytes)
            let mut key = [0u8; 4];
            tcursor.read_exact(&mut key).ok();
            println!("Key: '{}'", String::from_utf8_lossy(&key));

            // 下一个应该是 type (4 bytes)
            let mut type_id = [0u8; 4];
            tcursor.read_exact(&mut type_id).ok();
            println!("Type: '{}'", String::from_utf8_lossy(&type_id));

            if &type_id == b"Objc" {
                // 这是一个对象
                let ver = tcursor.read_u32::<BigEndian>().unwrap_or(0);
                println!("Objc Version: {} (expected 16)", ver);

                let name_len = tcursor.read_u32::<BigEndian>().unwrap_or(0);
                println!("Name Len: {}", name_len);

                let mut name_utf16 = Vec::new();
                for _ in 0..name_len {
                    name_utf16.push(tcursor.read_u16::<BigEndian>().unwrap_or(0));
                }
                let name = String::from_utf16_lossy(&name_utf16);
                println!("Name: '{}'", name);

                let class_len = tcursor.read_u32::<BigEndian>().unwrap_or(0);
                let class_id = if class_len == 0 {
                    let mut key = [0u8; 4];
                    tcursor.read_exact(&mut key).ok();
                    String::from_utf8_lossy(&key).to_string()
                } else {
                    let mut key = vec![0u8; class_len as usize];
                    tcursor.read_exact(&mut key).ok();
                    String::from_utf8_lossy(&key).to_string()
                };
                println!("Class ID: '{}'", class_id);

                let item_count = tcursor.read_u32::<BigEndian>().unwrap_or(0);
                println!("Item Count: {}", item_count);

                // 读取所有键
                for j in 0..item_count.min(20) {
                    let k_len = tcursor.read_u32::<BigEndian>().unwrap_or(0);
                    let k = if k_len == 0 {
                        let mut key = [0u8; 4];
                        if tcursor.read_exact(&mut key).is_err() {
                            break;
                        }
                        String::from_utf8_lossy(&key).to_string()
                    } else {
                        let mut key = vec![0u8; k_len as usize];
                        if tcursor.read_exact(&mut key).is_err() {
                            break;
                        }
                        String::from_utf8_lossy(&key).to_string()
                    };

                    let mut v_type = [0u8; 4];
                    if tcursor.read_exact(&mut v_type).is_err() {
                        break;
                    }
                    let v_type_str = String::from_utf8_lossy(&v_type);

                    print!("  Item {}: Key='{}', Type='{}'", j, k, v_type_str);

                    // 读取值
                    match v_type_str.as_ref() {
                        "TEXT" => {
                            let len = tcursor.read_u32::<BigEndian>().unwrap_or(0);
                            let mut utf16 = Vec::new();
                            for _ in 0..len {
                                utf16.push(tcursor.read_u16::<BigEndian>().unwrap_or(0));
                            }
                            let s = String::from_utf16_lossy(&utf16);
                            println!(", Value='{}'", s.trim_end_matches('\0'));
                        }
                        "UntF" => {
                            let mut unit = [0u8; 4];
                            tcursor.read_exact(&mut unit).ok();
                            let val = tcursor.read_f64::<BigEndian>().unwrap_or(0.0);
                            println!(", Value={:.2} ({})", val, String::from_utf8_lossy(&unit));
                        }
                        "bool" => {
                            let val = tcursor.read_u8().unwrap_or(0);
                            println!(", Value={}", val != 0);
                        }
                        "long" => {
                            let val = tcursor.read_i32::<BigEndian>().unwrap_or(0);
                            println!(", Value={}", val);
                        }
                        "enum" => {
                            // type_id
                            let len = tcursor.read_u32::<BigEndian>().unwrap_or(0);
                            let tid = if len == 0 {
                                let mut key = [0u8; 4];
                                tcursor.read_exact(&mut key).ok();
                                String::from_utf8_lossy(&key).to_string()
                            } else {
                                let mut key = vec![0u8; len as usize];
                                tcursor.read_exact(&mut key).ok();
                                String::from_utf8_lossy(&key).to_string()
                            };
                            // value
                            let len = tcursor.read_u32::<BigEndian>().unwrap_or(0);
                            let val = if len == 0 {
                                let mut key = [0u8; 4];
                                tcursor.read_exact(&mut key).ok();
                                String::from_utf8_lossy(&key).to_string()
                            } else {
                                let mut key = vec![0u8; len as usize];
                                tcursor.read_exact(&mut key).ok();
                                String::from_utf8_lossy(&key).to_string()
                            };
                            println!(", Value={}::{}", tid, val);
                        }
                        _ => {
                            println!(" (stop - can't skip type)");
                            break;
                        }
                    }
                }
            }

            break; // Only analyze first Txtr
        }
    }

    println!("\n═══════════════════════════════════════════════════════════════════════════");
    println!("  分析完成");
    println!("═══════════════════════════════════════════════════════════════════════════");
}
