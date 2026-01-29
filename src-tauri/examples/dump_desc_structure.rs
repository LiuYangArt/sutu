#![allow(clippy::unwrap_used, clippy::expect_used)]
//! ABR Descriptor Structure Dump
//!
//! 深入分析 desc section 的结构，打印完整的描述符树
//!
//! 用法: cd src-tauri && cargo run --example dump_desc_structure

use byteorder::{BigEndian, ReadBytesExt};
use std::collections::HashMap;
use std::io::{Cursor, Read, Seek, SeekFrom};

#[derive(Debug, Clone)]
enum DescriptorValue {
    Descriptor(HashMap<String, DescriptorValue>),
    List(Vec<DescriptorValue>),
    Double(f64),
    UnitFloat { unit: String, value: f64 },
    String(String),
    Boolean(bool),
    Integer(i32),
    LargeInteger(i64),
    Enum { type_id: String, value: String },
    Class { name: String, class_id: String },
    RawData(Vec<u8>),
    Reference,
}

fn read_key(cursor: &mut Cursor<&[u8]>) -> Result<String, String> {
    let len = cursor.read_u32::<BigEndian>().map_err(|e| e.to_string())?;
    if len == 0 {
        let mut key = [0u8; 4];
        cursor.read_exact(&mut key).map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&key).to_string())
    } else {
        let mut key = vec![0u8; len as usize];
        cursor.read_exact(&mut key).map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&key).to_string())
    }
}

fn read_type(cursor: &mut Cursor<&[u8]>) -> Result<String, String> {
    let mut type_id = [0u8; 4];
    cursor.read_exact(&mut type_id).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&type_id).to_string())
}

fn read_desc_unicode_string(cursor: &mut Cursor<&[u8]>) -> Result<String, String> {
    let len = cursor.read_u32::<BigEndian>().map_err(|e| e.to_string())?;
    let mut utf16 = Vec::with_capacity(len as usize);
    for _ in 0..len {
        utf16.push(cursor.read_u16::<BigEndian>().map_err(|e| e.to_string())?);
    }
    if let Some(&0) = utf16.last() {
        utf16.pop();
    }
    String::from_utf16(&utf16).map_err(|e| e.to_string())
}

fn parse_descriptor_with_info(
    cursor: &mut Cursor<&[u8]>,
) -> Result<(String, String, HashMap<String, DescriptorValue>), String> {
    let version = cursor.read_u32::<BigEndian>().map_err(|e| e.to_string())?;
    if version != 16 {
        return Err(format!("Unknown descriptor version: {}", version));
    }

    let name = read_desc_unicode_string(cursor)?;
    let class_id = read_key(cursor)?;

    let count = cursor.read_u32::<BigEndian>().map_err(|e| e.to_string())?;
    let mut items = HashMap::new();

    for _ in 0..count {
        let key = read_key(cursor)?;
        let value_type = read_type(cursor)?;
        if let Ok(value) = parse_value(cursor, &value_type) {
            items.insert(key, value);
        }
    }

    Ok((name, class_id, items))
}

fn parse_descriptor(
    cursor: &mut Cursor<&[u8]>,
) -> Result<HashMap<String, DescriptorValue>, String> {
    let (_, _, items) = parse_descriptor_with_info(cursor)?;
    Ok(items)
}

fn parse_value(cursor: &mut Cursor<&[u8]>, value_type: &str) -> Result<DescriptorValue, String> {
    match value_type {
        "Objc" | "GlbO" | "GlbC" => {
            let desc = parse_descriptor(cursor)?;
            Ok(DescriptorValue::Descriptor(desc))
        }
        "VlLs" => {
            let count = cursor.read_u32::<BigEndian>().map_err(|e| e.to_string())?;
            let mut list = Vec::new();
            for _ in 0..count {
                let item_type = read_type(cursor)?;
                if let Ok(v) = parse_value(cursor, &item_type) {
                    list.push(v);
                }
            }
            Ok(DescriptorValue::List(list))
        }
        "Doub" => Ok(DescriptorValue::Double(
            cursor.read_f64::<BigEndian>().map_err(|e| e.to_string())?,
        )),
        "UntF" => {
            let unit = read_type(cursor)?;
            let value = cursor.read_f64::<BigEndian>().map_err(|e| e.to_string())?;
            Ok(DescriptorValue::UnitFloat { unit, value })
        }
        "TEXT" => Ok(DescriptorValue::String(read_desc_unicode_string(cursor)?)),
        "bool" => Ok(DescriptorValue::Boolean(
            cursor.read_u8().map_err(|e| e.to_string())? != 0,
        )),
        "long" => Ok(DescriptorValue::Integer(
            cursor.read_i32::<BigEndian>().map_err(|e| e.to_string())?,
        )),
        "Comp" => Ok(DescriptorValue::LargeInteger(
            cursor.read_i64::<BigEndian>().map_err(|e| e.to_string())?,
        )),
        "enum" => {
            let type_id = read_key(cursor)?;
            let value = read_key(cursor)?;
            Ok(DescriptorValue::Enum { type_id, value })
        }
        "type" => {
            let name = read_desc_unicode_string(cursor)?;
            let class_id = read_key(cursor)?;
            Ok(DescriptorValue::Class { name, class_id })
        }
        "obj " => {
            let count = cursor.read_u32::<BigEndian>().map_err(|e| e.to_string())?;
            for _ in 0..count {
                let ref_type = read_type(cursor)?;
                match ref_type.as_str() {
                    "prop" => {
                        let _ = read_desc_unicode_string(cursor)?;
                        let _ = read_key(cursor)?;
                        let _ = read_key(cursor)?;
                    }
                    "Clss" => {
                        let _ = read_desc_unicode_string(cursor)?;
                        let _ = read_key(cursor)?;
                    }
                    "Enmr" => {
                        let _ = read_desc_unicode_string(cursor)?;
                        let _ = read_key(cursor)?;
                        let _ = read_key(cursor)?;
                        let _ = read_key(cursor)?;
                    }
                    _ => {}
                }
            }
            Ok(DescriptorValue::Reference)
        }
        "tdta" => {
            let len = cursor.read_u32::<BigEndian>().map_err(|e| e.to_string())?;
            let mut data = vec![0u8; len as usize];
            cursor.read_exact(&mut data).map_err(|e| e.to_string())?;
            Ok(DescriptorValue::RawData(data))
        }
        _ => Err(format!("Unknown type: {}", value_type)),
    }
}

/// 打印描述符树结构
fn print_descriptor_tree(desc: &HashMap<String, DescriptorValue>, indent: usize, max_depth: usize) {
    if indent > max_depth * 2 {
        let prefix = "  ".repeat(indent);
        println!("{}... (max depth reached)", prefix);
        return;
    }

    let prefix = "  ".repeat(indent);

    for (key, value) in desc {
        match value {
            DescriptorValue::Descriptor(nested) => {
                println!("{}├─ {} [Descriptor]", prefix, key);
                print_descriptor_tree(nested, indent + 1, max_depth);
            }
            DescriptorValue::List(list) => {
                println!("{}├─ {} [List, {} items]", prefix, key, list.len());
                if !list.is_empty() && indent < max_depth * 2 {
                    // Print first few items
                    for (i, item) in list.iter().take(3).enumerate() {
                        if let DescriptorValue::Descriptor(nested) = item {
                            println!("{}│  ├─ [{}] [Descriptor]", prefix, i);
                            print_descriptor_tree(nested, indent + 2, max_depth);
                        } else {
                            println!("{}│  ├─ [{}] {:?}", prefix, i, summarize_value(item));
                        }
                    }
                    if list.len() > 3 {
                        println!("{}│  └─ ... and {} more items", prefix, list.len() - 3);
                    }
                }
            }
            DescriptorValue::String(s) => {
                let display = if s.len() > 40 {
                    format!("{}...", &s[..40])
                } else {
                    s.clone()
                };
                println!("{}├─ {} = \"{}\"", prefix, key, display);
            }
            DescriptorValue::Double(v) => println!("{}├─ {} = {:.4}", prefix, key, v),
            DescriptorValue::UnitFloat { unit, value } => {
                println!("{}├─ {} = {:.4} ({})", prefix, key, value, unit);
            }
            DescriptorValue::Boolean(v) => println!("{}├─ {} = {}", prefix, key, v),
            DescriptorValue::Integer(v) => println!("{}├─ {} = {}", prefix, key, v),
            DescriptorValue::LargeInteger(v) => println!("{}├─ {} = {}", prefix, key, v),
            DescriptorValue::Enum { type_id, value } => {
                println!("{}├─ {} = {}::{}", prefix, key, type_id, value);
            }
            DescriptorValue::Class { name, class_id } => {
                println!("{}├─ {} = Class({}, {})", prefix, key, name, class_id);
            }
            DescriptorValue::RawData(data) => {
                println!("{}├─ {} = RawData({} bytes)", prefix, key, data.len());
            }
            DescriptorValue::Reference => {
                println!("{}├─ {} = Reference", prefix, key);
            }
        }
    }
}

fn summarize_value(value: &DescriptorValue) -> String {
    match value {
        DescriptorValue::String(s) => format!("\"{}\"", if s.len() > 20 { &s[..20] } else { s }),
        DescriptorValue::Double(v) => format!("{:.4}", v),
        DescriptorValue::Integer(v) => format!("{}", v),
        DescriptorValue::Boolean(v) => format!("{}", v),
        DescriptorValue::Enum { type_id, value } => format!("{}::{}", type_id, value),
        DescriptorValue::List(l) => format!("List[{}]", l.len()),
        DescriptorValue::Descriptor(_) => "Descriptor".to_string(),
        _ => "...".to_string(),
    }
}

/// 查找所有键名包含特定字符串的路径
fn find_keys_containing(
    desc: &HashMap<String, DescriptorValue>,
    target: &str,
    path: &str,
    results: &mut Vec<String>,
) {
    for (key, value) in desc {
        let new_path = if path.is_empty() {
            key.clone()
        } else {
            format!("{}.{}", path, key)
        };

        if key.to_lowercase().contains(&target.to_lowercase()) {
            results.push(format!("{} = {:?}", new_path, summarize_value(value)));
        }

        match value {
            DescriptorValue::Descriptor(nested) => {
                find_keys_containing(nested, target, &new_path, results);
            }
            DescriptorValue::List(list) => {
                for (i, item) in list.iter().enumerate() {
                    if let DescriptorValue::Descriptor(nested) = item {
                        find_keys_containing(
                            nested,
                            target,
                            &format!("{}[{}]", new_path, i),
                            results,
                        );
                    }
                }
            }
            _ => {}
        }
    }
}

fn main() {
    println!("═══════════════════════════════════════════════════════════════════════════");
    println!("  ABR Descriptor Structure Dump - 深入分析 desc section");
    println!("═══════════════════════════════════════════════════════════════════════════\n");

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    let data = match std::fs::read(&path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("错误: 无法读取文件: {}", e);
            std::process::exit(1);
        }
    };

    println!("📁 文件: {:?}\n", path);

    // Find desc section
    let mut cursor = Cursor::new(data.as_slice());
    cursor.seek(SeekFrom::Start(4)).ok(); // Skip ABR header

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

    let desc_data = match desc_data {
        Some(d) => d,
        None => {
            eprintln!("未找到 desc section");
            return;
        }
    };

    println!("✓ 找到 desc section: {} bytes\n", desc_data.len());

    // Parse descriptor with class info
    let mut cursor = Cursor::new(desc_data.as_slice());
    let (name, class_id, desc) = match parse_descriptor_with_info(&mut cursor) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("描述符解析失败: {}", e);
            return;
        }
    };

    println!("根描述符: Name='{}', ClassID='{}'\n", name, class_id);
    println!("顶级键: {:?}\n", desc.keys().collect::<Vec<_>>());

    // ========================================================================
    // 打印前几层的树结构
    // ========================================================================
    println!("═══════════════════════════════════════════════════════════════════════════");
    println!("  描述符树结构 (深度限制: 4)");
    println!("═══════════════════════════════════════════════════════════════════════════\n");

    print_descriptor_tree(&desc, 0, 4);

    // ========================================================================
    // 搜索关键键名
    // ========================================================================
    println!("\n═══════════════════════════════════════════════════════════════════════════");
    println!("  搜索关键键名");
    println!("═══════════════════════════════════════════════════════════════════════════\n");

    let search_terms = ["Txtr", "Ptrn", "Pttn", "Idnt", "PtNm", "text", "uuid"];

    for term in search_terms {
        let mut results = Vec::new();
        find_keys_containing(&desc, term, "", &mut results);

        if !results.is_empty() {
            println!("🔍 包含 '{}' 的键 ({} 个):", term, results.len());
            for (i, r) in results.iter().take(10).enumerate() {
                println!("   {}. {}", i + 1, r);
            }
            if results.len() > 10 {
                println!("   ... 还有 {} 个", results.len() - 10);
            }
            println!();
        }
    }

    // ========================================================================
    // 深入分析 Brsh 结构
    // ========================================================================
    println!("═══════════════════════════════════════════════════════════════════════════");
    println!("  深入分析 Brsh 结构");
    println!("═══════════════════════════════════════════════════════════════════════════\n");

    if let Some(DescriptorValue::List(brsh_list)) = desc.get("Brsh") {
        println!("Brsh 列表包含 {} 个元素\n", brsh_list.len());

        // 分析前3个brush对象
        for (i, item) in brsh_list.iter().take(3).enumerate() {
            if let DescriptorValue::Descriptor(brush) = item {
                println!("──── Brush #{} ────", i + 1);
                println!("键: {:?}\n", brush.keys().collect::<Vec<_>>());
                print_descriptor_tree(brush, 0, 5);
                println!();
            }
        }
    }

    // ========================================================================
    // 在原始字节中搜索 Txtr 字符串
    // ========================================================================
    println!("═══════════════════════════════════════════════════════════════════════════");
    println!("  在原始 desc section 中搜索 Txtr 字节");
    println!("═══════════════════════════════════════════════════════════════════════════\n");

    let txtr_bytes = b"Txtr";
    let mut found_positions = Vec::new();

    for i in 0..desc_data.len().saturating_sub(4) {
        if &desc_data[i..i + 4] == txtr_bytes {
            found_positions.push(i);
        }
    }

    if found_positions.is_empty() {
        println!("❌ 在 desc section 中未找到 'Txtr' 字节序列");
        println!("   这说明该 ABR 文件可能不包含 Texture 设置，");
        println!("   或者 Texture 设置使用了不同的键名。\n");
    } else {
        println!(
            "✓ 在 desc section 中找到 {} 处 'Txtr' 字节序列:",
            found_positions.len()
        );
        for (i, pos) in found_positions.iter().take(10).enumerate() {
            // Print context
            let start = pos.saturating_sub(20);
            let end = (*pos + 50).min(desc_data.len());
            let context = &desc_data[start..end];
            let ascii: String = context
                .iter()
                .map(|&b| {
                    if b.is_ascii_graphic() || b == b' ' {
                        b as char
                    } else {
                        '.'
                    }
                })
                .collect();
            println!("   {}. 偏移 {}: ...{}...", i + 1, pos, ascii);
        }
    }

    // ========================================================================
    // 搜索其他可能的texture相关键名
    // ========================================================================
    println!("\n═══════════════════════════════════════════════════════════════════════════");
    println!("  搜索其他可能的 Texture 相关字节序列");
    println!("═══════════════════════════════════════════════════════════════════════════\n");

    let texture_related = [
        (b"useTx" as &[u8], "useTx (Use Texture)"),
        (b"textureEnabled" as &[u8], "textureEnabled"),
        (b"pattern" as &[u8], "pattern"),
        (b"Ptrn" as &[u8], "Ptrn"),
        (b"Pttn" as &[u8], "Pttn"),
    ];

    for (bytes, name) in texture_related {
        let mut count = 0;
        for i in 0..desc_data.len().saturating_sub(bytes.len()) {
            if &desc_data[i..i + bytes.len()] == bytes {
                count += 1;
            }
        }
        if count > 0 {
            println!("✓ '{}': {} 处", name, count);
        } else {
            println!("  '{}': 未找到", name);
        }
    }

    println!("\n═══════════════════════════════════════════════════════════════════════════");
    println!("  分析完成");
    println!("═══════════════════════════════════════════════════════════════════════════");
}
