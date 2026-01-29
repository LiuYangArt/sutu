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
                if let Some(DescriptorValue::List(brsh_list)) = desc.get("Brsh") {
                    println!("Total Descriptors: {}", brsh_list.len());

                    // Helper to find UUID recursively
                    fn find_uuid(
                        val: &paintboard_lib::abr::descriptor::DescriptorValue,
                    ) -> Option<String> {
                        use paintboard_lib::abr::descriptor::DescriptorValue;
                        match val {
                            DescriptorValue::String(s) => return Some(s.clone()),
                            DescriptorValue::Descriptor(d) => {
                                if let Some(uuid) = d.get("sampledData") {
                                    if let DescriptorValue::String(s) = uuid {
                                        return Some(s.clone());
                                    }
                                }
                                for v in d.values() {
                                    if let Some(res) = find_uuid(v) {
                                        return Some(res);
                                    }
                                }
                            }
                            DescriptorValue::List(l) => {
                                for v in l {
                                    if let Some(res) = find_uuid(v) {
                                        return Some(res);
                                    }
                                }
                            }
                            _ => {}
                        }
                        None
                    }

                    for (i, item) in brsh_list.iter().enumerate() {
                        if let DescriptorValue::Descriptor(brush_desc) = item {
                            let name = match brush_desc.get("Nm  ") {
                                Some(DescriptorValue::String(n)) => n.clone(),
                                _ => "(No Name)".to_string(),
                            };

                            let uuid = find_uuid(&DescriptorValue::Descriptor(brush_desc.clone()));
                            println!("[Desc #{}] Name: '{}' | UUID: {:?}", i, name, uuid);
                        }
                    }
                }
            }
            Err(e) => println!("Error: {}", e),
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
