#![allow(warnings)]
//! ABR Pattern Association Test Tool - Enhanced Version
//!
//! 测试脚本：诊断笔刷与 Pattern 之间的关联问题
//!
//! 这个版本增加了对 desc section 的解析支持，因为 ABR v6 Tool Preset
//! 格式可能将笔刷配置存储在全局 desc section 而非每个笔刷内部。
//!
//! 用法: cd src-tauri && cargo run --example test_pattern_association

use byteorder::{BigEndian, ReadBytesExt};
use std::collections::HashMap;
use std::io::{Cursor, Read, Seek, SeekFrom};

// ============================================================================
// Pattern Parsing (from patt.rs)
// ============================================================================

#[derive(Debug, Clone)]
struct PatternResource {
    name: String,
    id: String,
    width: u32,
    height: u32,
    mode: u32,
}

impl PatternResource {
    fn mode_name(&self) -> &'static str {
        match self.mode {
            0 => "Bitmap",
            1 => "Grayscale",
            2 => "Indexed",
            3 => "RGB",
            4 => "CMYK",
            7 => "Multichannel",
            8 => "Duotone",
            9 => "Lab",
            _ => "Unknown",
        }
    }
}

fn read_unicode_string(cursor: &mut Cursor<&[u8]>) -> Result<String, String> {
    let len = cursor.read_u32::<BigEndian>().map_err(|e| e.to_string())? as usize;
    if len == 0 || len > 1000 {
        return Ok(String::new());
    }

    let mut utf16_data = Vec::with_capacity(len);
    for _ in 0..len {
        let ch = cursor.read_u16::<BigEndian>().map_err(|e| e.to_string())?;
        utf16_data.push(ch);
    }

    String::from_utf16(&utf16_data).map_err(|e| e.to_string())
}

fn read_pascal_string(cursor: &mut Cursor<&[u8]>) -> Result<String, String> {
    let len = cursor.read_u8().map_err(|e| e.to_string())? as usize;
    if len == 0 || len > 100 {
        return Ok(String::new());
    }
    let mut bytes = vec![0u8; len];
    cursor.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    if len % 2 == 0 {
        cursor.seek(SeekFrom::Current(1)).ok();
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

fn parse_pattern(data: &[u8]) -> Result<(PatternResource, usize), String> {
    if data.len() < 30 {
        return Err("数据不足".to_string());
    }

    let pattern_size = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;

    if pattern_size < 40 || pattern_size > 5_000_000 {
        return Err(format!("无效的 pattern 大小: {}", pattern_size));
    }

    if pattern_size > data.len() {
        return Err(format!("Pattern 大小超过可用数据"));
    }

    let pattern_data = &data[4..pattern_size];
    let mut cursor = Cursor::new(pattern_data);

    let version = cursor.read_u32::<BigEndian>().map_err(|e| e.to_string())?;
    if version != 1 {
        return Err(format!("不支持的版本: {}", version));
    }

    let mode = cursor.read_u32::<BigEndian>().map_err(|e| e.to_string())?;
    let width = cursor.read_u16::<BigEndian>().map_err(|e| e.to_string())? as u32;
    let height = cursor.read_u16::<BigEndian>().map_err(|e| e.to_string())? as u32;

    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err(format!("无效尺寸: {}x{}", width, height));
    }

    let name = read_unicode_string(&mut cursor)?;
    if name.is_empty() {
        return Err("名称为空".to_string());
    }

    let id = read_pascal_string(&mut cursor).unwrap_or_default();

    let aligned_size = (pattern_size + 3) & !3;

    Ok((
        PatternResource {
            name,
            id,
            width,
            height,
            mode,
        },
        aligned_size,
    ))
}

fn parse_patterns_from_patt_section(data: &[u8]) -> Vec<PatternResource> {
    let mut patterns = Vec::new();
    let mut offset: usize = 0;

    while offset + 30 <= data.len() {
        if offset + 4 > data.len() {
            break;
        }
        let size = u32::from_be_bytes([
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ]) as usize;

        if size < 40 || size > 2_000_000 || offset + size > data.len() {
            offset += 1;
            continue;
        }

        match parse_pattern(&data[offset..]) {
            Ok((pattern, consumed)) => {
                patterns.push(pattern);
                offset += consumed;
            }
            Err(_) => {
                offset += 1;
            }
        }

        if patterns.len() > 500 {
            break;
        }
    }

    patterns
}

// ============================================================================
// Descriptor Parsing (enhanced version)
// ============================================================================

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

fn parse_descriptor(
    cursor: &mut Cursor<&[u8]>,
) -> Result<HashMap<String, DescriptorValue>, String> {
    let version = cursor.read_u32::<BigEndian>().map_err(|e| e.to_string())?;
    if version != 16 {
        return Err(format!("Unknown descriptor version: {}", version));
    }

    let _name = read_desc_unicode_string(cursor)?;
    let _class_id = read_key(cursor)?;

    let count = cursor.read_u32::<BigEndian>().map_err(|e| e.to_string())?;
    let mut items = HashMap::new();

    for _ in 0..count {
        let key = read_key(cursor)?;
        let value_type = read_type(cursor)?;
        if let Ok(value) = parse_value(cursor, &value_type) {
            items.insert(key, value);
        }
    }

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

// ============================================================================
// 8BIM Section Utilities
// ============================================================================

struct Section8BIM {
    name: String,
    offset: usize,
    size: usize,
}

fn scan_8bim_sections(data: &[u8]) -> Vec<Section8BIM> {
    let mut sections = Vec::new();
    let mut cursor = Cursor::new(data);
    let data_len = data.len() as u64;

    // Skip ABR header (4 bytes)
    cursor.seek(SeekFrom::Start(4)).ok();

    while cursor.position() + 12 <= data_len {
        let block_start = cursor.position();
        let mut signature = [0u8; 4];
        if cursor.read_exact(&mut signature).is_err() {
            break;
        }

        if &signature != b"8BIM" {
            break;
        }

        let mut tag = [0u8; 4];
        if cursor.read_exact(&mut tag).is_err() {
            break;
        }
        let tag_str = std::str::from_utf8(&tag).unwrap_or("????").to_string();

        let section_size = match cursor.read_u32::<BigEndian>() {
            Ok(s) => s as usize,
            Err(_) => break,
        };

        let data_offset = cursor.position() as usize;

        sections.push(Section8BIM {
            name: tag_str,
            offset: data_offset,
            size: section_size,
        });

        // Move to next section
        let next_pos = data_offset + section_size;
        if next_pos >= data.len() {
            break;
        }
        cursor.seek(SeekFrom::Start(next_pos as u64)).ok();

        // Handle odd-length sections (padding byte)
        if section_size % 2 != 0 && (cursor.position() as usize) < data.len() {
            cursor.seek(SeekFrom::Current(1)).ok();
        }
    }

    sections
}

// ============================================================================
// Texture Reference Finder - Recursively search for Txtr in descriptors
// ============================================================================

#[derive(Debug)]
struct TextureReference {
    path: String, // Where we found it (e.g., "Tool Preset.Txtr")
    pattern_uuid: Option<String>,
    pattern_name: Option<String>,
    scale: Option<f64>,
    depth: Option<f64>,
}

fn find_texture_refs_in_descriptor(
    desc: &HashMap<String, DescriptorValue>,
    path: &str,
    refs: &mut Vec<TextureReference>,
) {
    for (key, value) in desc {
        let new_path = if path.is_empty() {
            key.clone()
        } else {
            format!("{}.{}", path, key)
        };

        // Check if this is a Txtr descriptor
        if key == "Txtr" {
            if let DescriptorValue::Descriptor(txtr) = value {
                let mut tex_ref = TextureReference {
                    path: new_path.clone(),
                    pattern_uuid: None,
                    pattern_name: None,
                    scale: None,
                    depth: None,
                };

                if let Some(DescriptorValue::String(id)) = txtr.get("Idnt") {
                    tex_ref.pattern_uuid = Some(id.clone());
                }
                if let Some(DescriptorValue::String(name)) = txtr.get("PtNm") {
                    tex_ref.pattern_name = Some(name.clone());
                }
                if let Some(DescriptorValue::UnitFloat { value, .. }) = txtr.get("Scl ") {
                    tex_ref.scale = Some(*value);
                }
                if let Some(DescriptorValue::UnitFloat { value, .. }) = txtr.get("Dpth") {
                    tex_ref.depth = Some(*value);
                }

                if tex_ref.pattern_uuid.is_some() || tex_ref.pattern_name.is_some() {
                    refs.push(tex_ref);
                }
            }
        }

        // Recurse into nested structures
        match value {
            DescriptorValue::Descriptor(nested) => {
                find_texture_refs_in_descriptor(nested, &new_path, refs);
            }
            DescriptorValue::List(list) => {
                for (i, item) in list.iter().enumerate() {
                    if let DescriptorValue::Descriptor(nested) = item {
                        find_texture_refs_in_descriptor(
                            nested,
                            &format!("{}[{}]", new_path, i),
                            refs,
                        );
                    }
                }
            }
            _ => {}
        }
    }
}

fn sep_line(ch: char, len: usize) -> String {
    std::iter::repeat(ch).take(len).collect()
}

fn main() {
    println!("╔════════════════════════════════════════════════════════════════════════════╗");
    println!("║       ABR Pattern Association Diagnosis Tool (Enhanced v2)                ║");
    println!("╚════════════════════════════════════════════════════════════════════════════╝");
    println!();

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    let data = match std::fs::read(&path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("错误: 无法读取文件 '{}': {}", path.display(), e);
            std::process::exit(1);
        }
    };

    println!("📁 文件: {:?}", path);
    println!(
        "📊 大小: {} bytes ({:.2} MB)\n",
        data.len(),
        data.len() as f64 / (1024.0 * 1024.0)
    );

    // Get ABR version info
    let version = u16::from_be_bytes([data[0], data[1]]);
    let subversion = u16::from_be_bytes([data[2], data[3]]);
    println!("📋 ABR Version: {}, Subversion: {}\n", version, subversion);

    let sep = sep_line('═', 80);
    let dash = sep_line('─', 80);

    // ========================================================================
    // Step 1: Scan all 8BIM sections
    // ========================================================================
    println!("{}", sep);
    println!("📂 Phase 1: Scanning 8BIM Sections");
    println!("{}", sep);

    let sections = scan_8bim_sections(&data);

    println!("\n找到 {} 个 8BIM section:\n", sections.len());
    println!("{:4} {:10} {:>12} {:>12}", "#", "Name", "Offset", "Size");
    println!("{}", dash);

    for (i, section) in sections.iter().enumerate() {
        println!(
            "{:4} {:10} {:>12} {:>12} ({:.2} KB)",
            i + 1,
            section.name,
            section.offset,
            section.size,
            section.size as f64 / 1024.0
        );
    }

    // ========================================================================
    // Step 2: Parse patt section
    // ========================================================================
    println!("\n{}", sep);
    println!("📦 Phase 2: Parsing Pattern Resources (patt section)");
    println!("{}", sep);

    let patt_section = sections.iter().find(|s| s.name == "patt");
    let patterns = match patt_section {
        Some(section) => {
            let patt_data = &data[section.offset..section.offset + section.size];
            println!("\n✓ 找到 patt section: {} bytes\n", section.size);
            parse_patterns_from_patt_section(patt_data)
        }
        None => {
            println!("\n✗ 未找到 patt section");
            Vec::new()
        }
    };

    println!("提取到 {} 个 Pattern 资源:\n", patterns.len());
    println!(
        "{:4} {:30} {:40} {:10}",
        "#", "Name", "ID (Pascal String)", "Size"
    );
    println!("{}", dash);

    for (i, p) in patterns.iter().enumerate() {
        let id_display = if p.id.is_empty() {
            "(empty)".to_string()
        } else {
            format!("'{}'", p.id)
        };
        println!(
            "{:4} {:30} {:40} {}x{} ({})",
            i + 1,
            if p.name.len() > 28 {
                &p.name[..28]
            } else {
                &p.name
            },
            if id_display.len() > 38 {
                &id_display[..38]
            } else {
                &id_display
            },
            p.width,
            p.height,
            p.mode_name()
        );
    }

    // Build lookup tables
    let pattern_by_id: HashMap<String, &PatternResource> = patterns
        .iter()
        .filter(|p| !p.id.is_empty())
        .map(|p| (p.id.clone(), p))
        .collect();

    let pattern_by_name: HashMap<String, &PatternResource> =
        patterns.iter().map(|p| (p.name.clone(), p)).collect();

    // ========================================================================
    // Step 3: Parse desc section for Tool Preset descriptors
    // ========================================================================
    println!("\n{}", sep);
    println!("� Phase 3: Parsing Global Descriptor (desc section)");
    println!("{}", sep);

    let desc_section = sections.iter().find(|s| s.name == "desc");
    let mut texture_refs: Vec<TextureReference> = Vec::new();

    match desc_section {
        Some(section) => {
            println!("\n✓ 找到 desc section: {} bytes\n", section.size);
            let desc_data = &data[section.offset..section.offset + section.size];
            let mut cursor = Cursor::new(desc_data);

            match parse_descriptor(&mut cursor) {
                Ok(desc) => {
                    println!("成功解析全局描述符!");
                    println!("顶级键: {:?}\n", desc.keys().collect::<Vec<_>>());

                    // Recursively find all Txtr references
                    find_texture_refs_in_descriptor(&desc, "", &mut texture_refs);

                    println!("找到 {} 个 Texture 引用:\n", texture_refs.len());
                }
                Err(e) => {
                    println!("⚠️ 描述符解析失败: {}", e);
                }
            }
        }
        None => {
            println!("\n✗ 未找到 desc section");
            println!("  这可能意味着笔刷是简单格式，Texture 设置嵌入在每个笔刷内部。");
        }
    }

    // Also try parsing descriptors from samp section
    let samp_section = sections.iter().find(|s| s.name == "samp");
    let brush_count = if let Some(section) = samp_section {
        println!("\n{}", sep);
        println!("🖌️  Phase 3b: Scanning Brush Descriptors in samp section");
        println!("{}", sep);

        let samp_data = &data[section.offset..section.offset + section.size];
        let mut cursor = Cursor::new(samp_data);
        let section_end = section.size as u64;
        let mut count = 0usize;
        let mut found_descriptors = 0usize;

        while cursor.position() < section_end {
            let Ok(brush_size) = cursor.read_u32::<BigEndian>() else {
                break;
            };
            let aligned_size = (brush_size + 3) & !3;
            let brush_start = cursor.position();
            let next_brush = brush_start + aligned_size as u64;

            if next_brush > section_end || aligned_size == 0 {
                break;
            }

            count += 1;

            // Try to find descriptor at various offsets
            // Skip header bytes (varies by subversion)
            let skip = if subversion == 1 { 37 + 10 } else { 37 + 264 };

            // Read bounds to estimate image size
            cursor.seek(SeekFrom::Start(brush_start + skip as u64)).ok();

            let bounds_ok = cursor.read_i32::<BigEndian>().is_ok()  // top
                && cursor.read_i32::<BigEndian>().is_ok()  // left
                && cursor.read_i32::<BigEndian>().is_ok()  // bottom
                && cursor.read_i32::<BigEndian>().is_ok(); // right

            if bounds_ok {
                let _ = cursor.read_u16::<BigEndian>(); // depth
                let _ = cursor.read_u8(); // compression

                // Try to parse descriptor from remaining bytes
                let current = cursor.position();
                if current < next_brush {
                    // Look for descriptor version marker (0x00000010 = 16)
                    let remaining_start = current as usize;
                    let remaining_end =
                        ((next_brush - 4) as usize).min(section.offset + section.size);

                    if remaining_start < remaining_end {
                        let remaining = &samp_data[remaining_start..];

                        // Scan for descriptor signature
                        for scan_offset in 0..remaining.len().saturating_sub(100) {
                            if remaining.len() > scan_offset + 4 {
                                let maybe_version = u32::from_be_bytes([
                                    remaining[scan_offset],
                                    remaining[scan_offset + 1],
                                    remaining[scan_offset + 2],
                                    remaining[scan_offset + 3],
                                ]);

                                if maybe_version == 16 {
                                    // Try parsing descriptor here
                                    let mut desc_cursor = Cursor::new(&remaining[scan_offset..]);
                                    if let Ok(desc) = parse_descriptor(&mut desc_cursor) {
                                        find_texture_refs_in_descriptor(
                                            &desc,
                                            &format!("Brush[{}]", count),
                                            &mut texture_refs,
                                        );
                                        found_descriptors += 1;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            cursor.seek(SeekFrom::Start(next_brush)).ok();
        }

        println!(
            "\n扫描了 {} 个笔刷，成功解析 {} 个描述符\n",
            count, found_descriptors
        );
        count
    } else {
        0
    };

    // ========================================================================
    // Step 4: Match Analysis
    // ========================================================================
    println!("\n{}", sep);
    println!("🔗 Phase 4: Association Resolution Analysis");
    println!("{}", sep);

    if texture_refs.is_empty() {
        println!("\n⚠️ 未找到任何 Texture 引用!");
        println!("   可能的原因:");
        println!("   1. ABR 文件不包含 Texture 设置");
        println!("   2. Texture 信息存储在不支持的格式中");
        println!("   3. 描述符解析未覆盖所有可能的位置");
    } else {
        println!("\n{:4} {:30} {:40}", "#", "Path", "Pattern Reference");
        println!("{}", dash);

        let mut resolved_by_id = 0;
        let mut resolved_by_name = 0;
        let mut unresolved = 0;

        for (i, tex_ref) in texture_refs.iter().enumerate() {
            let mut status = "❌ UNRESOLVED";
            let mut resolution = String::new();

            if let Some(ref uuid) = tex_ref.pattern_uuid {
                if let Some(p) = pattern_by_id.get(uuid) {
                    status = "✓ UUID";
                    resolution = format!("-> '{}'", p.name);
                    resolved_by_id += 1;
                } else if let Some(ref pname) = tex_ref.pattern_name {
                    if pattern_by_name.contains_key(pname) {
                        status = "⚡ NAME";
                        resolution = format!(
                            "UUID '{}' miss, Name '{}' ok",
                            &uuid[..uuid.len().min(16)],
                            pname
                        );
                        resolved_by_name += 1;
                    } else {
                        resolution = format!("UUID: {} Name: {}", uuid, pname);
                        unresolved += 1;
                    }
                } else {
                    resolution = format!("UUID only: {}", uuid);
                    unresolved += 1;
                }
            } else if let Some(ref pname) = tex_ref.pattern_name {
                if pattern_by_name.contains_key(pname) {
                    status = "⚡ NAME";
                    resolution = format!("Name '{}' found", pname);
                    resolved_by_name += 1;
                } else {
                    resolution = format!("Name '{}' not found", pname);
                    unresolved += 1;
                }
            } else {
                resolution = "No reference info".to_string();
                unresolved += 1;
            }

            println!(
                "{:4} {:30} {:12} {}",
                i + 1,
                if tex_ref.path.len() > 28 {
                    &tex_ref.path[..28]
                } else {
                    &tex_ref.path
                },
                status,
                resolution
            );
        }

        println!(
            "\n统计: {} UUID匹配, {} 名称回退, {} 未解决",
            resolved_by_id, resolved_by_name, unresolved
        );
    }

    // ========================================================================
    // Summary
    // ========================================================================
    println!("\n{}", sep);
    println!("📊 Summary");
    println!("{}", sep);

    println!("\n╭───────────────────────────────────────────────────────────────╮");
    println!(
        "│ 8BIM Sections: {:3}                                           │",
        sections.len()
    );
    println!(
        "│ Pattern Resources: {:3} (ID有效: {:3})                         │",
        patterns.len(),
        patterns.iter().filter(|p| !p.id.is_empty()).count()
    );
    println!(
        "│ Brush Count: {:3}                                              │",
        brush_count
    );
    println!(
        "│ Texture References Found: {:3}                                 │",
        texture_refs.len()
    );
    println!("╰───────────────────────────────────────────────────────────────╯");

    // Diagnosis
    println!("\n{}", sep);
    println!("🔍 Diagnosis");
    println!("{}", sep);

    if texture_refs.is_empty() && sections.iter().any(|s| s.name == "desc") {
        println!("\n⚠️  CRITICAL ISSUE: desc section exists but no Texture references found!");
        println!("   The global Action Descriptor likely contains Tool Preset definitions,");
        println!("   but our parser may not be finding the correct path to Txtr settings.");
        println!("\n💡 NEXT STEPS:");
        println!("   1. Hex dump the desc section to analyze structure");
        println!("   2. Check for 'Txtr' bytes in the raw data");
        println!("   3. Look for VlLs (list) that may contain brush preset objects");
    } else if texture_refs.is_empty() {
        println!("\n✓ No textures references expected - this ABR likely has shape-only brushes.");
    } else {
        println!("\n✓ Texture references found - check resolution status above");
    }

    println!("\n{}", sep);
    println!("✅ Analysis Complete!");
    println!("{}", sep);
}
