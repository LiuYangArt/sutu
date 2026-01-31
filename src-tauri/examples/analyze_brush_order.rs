#![allow(warnings)]
//! 分析 ABR 文件中笔刷的顺序
//!
//! 对比 samp section (物理存储顺序) 与 desc section (Brsh 列表顺序)
//! 以确定 Photoshop 使用的权威顺序

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
    println!("  ABR 笔刷顺序分析器");
    println!("  文件: {:?}", path);
    println!("═══════════════════════════════════════════════════════════════════════════\n");

    let data = std::fs::read(&path).expect("Failed to read file");

    // 1. 使用当前解析器获取 samp section 顺序
    let abr = AbrParser::parse(&data).expect("Failed to parse ABR");
    println!("【samp section 顺序】共 {} 个笔刷：", abr.brushes.len());
    for (i, brush) in abr.brushes.iter().enumerate() {
        let uuid_short = brush
            .uuid
            .as_ref()
            .map(|u| {
                if u.len() > 20 {
                    format!("{}...", &u[..20])
                } else {
                    u.clone()
                }
            })
            .unwrap_or_else(|| "None".to_string());
        println!("  samp[{:02}]: '{}' (UUID: {})", i, brush.name, uuid_short);
    }

    println!();

    // 2. 从 desc section 获取 Brsh 列表顺序
    if let Some(desc_data) = find_desc_section(&data) {
        println!("【desc section 的 Brsh 列表顺序】");
        match parse_descriptor(&mut Cursor::new(&desc_data)) {
            Ok(desc) => {
                if let Some(DescriptorValue::List(brsh_list)) = desc.get("Brsh") {
                    println!("共 {} 个项目：", brsh_list.len());
                    for (i, item) in brsh_list.iter().enumerate() {
                        if let DescriptorValue::Descriptor(brush_desc) = item {
                            let name = brush_desc
                                .get("Nm  ")
                                .and_then(|v| {
                                    if let DescriptorValue::String(s) = v {
                                        Some(s.clone())
                                    } else {
                                        None
                                    }
                                })
                                .unwrap_or_else(|| "[无名]".to_string());

                            // 提取 sampledData UUID
                            let uuid = find_sampled_data_uuid(&DescriptorValue::Descriptor(
                                brush_desc.clone(),
                            ));
                            let uuid_short = uuid
                                .as_ref()
                                .map(|u| {
                                    if u.len() > 20 {
                                        format!("{}...", &u[..20])
                                    } else {
                                        u.clone()
                                    }
                                })
                                .unwrap_or_else(|| "None".to_string());

                            // 检测是否是 computed/procedural brush
                            let is_computed = brush_desc
                                .get("Brsh")
                                .and_then(|v| {
                                    if let DescriptorValue::Descriptor(brsh) = v {
                                        brsh.get("useTipDynamics")
                                            .map(|_| false)
                                            .or_else(|| {
                                                // 检查是否有 sampledData
                                                brsh.get("sampledData").map(|_| false)
                                            })
                                            .or(Some(true)) // 如果没有 sampledData，可能是 computed
                                    } else {
                                        None
                                    }
                                })
                                .unwrap_or(false);

                            let uuid_present = uuid.is_some();
                            let marker = if !uuid_present {
                                " ⚠️ [可能是 Computed/Procedural]"
                            } else {
                                ""
                            };

                            println!(
                                "  desc[{:02}]: '{}' (UUID: {}){}",
                                i, name, uuid_short, marker
                            );
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
    } else {
        println!("未找到 desc section");
    }

    println!();
    println!("═══════════════════════════════════════════════════════════════════════════");
    println!("  分析总结");
    println!("═══════════════════════════════════════════════════════════════════════════");
    println!("  - desc 的 Brsh 列表顺序 = Photoshop 的显示顺序");
    println!("  - samp section 顺序 = 物理存储顺序 (仅含 sampled brushes)");
    println!("  - Computed/Procedural brushes 只存在于 desc, 不在 samp");
    println!("  - 当前解析器按 samp 顺序返回笔刷，导致顺序不一致");
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

fn find_sampled_data_uuid(val: &DescriptorValue) -> Option<String> {
    match val {
        DescriptorValue::Descriptor(d) => {
            if let Some(DescriptorValue::String(s)) = d.get("sampledData") {
                return Some(s.clone());
            }
            for v in d.values() {
                if let Some(res) = find_sampled_data_uuid(v) {
                    return Some(res);
                }
            }
        }
        DescriptorValue::List(l) => {
            for v in l {
                if let Some(res) = find_sampled_data_uuid(v) {
                    return Some(res);
                }
            }
        }
        _ => {}
    }
    None
}
