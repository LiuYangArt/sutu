use byteorder::{BigEndian, ReadBytesExt};
/// Direct ABR parsing to understand structure
use std::fs::File;
use std::io::{Cursor, Read, Seek, SeekFrom};

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

    // Remove null terminator
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

    println!("DIRECT ABR PARSING");
    println!("==================\n");

    // Find PATT section
    let patt_pos = data.windows(4).position(|w| w == b"patt" || w == b"Patt");

    if patt_pos.is_none() {
        println!("No PATT section found");
        return Ok(());
    }

    let patt_pos = patt_pos.unwrap();
    println!(
        "PATT section found at offset: 0x{:X} ({})",
        patt_pos, patt_pos
    );

    // PATT section structure:
    // "Patt" or "patt" (4 bytes)
    // ? padding/version
    // Then patterns...

    // Let's dump around PATT to understand structure
    println!("\nHex around PATT:");
    let start = patt_pos.saturating_sub(8);
    for row in 0..6 {
        let offset = start + row * 16;
        print!("  {:06X}: ", offset);
        for i in 0..16 {
            if offset + i < data.len() {
                print!("{:02X} ", data[offset + i]);
            }
        }
        println!();
    }

    // After PATT signature, decode first pattern
    // Typical structure: 8Bim key signature, then section size, then "Patt", then pattern count, then patterns

    // Look for pattern size field (first 4 bytes of actual pattern)
    println!("\n--- Manually parsing first pattern ---");

    // Search for a likely pattern start (should have version=1, followed by mode=1 or 3)
    for search_start in patt_pos..patt_pos + 200 {
        if search_start + 16 > data.len() {
            break;
        }

        let pattern_size = u32::from_be_bytes([
            data[search_start],
            data[search_start + 1],
            data[search_start + 2],
            data[search_start + 3],
        ]) as usize;

        if pattern_size > 1000 && pattern_size < 100000 && search_start + pattern_size < data.len()
        {
            let version = u32::from_be_bytes([
                data[search_start + 4],
                data[search_start + 5],
                data[search_start + 6],
                data[search_start + 7],
            ]);
            let mode = u32::from_be_bytes([
                data[search_start + 8],
                data[search_start + 9],
                data[search_start + 10],
                data[search_start + 11],
            ]);
            let width = u16::from_be_bytes([data[search_start + 12], data[search_start + 13]]);
            let height = u16::from_be_bytes([data[search_start + 14], data[search_start + 15]]);
            let depth = u16::from_be_bytes([data[search_start + 16], data[search_start + 17]]);

            if version == 1
                && (mode == 1 || mode == 3)
                && width > 0
                && width < 5000
                && height > 0
                && height < 5000
            {
                println!(
                    "Potential pattern at offset 0x{:X} ({}):",
                    search_start, search_start
                );
                println!("  pattern_size: {}", pattern_size);
                println!("  version: {}", version);
                println!("  mode: {}", mode);
                println!("  width: {}, height: {}", width, height);
                println!("  depth: {}", depth);

                // Read name
                let pattern_data = &data[search_start + 4..search_start + 4 + pattern_size];
                let mut cursor = Cursor::new(pattern_data);
                cursor.set_position(14); // Skip version(4), mode(4), width(2), height(2), depth(2)

                if let Some(name) = read_unicode_string(&mut cursor) {
                    println!("  name: '{}'", name);

                    if let Some(id) = read_pascal_string(&mut cursor) {
                        println!("  id: '{}'", id);
                    }

                    // Calculate padding
                    let pos = cursor.position();
                    let padding = (4 - (pos % 4)) % 4;
                    cursor.seek(SeekFrom::Current(padding as i64)).ok();

                    let image_data_start = cursor.position() as usize;
                    let remaining_in_pattern = pattern_data.len() - image_data_start;

                    println!(
                        "  Image data starts at offset {} within pattern",
                        image_data_start
                    );
                    println!("  Image data length: {}", remaining_in_pattern);

                    // Dump first 64 bytes of image data
                    let image_data = &pattern_data[image_data_start..];
                    println!("\n  Image data hex (first 80 bytes):");
                    for row in 0..5 {
                        let offset = row * 16;
                        if offset >= image_data.len() {
                            break;
                        }
                        print!("    {:04X}: ", offset);
                        for i in 0..16.min(image_data.len() - offset) {
                            print!("{:02X} ", image_data[offset + i]);
                        }
                        println!();
                    }

                    // According to GIMP, after pattern name there should be pattern ID (37 bytes)
                    // But we already read the ID as Pascal string
                    // The remaining should be: VMA header for image data

                    // Check if image_data starts with valid VMA header
                    if image_data.len() >= 31 {
                        let vma_version = i32::from_be_bytes([
                            image_data[0],
                            image_data[1],
                            image_data[2],
                            image_data[3],
                        ]);
                        let vma_size = i32::from_be_bytes([
                            image_data[4],
                            image_data[5],
                            image_data[6],
                            image_data[7],
                        ]);

                        println!("\n  Checking VMA at offset 0:");
                        println!("    vma_version: {}", vma_version);
                        println!("    vma_size: {}", vma_size);

                        // It's NOT a valid VMA if version is millions
                        if vma_version > 100 || vma_version < 0 {
                            println!("    (Invalid - not a VMA header)");

                            // The first bytes might actually BE the VMA data directly
                            // Let's check if depth=24 case uses different format
                            println!("\n  Analyzing as Photoshop's planar format:");

                            // For depth=24 RGB patterns, Photoshop may use a simpler format:
                            // Just raw or RLE compressed planar data

                            // Check bytes 0-3 as a structure header
                            println!(
                                "    bytes[0-3] as u32 BE: {}",
                                u32::from_be_bytes([
                                    image_data[0],
                                    image_data[1],
                                    image_data[2],
                                    image_data[3]
                                ])
                            );
                            println!(
                                "    bytes[0-3] as u32 LE: {}",
                                u32::from_le_bytes([
                                    image_data[0],
                                    image_data[1],
                                    image_data[2],
                                    image_data[3]
                                ])
                            );

                            // Expected raw size: width * height * 3 for RGB
                            let expected = width as usize * height as usize * 3;
                            println!("    Expected raw size (RGB): {}", expected);
                            println!("    Actual image_data length: {}", image_data.len());
                        }
                    }
                }

                break;
            }
        }
    }

    println!("\nDone!");
    Ok(())
}
