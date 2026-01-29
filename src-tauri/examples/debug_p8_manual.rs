use byteorder::{BigEndian, ReadBytesExt};
/// Debug Pattern #8 - minimal version
use std::fs::File;
use std::io::{Cursor, Read};

fn read_unicode_string(cursor: &mut Cursor<&[u8]>) -> Option<String> {
    let len = cursor.read_u32::<BigEndian>().ok()? as usize;
    if len == 0 || len > 1000 {
        return None;
    }
    let mut chars = Vec::with_capacity(len);
    for _ in 0..len {
        let c = cursor.read_u16::<BigEndian>().ok()?;
        chars.push(c);
    }
    if chars.last() == Some(&0) {
        chars.pop();
    }
    Some(String::from_utf16_lossy(&chars))
}

fn read_pascal_string(cursor: &mut Cursor<&[u8]>) -> Option<String> {
    let len = cursor.read_u8().ok()? as usize;
    if len == 0 {
        return Some(String::new());
    }
    let mut bytes = vec![0u8; len];
    cursor.read_exact(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).to_string())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut file = File::open("f:/CodeProjects/PaintBoard/abr/liuyang_paintbrushes.abr")?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)?;

    // Find patt section
    let patt_pos = data
        .windows(4)
        .position(|w| w == b"patt" || w == b"Patt")
        .unwrap();

    // Parse patterns manually
    let mut pattern_start = patt_pos + 8; // Skip "patt" + size
    let mut patterns = Vec::new();

    let mut pattern_count = 0;
    while pattern_start + 20 < data.len() && pattern_count < 20 {
        let pattern_size = u32::from_be_bytes([
            data[pattern_start],
            data[pattern_start + 1],
            data[pattern_start + 2],
            data[pattern_start + 3],
        ]) as usize;

        if pattern_size < 40
            || pattern_size > 20_000_000
            || pattern_start + pattern_size > data.len()
        {
            break;
        }

        let pattern_data = &data[pattern_start + 4..pattern_start + 4 + pattern_size];
        let mut cursor = Cursor::new(pattern_data);

        let version = cursor.read_u32::<BigEndian>().unwrap_or(0);
        let mode = cursor.read_u32::<BigEndian>().unwrap_or(0);
        let width = cursor.read_u16::<BigEndian>().unwrap_or(0);
        let height = cursor.read_u16::<BigEndian>().unwrap_or(0);

        if version == 1 && (mode == 1 || mode == 3) && width > 0 && height > 0 {
            let name = read_unicode_string(&mut cursor).unwrap_or_default();
            let _id = read_pascal_string(&mut cursor).unwrap_or_default();

            // Align
            let pos = cursor.position();
            let padding = (4 - (pos % 4)) % 4;
            cursor.set_position(pos + padding);

            let image_data_start = cursor.position() as usize;
            let image_data = pattern_data[image_data_start..].to_vec();

            patterns.push((pattern_count, name, width, height, mode, image_data));
        }

        pattern_start += 4 + pattern_size;
        pattern_count += 1;
    }

    println!("Found {} patterns", patterns.len());

    // Check patterns 8, 9, 11
    for (idx, name, width, height, mode, image_data) in &patterns {
        if *idx != 8 && *idx != 9 && *idx != 11 {
            continue;
        }

        println!(
            "\nPattern #{}: {} ({}x{})",
            idx,
            name.trim_end_matches('\0'),
            width,
            height
        );
        println!("  Mode: {}", mode);
        println!("  Image data length: {}", image_data.len());

        // Hex dump
        println!("  First 128 bytes:");
        for row in 0..8 {
            let start = row * 16;
            if start >= image_data.len() {
                break;
            }
            print!("    {:04X}: ", start);
            for i in start..(start + 16).min(image_data.len()) {
                print!("{:02X} ", image_data[i]);
            }
            println!();
        }

        let w = *width as usize;
        let h = *height as usize;

        // Search for VMA
        println!("\n  Searching for VMA header...");
        for test_offset in 0..500 {
            if test_offset + 31 > image_data.len() {
                break;
            }

            let d = &image_data[test_offset..];

            let version = i32::from_be_bytes([d[0], d[1], d[2], d[3]]);
            let size = u32::from_be_bytes([d[4], d[5], d[6], d[7]]);
            let top = i32::from_be_bytes([d[12], d[13], d[14], d[15]]);
            let left = i32::from_be_bytes([d[16], d[17], d[18], d[19]]);
            let bottom = i32::from_be_bytes([d[20], d[21], d[22], d[23]]);
            let right = i32::from_be_bytes([d[24], d[25], d[26], d[27]]);
            let depth = i16::from_be_bytes([d[28], d[29]]);
            let compression = d[30];

            let vma_h = (bottom - top) as isize;
            let vma_w = (right - left) as isize;

            if vma_h > 0
                && vma_w > 0
                && ((vma_h as usize == h && vma_w as usize == w)
                    || (vma_h as usize == w && vma_w as usize == h))
            {
                println!("    Found at offset {}: ver={}, size={}, rect=({},{},{},{}) -> {}x{}, depth={}, comp={}",
                    test_offset, version, size, top, left, bottom, right, vma_w, vma_h, depth, compression);
            }
        }
    }

    println!("\nDone!");
    Ok(())
}
