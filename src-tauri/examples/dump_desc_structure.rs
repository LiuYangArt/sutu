#![allow(warnings)]
use byteorder::{BigEndian, ReadBytesExt};
use paintboard_lib::abr::descriptor::{parse_descriptor, DescriptorValue};
use std::io::Cursor;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

fn main() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    let data = std::fs::read(&path).expect("Failed to read file");

    if let Some(desc_data) = find_desc_section(&data) {
        match parse_descriptor(&mut Cursor::new(&desc_data)) {
            Ok(desc) => {
                let target_uuid = "2208e679-9fa4-11da-9e8a-f926889842f3"; // REAL Brush #6 UUID
                println!("Searching for UUID: {}", target_uuid);

                search_value(&DescriptorValue::Descriptor(desc), target_uuid, "Root");
            }
            Err(e) => println!("Error: {}", e),
        }
    }
}

fn search_value(val: &DescriptorValue, target: &str, path: &str) {
    match val {
        DescriptorValue::String(s) => {
            if s.len() > 30 {
                println!("Potential UUID at {}: '{}'", path, s);
            }
        }
        DescriptorValue::Descriptor(d) => {
            for (k, v) in d {
                let new_path = format!("{} -> {}", path, k);
                search_value(v, target, &new_path);
            }
        }
        DescriptorValue::List(l) => {
            for (i, v) in l.iter().enumerate() {
                let new_path = format!("{} -> [{}]", path, i);
                search_value(v, target, &new_path);
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
        let padded_size = if section_size % 2 != 0 {
            section_size + 1
        } else {
            section_size
        };

        if tag_str == "desc" {
            let mut section = vec![0u8; section_size];
            cursor.read_exact(&mut section).ok()?;
            return Some(section);
        } else {
            cursor.seek(SeekFrom::Current(padded_size as i64)).ok();
        }
    }
    None
}
