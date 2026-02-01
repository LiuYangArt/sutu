#![allow(warnings)]
//! 分析 ABR 文件中笔刷参数的导入情况
//!
//! 输出：
//! 1. 每个笔刷的基础参数 (Brush Tip Shape)
//! 2. Texture 参数
//! 3. Shape Dynamics 参数
//! 4. 原始描述符键值对

use byteorder::{BigEndian, ReadBytesExt};
use paintboard_lib::abr::descriptor::{parse_descriptor, DescriptorValue};
use paintboard_lib::abr::AbrParser;
use std::io::{Cursor, Read, Seek, SeekFrom};

fn main() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    println!("═══════════════════════════════════════════════════════════════════════════");
    println!("  ABR 笔刷参数分析器");
    println!("  文件: {:?}", path);
    println!("═══════════════════════════════════════════════════════════════════════════\n");

    let data = std::fs::read(&path).expect("Failed to read file");
    let abr = AbrParser::parse(&data).expect("Failed to parse ABR");

    println!(
        "解析结果: {} 个笔刷, {} 个纹理图案\n",
        abr.brushes.len(),
        abr.patterns.len()
    );

    // 1. 打印每个笔刷的当前参数
    println!("═══════════════════════════════════════════════════════════════════════════");
    println!("  当前导入的笔刷参数");
    println!("═══════════════════════════════════════════════════════════════════════════\n");

    for (i, brush) in abr.brushes.iter().enumerate() {
        println!("Brush #{}: '{}'", i, brush.name);
        println!("  UUID: {:?}", brush.uuid);
        println!("  === Brush Tip Shape ===");
        println!("    Diameter: {:.1}px", brush.diameter);
        println!("    Spacing: {:.0}%", brush.spacing * 100.0);
        println!("    Angle: {:.1}°", brush.angle);
        println!("    Roundness: {:.0}%", brush.roundness * 100.0);
        println!("    Hardness: {:?}", brush.hardness);
        println!("    Has Tip Image: {}", brush.tip_image.is_some());

        if let Some(ref dyn_) = brush.dynamics {
            println!("  === Shape Dynamics ===");
            println!("    Use Tip Dynamics: {}", dyn_.use_tip_dynamics);
            println!(
                "    Size Control: {} (0=Off, 2=Pressure)",
                dyn_.size_control
            );
            println!("    Size Jitter: {:.0}%", dyn_.size_jitter * 100.0);
            println!("    Size Minimum: {:.0}%", dyn_.size_minimum * 100.0);
            println!("    Angle Control: {}", dyn_.angle_control);
            println!("    Angle Jitter: {:.0}%", dyn_.angle_jitter * 100.0);
            println!("  === Scattering ===");
            println!("    Use Scatter: {}", dyn_.use_scatter);
            println!("    Scatter: {:.0}%", dyn_.scatter * 100.0);
            println!("    Scatter Count: {}", dyn_.scatter_count);
            println!("  === Transfer ===");
            println!("    Use Paint Dynamics: {}", dyn_.use_paint_dynamics);
            println!(
                "    Opacity Control: {} (0=Off, 2=Pressure)",
                dyn_.opacity_control
            );
            println!("    Opacity Jitter: {:.0}%", dyn_.opacity_jitter * 100.0);
        } else {
            println!("  === Dynamics: None ===");
        }

        if let Some(ref tex) = brush.texture_settings {
            println!("  === Texture ===");
            println!("    Enabled: {}", tex.enabled);
            println!("    Pattern ID: {:?}", tex.pattern_id);
            println!("    Pattern Name: {:?}", tex.pattern_name);
            println!("    Scale: {:.0}%", tex.scale);
            println!("    Brightness: {}", tex.brightness);
            println!("    Contrast: {}", tex.contrast);
            println!("    Mode: {:?}", tex.mode);
            println!("    Depth: {:.0}%", tex.depth);
            println!("    Minimum Depth: {:.0}%", tex.minimum_depth);
            println!("    Depth Jitter: {:.0}%", tex.depth_jitter);
            println!("    Texture Each Tip: {}", tex.texture_each_tip);
            println!("    Invert: {}", tex.invert);
            println!("    Depth Control: {}", tex.depth_control);
        } else {
            println!("  === Texture: None ===");
        }
        println!();
    }

    // 2. 分析原始描述符内容
    println!("═══════════════════════════════════════════════════════════════════════════");
    println!("  原始描述符分析 (desc section)");
    println!("═══════════════════════════════════════════════════════════════════════════\n");

    // 找到 desc section
    let desc_data = find_desc_section(&data);
    if desc_data.is_none() {
        println!("警告: 未找到 desc section");
        return;
    }

    let desc_data = desc_data.unwrap();
    println!("desc section 大小: {} bytes\n", desc_data.len());

    // 解析描述符
    match parse_descriptor(&mut Cursor::new(&desc_data)) {
        Ok(desc) => {
            // 找 Brsh 列表
            if let Some(DescriptorValue::List(brsh_list)) = desc.get("Brsh") {
                println!("找到 'Brsh' 列表: {} 个元素\n", brsh_list.len());

                for (i, item) in brsh_list.iter().enumerate() {
                    if let DescriptorValue::Descriptor(brush_desc) = item {
                        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                        println!("描述符 #{}", i);

                        // 笔刷名
                        if let Some(DescriptorValue::String(name)) = brush_desc.get("Nm  ") {
                            println!("  Name (Nm  ): '{}'", name);
                        }

                        // 打印所有顶级键
                        println!("  顶级键: {:?}", brush_desc.keys().collect::<Vec<_>>());

                        // 分析 Brsh 子对象 (笔刷核心参数)
                        if let Some(DescriptorValue::Descriptor(brsh)) = brush_desc.get("Brsh") {
                            println!("\n  [Brsh] 笔刷核心参数:");
                            print_descriptor_values(brsh, "    ");
                        }

                        // 分析 Txtr 子对象 (纹理参数)
                        if let Some(DescriptorValue::Descriptor(txtr)) = brush_desc.get("Txtr") {
                            println!("\n  [Txtr] 纹理参数:");
                            print_descriptor_values(txtr, "    ");
                        }

                        // 分析 ShDy 子对象 (Shape Dynamics)
                        if let Some(DescriptorValue::Descriptor(shdy)) = brush_desc.get("ShDy") {
                            println!("\n  [ShDy] Shape Dynamics:");
                            print_descriptor_values(shdy, "    ");
                        }
                        if let Some(DescriptorValue::Descriptor(shdy)) = brush_desc.get("szDy") {
                            println!("\n  [szDy] Size Dynamics:");
                            print_descriptor_values(shdy, "    ");
                        }

                        // 分析 Sctr 子对象 (Scattering)
                        if let Some(DescriptorValue::Descriptor(sctr)) = brush_desc.get("Sctr") {
                            println!("\n  [Sctr] Scattering:");
                            print_descriptor_values(sctr, "    ");
                        }

                        // 分析 paintDynamics (Transfer)
                        if let Some(DescriptorValue::Descriptor(pd)) = brush_desc.get("PntD") {
                            println!("\n  [PntD] Paint Dynamics (Transfer):");
                            print_descriptor_values(pd, "    ");
                        }
                        if let Some(DescriptorValue::Descriptor(pd)) = brush_desc.get("opDy") {
                            println!("\n  [opDy] Opacity Dynamics:");
                            print_descriptor_values(pd, "    ");
                        }
                        if let Some(DescriptorValue::Descriptor(pd)) = brush_desc.get("flDy") {
                            println!("\n  [flDy] Flow Dynamics:");
                            print_descriptor_values(pd, "    ");
                        }

                        // 分析 dualBrush 子对象 (Dual Brush)
                        if let Some(DescriptorValue::Descriptor(dual)) = brush_desc.get("dualBrush")
                        {
                            println!("\n  ★★★ [dualBrush] Dual Brush 参数 ★★★:");
                            print_descriptor_values(dual, "    ");
                            // 深度打印所有键
                            println!("\n  [dualBrush] 完整键列表:");
                            for (k, v) in dual {
                                print_value_deep(k, v, "    ");
                            }
                        }

                        // 检查 useDualBrush 布尔值
                        if let Some(DescriptorValue::Boolean(use_dual)) =
                            brush_desc.get("useDualBrush")
                        {
                            println!("\n  useDualBrush: {}", use_dual);
                        }

                        // sampledData UUID
                        if let Some(DescriptorValue::Descriptor(brsh_inner)) =
                            brush_desc.get("Brsh")
                        {
                            if let Some(DescriptorValue::String(uuid)) =
                                brsh_inner.get("sampledData")
                            {
                                println!("\n  sampledData UUID: '{}'", uuid);
                            }
                        }

                        println!();
                    }
                }
            } else {
                println!("未找到 'Brsh' 列表");
            }
        }
        Err(e) => {
            println!("解析描述符失败: {}", e);
        }
    }

    println!("═══════════════════════════════════════════════════════════════════════════");
    println!("  分析完成");
    println!("═══════════════════════════════════════════════════════════════════════════");
}

fn find_desc_section(data: &[u8]) -> Option<Vec<u8>> {
    let mut cursor = Cursor::new(data);
    cursor.seek(SeekFrom::Start(4)).ok()?;

    let data_len = data.len() as u64;

    while cursor.position() + 12 <= data_len {
        let pos = cursor.position();
        let mut signature = [0u8; 4];
        if cursor.read_exact(&mut signature).is_err() {
            break;
        }

        if &signature != b"8BIM" {
            cursor.seek(SeekFrom::Start(pos + 1)).ok();
            continue;
        }

        let mut tag = [0u8; 4];
        cursor.read_exact(&mut tag).ok()?;
        let tag_str = std::str::from_utf8(&tag).unwrap_or("????");

        let section_size = cursor.read_u32::<BigEndian>().ok()? as usize;

        if tag_str == "desc" {
            let mut section = vec![0u8; section_size];
            cursor.read_exact(&mut section).ok()?;
            return Some(section);
        } else {
            cursor.seek(SeekFrom::Current(section_size as i64)).ok();
            if section_size % 2 != 0 {
                cursor.seek(SeekFrom::Current(1)).ok();
            }
        }
    }
    None
}

fn print_descriptor_values(desc: &indexmap::IndexMap<String, DescriptorValue>, indent: &str) {
    for (key, value) in desc {
        match value {
            DescriptorValue::String(s) => {
                println!("{}{}: \"{}\"", indent, key, s.trim_end_matches('\0'));
            }
            DescriptorValue::Boolean(b) => {
                println!("{}{}: {}", indent, key, b);
            }
            DescriptorValue::Integer(i) => {
                println!("{}{}: {}", indent, key, i);
            }
            DescriptorValue::LargeInteger(i) => {
                println!("{}{}: {} (large)", indent, key, i);
            }
            DescriptorValue::Double(d) => {
                println!("{}{}: {:.2}", indent, key, d);
            }
            DescriptorValue::UnitFloat { unit, value } => {
                println!("{}{}: {:.2} ({})", indent, key, value, unit);
            }
            DescriptorValue::Enum { type_id, value: v } => {
                println!("{}{}: {}::{}", indent, key, type_id, v);
            }
            DescriptorValue::Descriptor(inner) => {
                println!("{}{}: [Descriptor]", indent, key);
                // 递归打印，但限制深度
                let new_indent = format!("{}  ", indent);
                for (k, v) in inner {
                    match v {
                        DescriptorValue::String(s) => {
                            println!("{}{}: \"{}\"", new_indent, k, s.trim_end_matches('\0'));
                        }
                        DescriptorValue::Boolean(b) => {
                            println!("{}{}: {}", new_indent, k, b);
                        }
                        DescriptorValue::Integer(i) => {
                            println!("{}{}: {}", new_indent, k, i);
                        }
                        DescriptorValue::UnitFloat { unit, value } => {
                            println!("{}{}: {:.2} ({})", new_indent, k, value, unit);
                        }
                        DescriptorValue::Enum { type_id, value: v } => {
                            println!("{}{}: {}::{}", new_indent, k, type_id, v);
                        }
                        _ => {
                            println!("{}{}: [complex value]", new_indent, k);
                        }
                    }
                }
            }
            DescriptorValue::List(items) => {
                println!("{}{}: [List with {} items]", indent, key, items.len());
            }
            DescriptorValue::RawData(data) => {
                println!("{}{}: [RawData {} bytes]", indent, key, data.len());
            }
            _ => {
                println!("{}{}: [other type]", indent, key);
            }
        }
    }
}

/// 深度递归打印描述符值，支持多级嵌套
fn print_value_deep(key: &str, value: &DescriptorValue, indent: &str) {
    match value {
        DescriptorValue::String(s) => {
            println!("{}{}: \"{}\"", indent, key, s.trim_end_matches('\0'));
        }
        DescriptorValue::Boolean(b) => {
            println!("{}{}: {}", indent, key, b);
        }
        DescriptorValue::Integer(i) => {
            println!("{}{}: {}", indent, key, i);
        }
        DescriptorValue::LargeInteger(i) => {
            println!("{}{}: {} (i64)", indent, key, i);
        }
        DescriptorValue::Double(d) => {
            println!("{}{}: {:.4}", indent, key, d);
        }
        DescriptorValue::UnitFloat { unit, value } => {
            println!("{}{}: {:.4} ({})", indent, key, value, unit);
        }
        DescriptorValue::Enum { type_id, value: v } => {
            println!("{}{}: {}::{}", indent, key, type_id, v);
        }
        DescriptorValue::Descriptor(inner) => {
            println!("{}{}: {{", indent, key);
            let new_indent = format!("{}  ", indent);
            for (k, v) in inner {
                print_value_deep(k, v, &new_indent);
            }
            println!("{}}}", indent);
        }
        DescriptorValue::List(items) => {
            println!("{}{}: [", indent, key);
            let new_indent = format!("{}  ", indent);
            for (i, item) in items.iter().enumerate() {
                print_value_deep(&format!("[{}]", i), item, &new_indent);
            }
            println!("{}]", indent);
        }
        DescriptorValue::RawData(data) => {
            println!("{}{}: [RawData {} bytes]", indent, key, data.len());
        }
        DescriptorValue::Class { name, class_id } => {
            println!("{}{}: Class({}, {})", indent, key, name, class_id);
        }
        DescriptorValue::Alias(s) => {
            println!("{}{}: Alias({})", indent, key, s);
        }
        DescriptorValue::Object { type_id, value } => {
            println!("{}{}: Object({}) {{", indent, key, type_id);
            let new_indent = format!("{}  ", indent);
            print_value_deep("value", value, &new_indent);
            println!("{}}}", indent);
        }
        DescriptorValue::Reference => {
            println!("{}{}: [Reference]", indent, key);
        }
    }
}
