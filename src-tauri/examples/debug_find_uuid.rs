//! Debug script to trace find_uuid behavior
#![allow(warnings)]

use byteorder::{BigEndian, ReadBytesExt};
use paintboard_lib::abr::descriptor::{parse_descriptor, DescriptorValue};
use paintboard_lib::abr::AbrParser;
use std::collections::HashSet;
use std::io::Cursor;
use std::io::{Read, Seek, SeekFrom};

fn main() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    let data = std::fs::read(&path).expect("Failed to read file");

    // Get brushes and their UUIDs
    let abr = AbrParser::parse(&data).expect("Failed to parse");
    let samp_uuids: HashSet<String> = abr
        .brushes
        .iter()
        .filter_map(|b| b.uuid.as_ref().map(|u| u.trim().to_string()))
        .collect();

    // Parse desc section
    let desc_data = find_desc_section(&data).expect("No desc section");
    let desc = parse_descriptor(&mut Cursor::new(&desc_data)).expect("Failed to parse desc");

    if let Some(DescriptorValue::List(brsh_list)) = desc.get("Brsh") {
        println!("Testing find_uuid on {} descriptors\n", brsh_list.len());

        // This is the BUGGY find_uuid from parser.rs
        fn find_uuid_buggy(val: &DescriptorValue) -> Option<String> {
            match val {
                DescriptorValue::String(s) => return Some(s.clone()), // BUG! Returns any string!
                DescriptorValue::Descriptor(d) => {
                    if let Some(uuid) = d.get("sampledData") {
                        if let DescriptorValue::String(s) = uuid {
                            return Some(s.clone());
                        }
                    }
                    for v in d.values() {
                        if let Some(res) = find_uuid_buggy(v) {
                            return Some(res);
                        }
                    }
                }
                DescriptorValue::List(l) => {
                    for v in l {
                        if let Some(res) = find_uuid_buggy(v) {
                            return Some(res);
                        }
                    }
                }
                _ => {}
            }
            None
        }

        // FIXED find_uuid - only look for sampledData field
        fn find_uuid_fixed(val: &DescriptorValue) -> Option<String> {
            match val {
                DescriptorValue::Descriptor(d) => {
                    // Only extract UUID from sampledData field
                    if let Some(DescriptorValue::String(s)) = d.get("sampledData") {
                        return Some(s.clone());
                    }
                    // Recursive
                    for v in d.values() {
                        if let Some(res) = find_uuid_fixed(v) {
                            return Some(res);
                        }
                    }
                }
                DescriptorValue::List(l) => {
                    for v in l {
                        if let Some(res) = find_uuid_fixed(v) {
                            return Some(res);
                        }
                    }
                }
                _ => {}
            }
            None
        }

        let mut buggy_matches = 0;
        let mut fixed_matches = 0;
        let mut buggy_returns_wrong = 0;

        for (i, item) in brsh_list.iter().enumerate() {
            if let DescriptorValue::Descriptor(brush_desc) = item {
                let buggy_result =
                    find_uuid_buggy(&DescriptorValue::Descriptor(brush_desc.clone()));
                let fixed_result =
                    find_uuid_fixed(&DescriptorValue::Descriptor(brush_desc.clone()));

                if let Some(ref uuid) = buggy_result {
                    if samp_uuids.contains(uuid.trim()) {
                        buggy_matches += 1;
                    }
                }

                if let Some(ref uuid) = fixed_result {
                    if samp_uuids.contains(uuid.trim()) {
                        fixed_matches += 1;
                    }
                }

                // Check if buggy returns something different
                if buggy_result != fixed_result {
                    buggy_returns_wrong += 1;
                    if buggy_returns_wrong <= 5 {
                        println!(
                            "Desc #{}: BUGGY='{}' vs FIXED='{}'",
                            i,
                            buggy_result.as_deref().unwrap_or("None"),
                            fixed_result.as_deref().unwrap_or("None")
                        );
                    }
                }
            }
        }

        println!("\n=== COMPARISON ===");
        println!("Buggy find_uuid matches: {}", buggy_matches);
        println!("Fixed find_uuid matches: {}", fixed_matches);
        println!("Cases where buggy != fixed: {}", buggy_returns_wrong);
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
