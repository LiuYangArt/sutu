#![allow(clippy::unwrap_used, clippy::expect_used)]
//! ABR Txtr Structure Finder
//!
//! 找到并解析 Txtr 描述符的内容

use byteorder::{BigEndian, ReadBytesExt};
use std::io::{Cursor, Read, Seek, SeekFrom};

fn main() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    let data = std::fs::read(&path).expect("Failed to read file");

    // Find desc section
    let mut cursor = Cursor::new(data.as_slice());
    cursor.seek(SeekFrom::Start(4)).ok();

    let mut desc_offset = 0usize;
    let mut desc_size = 0usize;

    loop {
        let mut sig = [0u8; 4];
        if cursor.read_exact(&mut sig).is_err() {
            break;
        }
        if &sig != b"8BIM" {
            break;
        }

        let mut tag = [0u8; 4];
        if cursor.read_exact(&mut tag).is_err() {
            break;
        }
        let tag_str = std::str::from_utf8(&tag).unwrap_or("????");

        let size = cursor.read_u32::<BigEndian>().unwrap_or(0) as usize;

        if tag_str == "desc" {
            desc_offset = cursor.position() as usize;
            desc_size = size;
            break;
        } else {
            cursor.seek(SeekFrom::Current(size as i64)).ok();
            if size % 2 != 0 {
                cursor.seek(SeekFrom::Current(1)).ok();
            }
        }
    }

    if desc_size == 0 {
        println!("No desc section found");
        return;
    }

    let desc_data = &data[desc_offset..desc_offset + desc_size];
    println!("desc section: offset={}, size={}\n", desc_offset, desc_size);

    // Find all Txtr occurrences
    let txtr_bytes = b"Txtr";
    let mut txtr_positions = Vec::new();

    for i in 0..desc_data.len().saturating_sub(4) {
        if &desc_data[i..i + 4] == txtr_bytes {
            txtr_positions.push(i);
        }
    }

    println!("Found {} Txtr occurrences\n", txtr_positions.len());

    // Analyze first 3 Txtr positions
    for (idx, &pos) in txtr_positions.iter().take(3).enumerate() {
        println!("=== Txtr #{} at offset {} ===", idx + 1, pos);

        // Create cursor starting at Txtr position
        let mut cursor = Cursor::new(&desc_data[pos..]);

        // Read key (should be "Txtr")
        let mut key = [0u8; 4];
        cursor.read_exact(&mut key).ok();
        println!("Key: {}", String::from_utf8_lossy(&key));

        // Read type (should be "Objc")
        let mut type_id = [0u8; 4];
        cursor.read_exact(&mut type_id).ok();
        let type_str = String::from_utf8_lossy(&type_id);
        println!("Type: {}", type_str);

        if type_str == "Objc" {
            // Object descriptor
            let version = cursor.read_u32::<BigEndian>().unwrap_or(0);
            println!("Version: {}", version);

            // Name (unicode)
            let name_len = cursor.read_u32::<BigEndian>().unwrap_or(0);
            let mut name_chars = Vec::new();
            for _ in 0..name_len.min(100) {
                if let Ok(ch) = cursor.read_u16::<BigEndian>() {
                    if ch != 0 {
                        name_chars.push(ch);
                    }
                }
            }
            let name = String::from_utf16_lossy(&name_chars);
            println!("Name: '{}'", name);

            // Class ID
            let class_len = cursor.read_u32::<BigEndian>().unwrap_or(0);
            let class_id = if class_len == 0 {
                let mut k = [0u8; 4];
                cursor.read_exact(&mut k).ok();
                String::from_utf8_lossy(&k).to_string()
            } else if class_len < 100 {
                let mut k = vec![0u8; class_len as usize];
                cursor.read_exact(&mut k).ok();
                String::from_utf8_lossy(&k).to_string()
            } else {
                format!("(too long: {})", class_len)
            };
            println!("ClassID: '{}'", class_id);

            // Item count
            let count = cursor.read_u32::<BigEndian>().unwrap_or(0);
            println!("Items: {}", count);

            // Read each item
            for i in 0..count.min(20) {
                // Key
                let key_len = cursor.read_u32::<BigEndian>().unwrap_or(0);
                let item_key = if key_len == 0 {
                    let mut k = [0u8; 4];
                    if cursor.read_exact(&mut k).is_err() {
                        break;
                    }
                    String::from_utf8_lossy(&k).to_string()
                } else if key_len < 100 {
                    let mut k = vec![0u8; key_len as usize];
                    if cursor.read_exact(&mut k).is_err() {
                        break;
                    }
                    String::from_utf8_lossy(&k).to_string()
                } else {
                    println!("  #{}: (key too long: {})", i, key_len);
                    break;
                };

                // Type
                let mut item_type = [0u8; 4];
                if cursor.read_exact(&mut item_type).is_err() {
                    break;
                }
                let item_type_str = String::from_utf8_lossy(&item_type);

                // Value
                let value_str = match item_type_str.as_ref() {
                    "TEXT" => {
                        let len = cursor.read_u32::<BigEndian>().unwrap_or(0);
                        let mut chars = Vec::new();
                        for _ in 0..len.min(100) {
                            if let Ok(ch) = cursor.read_u16::<BigEndian>() {
                                if ch != 0 {
                                    chars.push(ch);
                                }
                            }
                        }
                        format!("\"{}\"", String::from_utf16_lossy(&chars))
                    }
                    "UntF" => {
                        let mut unit = [0u8; 4];
                        cursor.read_exact(&mut unit).ok();
                        let val = cursor.read_f64::<BigEndian>().unwrap_or(0.0);
                        format!("{:.2} ({})", val, String::from_utf8_lossy(&unit))
                    }
                    "bool" => {
                        let val = cursor.read_u8().unwrap_or(0);
                        format!("{}", val != 0)
                    }
                    "long" => {
                        let val = cursor.read_i32::<BigEndian>().unwrap_or(0);
                        format!("{}", val)
                    }
                    "enum" => {
                        // type_id
                        let len1 = cursor.read_u32::<BigEndian>().unwrap_or(0);
                        let tid = if len1 == 0 {
                            let mut k = [0u8; 4];
                            cursor.read_exact(&mut k).ok();
                            String::from_utf8_lossy(&k).to_string()
                        } else if len1 < 100 {
                            let mut k = vec![0u8; len1 as usize];
                            cursor.read_exact(&mut k).ok();
                            String::from_utf8_lossy(&k).to_string()
                        } else {
                            "(?)".to_string()
                        };
                        // value
                        let len2 = cursor.read_u32::<BigEndian>().unwrap_or(0);
                        let val = if len2 == 0 {
                            let mut k = [0u8; 4];
                            cursor.read_exact(&mut k).ok();
                            String::from_utf8_lossy(&k).to_string()
                        } else if len2 < 100 {
                            let mut k = vec![0u8; len2 as usize];
                            cursor.read_exact(&mut k).ok();
                            String::from_utf8_lossy(&k).to_string()
                        } else {
                            "(?)".to_string()
                        };
                        format!("{}::{}", tid, val)
                    }
                    _ => {
                        format!("[STOP - can't parse {}]", item_type_str)
                    }
                };

                println!("  #{}: {} ({}) = {}", i, item_key, item_type_str, value_str);

                if value_str.starts_with("[STOP") {
                    break;
                }
            }
        }

        println!();
    }

    println!("=== Pattern ID Summary ===");
    println!("Looking for Idnt and PtNm fields in all Txtr descriptors:\n");

    // More thorough search: find pattern between "Idnt" and common endings
    let idnt_bytes = b"Idnt";
    let ptnm_bytes = b"PtNm"; // Pattern Name

    for (idx, &pos) in txtr_positions.iter().enumerate() {
        // Look for Idnt within 200 bytes after Txtr
        let search_end = (pos + 200).min(desc_data.len());
        let search_area = &desc_data[pos..search_end];

        // Find PtNm (Pattern Name) - usually a more reliable field
        let mut ptnm_value = None;
        for j in 0..search_area.len().saturating_sub(4) {
            if &search_area[j..j + 4] == ptnm_bytes {
                // Found PtNm, read the TEXT value after it
                let mut c = Cursor::new(&search_area[j + 4..]);
                let mut type_id = [0u8; 4];
                if c.read_exact(&mut type_id).is_ok() && &type_id == b"TEXT" {
                    let len = c.read_u32::<BigEndian>().unwrap_or(0);
                    let mut chars = Vec::new();
                    for _ in 0..len.min(50) {
                        if let Ok(ch) = c.read_u16::<BigEndian>() {
                            if ch != 0 {
                                chars.push(ch);
                            }
                        }
                    }
                    ptnm_value = Some(String::from_utf16_lossy(&chars));
                }
                break;
            }
        }

        // Find Idnt
        let mut idnt_value = None;
        for j in 0..search_area.len().saturating_sub(4) {
            if &search_area[j..j + 4] == idnt_bytes {
                let mut c = Cursor::new(&search_area[j + 4..]);
                let mut type_id = [0u8; 4];
                if c.read_exact(&mut type_id).is_ok() && &type_id == b"TEXT" {
                    let len = c.read_u32::<BigEndian>().unwrap_or(0);
                    let mut chars = Vec::new();
                    for _ in 0..len.min(80) {
                        if let Ok(ch) = c.read_u16::<BigEndian>() {
                            if ch != 0 {
                                chars.push(ch);
                            }
                        }
                    }
                    idnt_value = Some(String::from_utf16_lossy(&chars));
                }
                break;
            }
        }

        if ptnm_value.is_some() || idnt_value.is_some() {
            println!(
                "Txtr #{}: PtNm='{}', Idnt='{}'",
                idx + 1,
                ptnm_value.as_deref().unwrap_or("(none)"),
                idnt_value.as_deref().unwrap_or("(none)")
            );
        }
    }
}
