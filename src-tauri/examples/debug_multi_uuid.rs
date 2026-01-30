//! Debug script to analyze multi-UUID descriptors
#![allow(warnings)]

use byteorder::{BigEndian, ReadBytesExt};
use paintboard_lib::abr::descriptor::{parse_descriptor, DescriptorValue};
use paintboard_lib::abr::AbrParser;
use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::io::{Read, Seek, SeekFrom};

fn main() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    let data = std::fs::read(&path).expect("Failed to read file");
    let abr = AbrParser::parse(&data).expect("Failed to parse");

    // Build map of all brush UUIDs
    let all_brush_uuids: HashSet<String> = abr
        .brushes
        .iter()
        .filter_map(|b| b.uuid.as_ref().map(|u| u.trim().to_string()))
        .collect();

    // Parse desc section
    let desc_data = find_desc_section(&data).expect("No desc section");
    let desc = parse_descriptor(&mut Cursor::new(&desc_data)).expect("Failed to parse desc");

    if let Some(DescriptorValue::List(brsh_list)) = desc.get("Brsh") {
        println!("=== ANALYZING DESCRIPTORS WITH MULTIPLE UUIDS ===\n");

        for (i, item) in brsh_list.iter().enumerate() {
            if let DescriptorValue::Descriptor(brush_desc) = item {
                let name = brush_desc.get("Nm  ").and_then(|v| {
                    if let DescriptorValue::String(s) = v {
                        Some(s.clone())
                    } else {
                        None
                    }
                });

                // Find ALL UUID-like strings
                let all_uuids = find_all_uuids(&DescriptorValue::Descriptor(brush_desc.clone()));

                // Filter to only those that match our brushes
                let matching_uuids: Vec<_> = all_uuids
                    .iter()
                    .filter(|u| all_brush_uuids.contains(u.trim()))
                    .collect();

                if matching_uuids.len() > 1 {
                    println!(
                        "Desc #{}: '{}' has {} matching UUIDs:",
                        i,
                        name.as_deref().unwrap_or("?"),
                        matching_uuids.len()
                    );

                    for uuid in &matching_uuids {
                        // Find which brush this UUID belongs to
                        let brush = abr
                            .brushes
                            .iter()
                            .find(|b| b.uuid.as_ref().map(|u| u.trim()) == Some(uuid.trim()));
                        if let Some(brush) = brush {
                            println!("  - {} -> brush '{}'", uuid, brush.name);
                        }
                    }

                    // Show path to first sampledData
                    let primary =
                        find_first_sampled_data(&DescriptorValue::Descriptor(brush_desc.clone()));
                    println!("  PRIMARY (sampledData): {:?}", primary);
                    println!();
                }
            }
        }

        // Focus on Sampled Brush 3 12
        println!("\n=== DETAIL: Sampled Brush 3 12 ===");
        for (i, item) in brsh_list.iter().enumerate() {
            if let DescriptorValue::Descriptor(brush_desc) = item {
                if let Some(DescriptorValue::String(name)) = brush_desc.get("Nm  ") {
                    if name.contains("Sampled Brush 3 12") {
                        println!("Desc #{}: '{}'", i, name);

                        // Show all sampledData fields with their paths
                        find_sampled_data_with_path(
                            &DescriptorValue::Descriptor(brush_desc.clone()),
                            "",
                        );
                    }
                }
            }
        }
    }
}

fn find_all_uuids(val: &DescriptorValue) -> Vec<String> {
    let mut result = Vec::new();
    match val {
        DescriptorValue::String(s) => {
            let s = s.trim();
            if s.len() >= 36 && s.chars().filter(|c| *c == '-').count() == 4 {
                result.push(s.to_string());
            }
        }
        DescriptorValue::Descriptor(d) => {
            for v in d.values() {
                result.extend(find_all_uuids(v));
            }
        }
        DescriptorValue::List(l) => {
            for v in l {
                result.extend(find_all_uuids(v));
            }
        }
        _ => {}
    }
    result
}

fn find_first_sampled_data(val: &DescriptorValue) -> Option<String> {
    match val {
        DescriptorValue::Descriptor(d) => {
            if let Some(DescriptorValue::String(s)) = d.get("sampledData") {
                return Some(s.clone());
            }
            for v in d.values() {
                if let Some(res) = find_first_sampled_data(v) {
                    return Some(res);
                }
            }
        }
        DescriptorValue::List(l) => {
            for v in l {
                if let Some(res) = find_first_sampled_data(v) {
                    return Some(res);
                }
            }
        }
        _ => {}
    }
    None
}

fn find_sampled_data_with_path(val: &DescriptorValue, path: &str) {
    match val {
        DescriptorValue::Descriptor(d) => {
            if let Some(DescriptorValue::String(s)) = d.get("sampledData") {
                println!(
                    "  sampledData at '{}': {}",
                    if path.is_empty() { "root" } else { path },
                    s.trim()
                );
            }
            for (k, v) in d.iter() {
                let new_path = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{}.{}", path, k)
                };
                find_sampled_data_with_path(v, &new_path);
            }
        }
        DescriptorValue::List(l) => {
            for (i, v) in l.iter().enumerate() {
                let new_path = format!("{}[{}]", path, i);
                find_sampled_data_with_path(v, &new_path);
            }
        }
        _ => {}
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
