//! Debug script to understand why matches don't result in names
#![allow(warnings)]

use byteorder::{BigEndian, ReadBytesExt};
use paintboard_lib::abr::descriptor::{parse_descriptor, DescriptorValue};
use paintboard_lib::abr::AbrParser;
use std::collections::HashMap;
use std::io::Cursor;
use std::io::{Read, Seek, SeekFrom};

fn main() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    let data = std::fs::read(&path).expect("Failed to read file");
    let abr = AbrParser::parse(&data).expect("Failed to parse");

    // Build map of brush UUID -> brush index
    let mut brush_by_uuid: HashMap<String, usize> = HashMap::new();
    for (i, brush) in abr.brushes.iter().enumerate() {
        if let Some(uuid) = &brush.uuid {
            brush_by_uuid.insert(uuid.trim().to_string(), i);
        }
    }
    println!("Brushes with UUID: {}", brush_by_uuid.len());

    // Parse desc section
    let desc_data = find_desc_section(&data).expect("No desc section");
    let desc = parse_descriptor(&mut Cursor::new(&desc_data)).expect("Failed to parse desc");

    if let Some(DescriptorValue::List(brsh_list)) = desc.get("Brsh") {
        println!("Descriptors in Brsh list: {}\n", brsh_list.len());

        let mut matched = 0;
        let mut with_name = 0;
        let mut without_name = 0;

        for (i, item) in brsh_list.iter().enumerate() {
            if let DescriptorValue::Descriptor(brush_desc) = item {
                // Find UUID via sampledData
                let uuid = find_sampled_data(&DescriptorValue::Descriptor(brush_desc.clone()));

                // Get name from descriptor
                let name = brush_desc.get("Nm  ").and_then(|v| {
                    if let DescriptorValue::String(s) = v {
                        Some(s.clone())
                    } else {
                        None
                    }
                });

                if let Some(uuid) = uuid {
                    let uuid_trimmed = uuid.trim();
                    if let Some(&brush_idx) = brush_by_uuid.get(uuid_trimmed) {
                        matched += 1;
                        let brush = &abr.brushes[brush_idx];

                        if name.is_some() {
                            with_name += 1;
                        } else {
                            without_name += 1;
                            // Show cases where we match but have no name
                            if without_name <= 5 {
                                println!(
                                    "Matched but NO name in desc: brush #{} '{}' <- desc #{}",
                                    brush_idx, brush.name, i
                                );
                                println!(
                                    "  Desc keys: {:?}",
                                    brush_desc.keys().collect::<Vec<_>>()
                                );
                            }
                        }
                    }
                }
            }
        }

        println!("\n=== SUMMARY ===");
        println!("Total matched: {}", matched);
        println!("With name in descriptor: {}", with_name);
        println!("Without name in descriptor: {}", without_name);
    }
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

fn find_sampled_data(val: &DescriptorValue) -> Option<String> {
    match val {
        DescriptorValue::Descriptor(d) => {
            if let Some(DescriptorValue::String(s)) = d.get("sampledData") {
                return Some(s.clone());
            }
            for v in d.values() {
                if let Some(res) = find_sampled_data(v) {
                    return Some(res);
                }
            }
        }
        DescriptorValue::List(l) => {
            for v in l {
                if let Some(res) = find_sampled_data(v) {
                    return Some(res);
                }
            }
        }
        _ => {}
    }
    None
}
