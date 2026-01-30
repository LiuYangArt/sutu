//! Debug script to analyze remaining unmatched brushes
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

    // Get unmatched brush UUIDs (those with Brush_N names)
    let unmatched_uuids: Vec<(usize, String)> = abr
        .brushes
        .iter()
        .enumerate()
        .filter(|(_, b)| b.name.starts_with("Brush_"))
        .filter_map(|(i, b)| b.uuid.as_ref().map(|u| (i, u.trim().to_string())))
        .collect();

    println!("=== UNMATCHED BRUSHES ===");
    for (idx, uuid) in &unmatched_uuids {
        println!("#{}: {} (UUID: {})", idx, abr.brushes[*idx].name, uuid);
    }

    // Parse desc section and search for these UUIDs in any field
    let desc_data = find_desc_section(&data).expect("No desc section");
    let desc = parse_descriptor(&mut Cursor::new(&desc_data)).expect("Failed to parse desc");

    println!("\n=== SEARCHING FOR UUIDS IN DESC ===");

    if let Some(DescriptorValue::List(brsh_list)) = desc.get("Brsh") {
        for (uuid_idx, (brush_idx, uuid)) in unmatched_uuids.iter().enumerate() {
            if uuid_idx >= 3 {
                break;
            } // Limit output

            println!("\nSearching for UUID: {}", uuid);

            // Search all descriptors for this UUID
            for (i, item) in brsh_list.iter().enumerate() {
                if let DescriptorValue::Descriptor(brush_desc) = item {
                    if find_string_anywhere(&DescriptorValue::Descriptor(brush_desc.clone()), uuid)
                    {
                        // Found! Get the name
                        let name = brush_desc.get("Nm  ").and_then(|v| {
                            if let DescriptorValue::String(s) = v {
                                Some(s.clone())
                            } else {
                                None
                            }
                        });
                        println!("  FOUND in desc #{}: name = {:?}", i, name);

                        // Show where the UUID was found
                        show_uuid_location(
                            &DescriptorValue::Descriptor(brush_desc.clone()),
                            uuid,
                            "",
                        );
                    }
                }
            }
        }

        // Also check if desc has any brushes with name "Sampled Brush 3 12"
        println!("\n=== LOOKING FOR 'Sampled Brush 3 12' ===");
        for (i, item) in brsh_list.iter().enumerate() {
            if let DescriptorValue::Descriptor(brush_desc) = item {
                if let Some(DescriptorValue::String(name)) = brush_desc.get("Nm  ") {
                    if name.contains("Sampled Brush 3 12") {
                        println!("Found desc #{}: '{}'", i, name);
                        // Get all UUID-like strings in this descriptor
                        let uuids =
                            find_all_uuids(&DescriptorValue::Descriptor(brush_desc.clone()));
                        println!("  UUID-like strings: {:?}", uuids);

                        // Show top-level keys
                        println!("  Keys: {:?}", brush_desc.keys().collect::<Vec<_>>());
                    }
                }
            }
        }
    }
}

fn find_string_anywhere(val: &DescriptorValue, target: &str) -> bool {
    match val {
        DescriptorValue::String(s) => s.trim() == target,
        DescriptorValue::Descriptor(d) => d.values().any(|v| find_string_anywhere(v, target)),
        DescriptorValue::List(l) => l.iter().any(|v| find_string_anywhere(v, target)),
        _ => false,
    }
}

fn show_uuid_location(val: &DescriptorValue, target: &str, path: &str) {
    match val {
        DescriptorValue::String(s) if s.trim() == target => {
            println!("    UUID at path: {}", path);
        }
        DescriptorValue::Descriptor(d) => {
            for (k, v) in d.iter() {
                let new_path = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{}.{}", path, k)
                };
                show_uuid_location(v, target, &new_path);
            }
        }
        DescriptorValue::List(l) => {
            for (i, v) in l.iter().enumerate() {
                let new_path = format!("{}[{}]", path, i);
                show_uuid_location(v, target, &new_path);
            }
        }
        _ => {}
    }
}

fn find_all_uuids(val: &DescriptorValue) -> Vec<String> {
    let mut result = Vec::new();
    match val {
        DescriptorValue::String(s) => {
            if s.len() >= 36 && s.chars().filter(|c| *c == '-').count() == 4 {
                result.push(s.clone());
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
