#![allow(warnings)]
//! 分析 ABR 文件中 Dual Brush Size 的存储方式
//!
//! 目标：验证 Dual Brush Size 是存储绝对值还是相对主笔刷的比例

use byteorder::{BigEndian, ReadBytesExt};
use std::io::{Cursor, Read, Seek, SeekFrom};
use sutu_lib::abr::descriptor::{parse_descriptor, DescriptorValue};
use sutu_lib::abr::AbrParser;

fn main() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    println!("═══════════════════════════════════════════════════════════════════════════");
    println!("  Dual Brush Size 分析器");
    println!("  文件: {:?}", path);
    println!("═══════════════════════════════════════════════════════════════════════════\n");

    let data = std::fs::read(&path).expect("Failed to read file");

    // 找到 desc section
    let desc_data = find_desc_section(&data);
    if desc_data.is_none() {
        println!("警告: 未找到 desc section");
        return;
    }

    let desc_data = desc_data.unwrap();

    // 解析描述符
    match parse_descriptor(&mut Cursor::new(&desc_data)) {
        Ok(desc) => {
            // 找 Brsh 列表
            if let Some(DescriptorValue::List(brsh_list)) = desc.get("Brsh") {
                println!("找到 'Brsh' 列表: {} 个元素\n", brsh_list.len());

                println!("┌────────────────────────────────────────────────────────────────────────────┐");
                println!(
                    "│ 笔刷名                           │ 主尺寸(px) │ Dual尺寸(px) │ 比例(%)    │"
                );
                println!("├────────────────────────────────────────────────────────────────────────────┤");

                let mut dual_brush_count = 0;

                for (i, item) in brsh_list.iter().enumerate() {
                    if let DescriptorValue::Descriptor(brush_desc) = item {
                        // 检查是否启用 dual brush - useDualBrush 在 dualBrush 描述符内部
                        let use_dual_brush = if let Some(DescriptorValue::Descriptor(dual_desc)) =
                            brush_desc.get("dualBrush")
                        {
                            matches!(
                                dual_desc.get("useDualBrush"),
                                Some(DescriptorValue::Boolean(true))
                            )
                        } else {
                            false
                        };

                        if !use_dual_brush {
                            continue;
                        }

                        dual_brush_count += 1;

                        // 笔刷名
                        let name = brush_desc
                            .get("Nm  ")
                            .and_then(|v| {
                                if let DescriptorValue::String(s) = v {
                                    Some(s.trim_end_matches('\0').to_string())
                                } else {
                                    None
                                }
                            })
                            .unwrap_or_else(|| format!("Brush {}", i));

                        // 主笔刷尺寸
                        let mut main_size = 0.0f64;
                        if let Some(DescriptorValue::Descriptor(brsh)) = brush_desc.get("Brsh") {
                            if let Some(DescriptorValue::UnitFloat { value, .. }) = brsh.get("Dmtr")
                            {
                                main_size = *value;
                            }
                        }

                        // Dual Brush 尺寸
                        let mut dual_size = 0.0f64;
                        if let Some(DescriptorValue::Descriptor(dual_desc)) =
                            brush_desc.get("dualBrush")
                        {
                            if let Some(DescriptorValue::Descriptor(dual_brsh)) =
                                dual_desc.get("Brsh")
                            {
                                if let Some(DescriptorValue::UnitFloat { value, .. }) =
                                    dual_brsh.get("Dmtr")
                                {
                                    dual_size = *value;
                                }
                            }
                        }

                        // 计算比例
                        let ratio = if main_size > 0.0 {
                            (dual_size / main_size) * 100.0
                        } else {
                            0.0
                        };

                        // 截断长名称
                        let display_name: String = if name.len() > 32 {
                            format!("{}...", &name[..29])
                        } else {
                            name.clone()
                        };

                        println!(
                            "│ {:32} │ {:10.1} │ {:12.1} │ {:10.1} │",
                            display_name, main_size, dual_size, ratio
                        );
                    }
                }

                println!("└────────────────────────────────────────────────────────────────────────────┘");
                println!("\n共 {} 个笔刷启用了 Dual Brush\n", dual_brush_count);

                // 再次遍历，打印一些详细的 descriptor 键名来确认数据结构
                println!(
                    "═══════════════════════════════════════════════════════════════════════════"
                );
                println!("  前 3 个 Dual Brush 的详细 descriptor 结构");
                println!(
                    "═══════════════════════════════════════════════════════════════════════════\n"
                );

                let mut detail_count = 0;
                for (i, item) in brsh_list.iter().enumerate() {
                    if detail_count >= 3 {
                        break;
                    }

                    if let DescriptorValue::Descriptor(brush_desc) = item {
                        let use_dual_brush = if let Some(DescriptorValue::Descriptor(dual_desc)) =
                            brush_desc.get("dualBrush")
                        {
                            matches!(
                                dual_desc.get("useDualBrush"),
                                Some(DescriptorValue::Boolean(true))
                            )
                        } else {
                            false
                        };

                        if !use_dual_brush {
                            continue;
                        }

                        detail_count += 1;

                        let name = brush_desc
                            .get("Nm  ")
                            .and_then(|v| {
                                if let DescriptorValue::String(s) = v {
                                    Some(s.trim_end_matches('\0').to_string())
                                } else {
                                    None
                                }
                            })
                            .unwrap_or_else(|| format!("Brush {}", i));

                        println!("━━━ {} (#{}) ━━━", name, i);

                        if let Some(DescriptorValue::Descriptor(dual_desc)) =
                            brush_desc.get("dualBrush")
                        {
                            println!(
                                "  dualBrush 顶级键: {:?}",
                                dual_desc.keys().collect::<Vec<_>>()
                            );

                            for (key, value) in dual_desc {
                                match value {
                                    DescriptorValue::UnitFloat { unit, value } => {
                                        println!("    {}: {:.4} ({})", key, value, unit);
                                    }
                                    DescriptorValue::Boolean(b) => {
                                        println!("    {}: {}", key, b);
                                    }
                                    DescriptorValue::Integer(i) => {
                                        println!("    {}: {}", key, i);
                                    }
                                    DescriptorValue::Enum { type_id, value: v } => {
                                        println!("    {}: {}::{}", key, type_id, v);
                                    }
                                    DescriptorValue::Descriptor(inner) => {
                                        println!(
                                            "    {}: [Descriptor] 键: {:?}",
                                            key,
                                            inner.keys().collect::<Vec<_>>()
                                        );
                                        // 打印 Brsh 内部结构
                                        if key == "Brsh" {
                                            for (k2, v2) in inner {
                                                match v2 {
                                                    DescriptorValue::UnitFloat { unit, value } => {
                                                        println!(
                                                            "      {}: {:.4} ({})",
                                                            k2, value, unit
                                                        );
                                                    }
                                                    DescriptorValue::String(s) => {
                                                        println!(
                                                            "      {}: \"{}\"",
                                                            k2,
                                                            s.trim_end_matches('\0')
                                                        );
                                                    }
                                                    DescriptorValue::Boolean(b) => {
                                                        println!("      {}: {}", k2, b);
                                                    }
                                                    _ => {
                                                        println!("      {}: [other]", k2);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    _ => {
                                        println!("    {}: [other type]", key);
                                    }
                                }
                            }
                        }

                        println!();
                    }
                }
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
