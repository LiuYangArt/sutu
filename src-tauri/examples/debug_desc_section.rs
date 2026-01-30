//! Debug script to analyze desc section structure and UUID fields
#![allow(warnings)]

use paintboard_lib::abr::descriptor::{parse_descriptor, DescriptorValue};
use paintboard_lib::abr::AbrParser;
use std::io::Cursor;

fn main() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    println!("Analyzing desc section: {:?}\n", path);

    let data = std::fs::read(&path).expect("Failed to read file");

    // Find desc section manually
    let desc_data = find_desc_section(&data);
    if desc_data.is_none() {
        println!("No desc section found!");
        return;
    }

    let desc_data = desc_data.unwrap();
    println!("Desc section size: {} bytes\n", desc_data.len());

    match parse_descriptor(&mut Cursor::new(&desc_data)) {
        Ok(desc) => {
            if let Some(DescriptorValue::List(brsh_list)) = desc.get("Brsh") {
                println!("Found {} brush descriptors\n", brsh_list.len());

                // Analyze first few brush descriptors
                for (i, item) in brsh_list.iter().enumerate() {
                    if i >= 5 {
                        println!("... and {} more", brsh_list.len() - 5);
                        break;
                    }

                    if let DescriptorValue::Descriptor(brush_desc) = item {
                        println!("=== Brush Descriptor #{} ===", i);

                        // Print all top-level keys
                        println!(
                            "Top-level keys: {:?}",
                            brush_desc.keys().collect::<Vec<_>>()
                        );

                        // Check for name
                        if let Some(DescriptorValue::String(name)) = brush_desc.get("Nm  ") {
                            println!("  Name: {}", name);
                        }

                        // Check for sampledData
                        if let Some(sampled) = brush_desc.get("sampledData") {
                            println!("  sampledData: {:?}", sampled);
                        }

                        // Check for Idnt (identity/UUID)
                        if let Some(idnt) = brush_desc.get("Idnt") {
                            println!("  Idnt: {:?}", idnt);
                        }

                        // Recursively find all string fields that look like UUIDs
                        let uuids =
                            find_all_uuid_like(&DescriptorValue::Descriptor(brush_desc.clone()));
                        if !uuids.is_empty() {
                            println!("  UUID-like strings found: {:?}", uuids);
                        }

                        println!();
                    }
                }

                // Count successful matches
                let abr = AbrParser::parse(&data).expect("Failed to parse ABR");
                println!("\n=== Match Analysis ===");
                println!("Brushes in samp: {}", abr.brushes.len());
                println!("Descriptors in desc: {}", brsh_list.len());

                // Try to match using sampledData
                let mut sampled_matches = 0;
                for item in brsh_list.iter() {
                    if let DescriptorValue::Descriptor(brush_desc) = item {
                        if let Some(sampled) =
                            find_sampled_data(&DescriptorValue::Descriptor(brush_desc.clone()))
                        {
                            let uuid = sampled.trim();
                            if abr
                                .brushes
                                .iter()
                                .any(|b| b.uuid.as_ref().map(|u| u.trim()) == Some(uuid))
                            {
                                sampled_matches += 1;
                            }
                        }
                    }
                }
                println!("Matches via sampledData: {}", sampled_matches);
            }
        }
        Err(e) => {
            println!("Failed to parse descriptor: {}", e);
        }
    }
}

fn find_desc_section(data: &[u8]) -> Option<Vec<u8>> {
    use byteorder::{BigEndian, ReadBytesExt};
    use std::io::{Read, Seek, SeekFrom};

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

fn find_all_uuid_like(val: &DescriptorValue) -> Vec<String> {
    let mut result = Vec::new();

    match val {
        DescriptorValue::String(s) => {
            // UUID pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
            if s.len() >= 36 && s.chars().filter(|c| *c == '-').count() == 4 {
                result.push(s.clone());
            }
        }
        DescriptorValue::Descriptor(d) => {
            for v in d.values() {
                result.extend(find_all_uuid_like(v));
            }
        }
        DescriptorValue::List(l) => {
            for v in l {
                result.extend(find_all_uuid_like(v));
            }
        }
        _ => {}
    }

    result
}
