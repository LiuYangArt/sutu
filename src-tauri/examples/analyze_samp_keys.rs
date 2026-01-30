#![allow(warnings)]
use byteorder::{BigEndian, ReadBytesExt};
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::Path;

fn main() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    let data = std::fs::read(&path).expect("Failed to read file");
    let mut cursor = Cursor::new(&data);

    // Skip ABR header (version: 2, sub: 2, count: 0 for v6)
    // Actually, simple scan for 8BIM samp
    if let Some(samp_data) = find_section(&data, "samp") {
        println!("Found samp section! Size: {}", samp_data.len());
        let mut sc = Cursor::new(&samp_data);

        let mut i = 0;
        let end = samp_data.len() as u64;

        while sc.position() < end {
            // Read length
            let len = sc.read_u32::<BigEndian>().unwrap();
            let aligned = (len + 3) & !3;
            let next_pos = sc.position() + aligned as u64;

            // Read the first X bytes which might contain the Key
            // Parse V6 brush data structure
            // 4 bytes length (already read)
            // String id?
            // The structure is: [Length] [Data...]
            // Inside Data:
            // String key (Pascal string? Or null terminated?)
            // Let's dump the first 50 bytes of data

            let mut head = vec![0u8; 50];
            let read_len = std::cmp::min(50, aligned as usize);
            sc.read_exact(&mut head[0..read_len]).ok();

            // Try strings
            let s = String::from_utf8_lossy(&head);
            println!("\nSamp #{}: Head: {:?}", i, s);

            sc.seek(SeekFrom::Start(next_pos)).ok();
            i += 1;
            if i > 10 {
                break;
            }
        }
    } else {
        println!("samp section not found");
    }
}

fn find_section(data: &[u8], target: &str) -> Option<Vec<u8>> {
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

        if tag_str == target {
            let mut section = vec![0u8; section_size];
            cursor.read_exact(&mut section).ok()?;
            return Some(section);
        } else {
            cursor.seek(SeekFrom::Current(padded_size as i64)).ok();
        }
    }
    None
}
