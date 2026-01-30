//! Debug script to compare UUIDs from samp vs desc sections
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

    // Collect UUIDs from samp section (brushes)
    let samp_uuids: HashSet<String> = abr
        .brushes
        .iter()
        .filter_map(|b| b.uuid.as_ref().map(|u| u.trim().to_string()))
        .collect();

    println!("=== SAMP SECTION ===");
    println!("Brushes: {}", abr.brushes.len());
    println!("With UUID: {}", samp_uuids.len());

    // Parse desc section and collect sampledData UUIDs
    let desc_data = find_desc_section(&data).expect("No desc section");
    let desc = parse_descriptor(&mut Cursor::new(&desc_data)).expect("Failed to parse desc");

    println!("\n=== DESC SECTION ===");

    if let Some(DescriptorValue::List(brsh_list)) = desc.get("Brsh") {
        println!("Descriptors: {}", brsh_list.len());

        let mut desc_uuids: HashSet<String> = HashSet::new();
        let mut desc_names: HashMap<String, String> = HashMap::new(); // UUID -> Name

        for item in brsh_list.iter() {
            if let DescriptorValue::Descriptor(brush_desc) = item {
                if let Some(uuid) =
                    find_sampled_data(&DescriptorValue::Descriptor(brush_desc.clone()))
                {
                    let uuid_trimmed = uuid.trim().to_string();
                    desc_uuids.insert(uuid_trimmed.clone());

                    if let Some(DescriptorValue::String(name)) = brush_desc.get("Nm  ") {
                        desc_names.insert(uuid_trimmed, name.clone());
                    }
                }
            }
        }

        println!("With sampledData UUID: {}", desc_uuids.len());

        // Compare
        let in_both: HashSet<_> = samp_uuids.intersection(&desc_uuids).collect();
        let only_in_samp: HashSet<_> = samp_uuids.difference(&desc_uuids).collect();
        let only_in_desc: HashSet<_> = desc_uuids.difference(&samp_uuids).collect();

        println!("\n=== COMPARISON ===");
        println!("UUIDs in BOTH: {} (these should get names)", in_both.len());
        println!("Only in SAMP (no name from desc): {}", only_in_samp.len());
        println!("Only in DESC (orphan descriptors): {}", only_in_desc.len());

        // Show brushes that should have names but don't
        println!("\n=== BRUSHES IN BOTH BUT STILL HAVE Brush_N NAME ===");
        for brush in abr.brushes.iter() {
            if brush.name.starts_with("Brush_") {
                if let Some(uuid) = &brush.uuid {
                    let uuid_trimmed = uuid.trim();
                    if in_both.contains(&uuid_trimmed.to_string()) {
                        if let Some(expected_name) = desc_names.get(uuid_trimmed) {
                            println!(
                                "  {} should be '{}' (UUID: {})",
                                brush.name, expected_name, uuid_trimmed
                            );
                        }
                    }
                }
            }
        }

        // Show UUIDs only in samp
        println!("\n=== UUIDS ONLY IN SAMP (first 5) ===");
        for (i, uuid) in only_in_samp.iter().enumerate() {
            if i >= 5 {
                break;
            }
            let brush = abr
                .brushes
                .iter()
                .find(|b| b.uuid.as_ref().map(|u| u.trim()) == Some(uuid.as_str()));
            if let Some(brush) = brush {
                println!("  {} -> {}", uuid, brush.name);
            }
        }
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
