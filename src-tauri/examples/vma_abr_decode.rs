/// Multi-channel VMA ABR pattern decoder
/// Based on GIMP's gimppattern-load.c
use image::{GrayImage, Luma, Rgba, RgbaImage};
use paintboard_lib::abr::AbrParser;
use std::fs::File;
use std::io::Read;
use std::path::Path;

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c == ' ' || *c == '.')
        .take(40)
        .collect::<String>()
        .trim()
        .replace(' ', "_")
        .trim_end_matches('\0')
        .to_string()
}

/// Decode a VMA channel
/// Returns (decoded_data, bytes_consumed)
fn decode_vma_channel(
    data: &[u8],
    expected_width: usize,
    expected_height: usize,
) -> Option<(Vec<u8>, usize)> {
    if data.len() < 31 {
        println!("      VMA data too short: {}", data.len());
        return None;
    }

    // VMA Channel header (31 bytes):
    // 0-3: version (4 bytes)
    // 4-7: size (4 bytes) - size of data after this field
    // 8-11: dummy (4 bytes)
    // 12-15: top (4 bytes)
    // 16-19: left (4 bytes)
    // 20-23: bottom (4 bytes)
    // 24-27: right (4 bytes)
    // 28-29: depth (2 bytes)
    // 30: compression (1 byte)

    let version = i32::from_be_bytes([data[0], data[1], data[2], data[3]]);
    let size = i32::from_be_bytes([data[4], data[5], data[6], data[7]]) as usize;

    let top = i32::from_be_bytes([data[12], data[13], data[14], data[15]]);
    let left = i32::from_be_bytes([data[16], data[17], data[18], data[19]]);
    let bottom = i32::from_be_bytes([data[20], data[21], data[22], data[23]]);
    let right = i32::from_be_bytes([data[24], data[25], data[26], data[27]]);
    let depth = i16::from_be_bytes([data[28], data[29]]);
    let compression = data[30];

    // Check for valid rect values - if any are negative or too large, dimensions are wrong
    if top < 0
        || left < 0
        || bottom < 0
        || right < 0
        || bottom <= top
        || right <= left
        || (bottom - top) as usize > 65536
        || (right - left) as usize > 65536
    {
        println!(
            "      VMA invalid rect: ({},{},{},{})",
            top, left, bottom, right
        );
        return None;
    }

    let width = (right - left) as usize;
    let height = (bottom - top) as usize;

    println!(
        "      VMA: ver={}, size={}, rect=({},{},{},{}), dim={}x{}, depth={}, comp={}",
        version, size, top, left, bottom, right, width, height, depth, compression
    );

    if width != expected_width || height != expected_height {
        println!(
            "      VMA dimension mismatch: {}x{} vs expected {}x{}",
            width, height, expected_width, expected_height
        );
        return None;
    }

    if depth != 8 {
        println!("      VMA unsupported depth: {}", depth);
        return None;
    }

    let pixel_count = width * height;
    let header_size = 31;

    let decoded = if compression == 0 {
        // Uncompressed
        if data.len() < header_size + pixel_count {
            println!("      VMA not enough raw data");
            return None;
        }
        data[header_size..header_size + pixel_count].to_vec()
    } else if compression == 1 {
        // RLE with row table
        let row_table_size = height * 2;
        if data.len() < header_size + row_table_size {
            println!("      VMA not enough data for row table");
            return None;
        }

        // Read row lengths
        let mut row_lengths = Vec::with_capacity(height);
        for i in 0..height {
            let offset = header_size + i * 2;
            let len = i16::from_be_bytes([data[offset], data[offset + 1]]) as usize;
            row_lengths.push(len);
        }

        // Decode each row
        let data_start = header_size + row_table_size;
        let mut decoded = Vec::with_capacity(pixel_count);
        let mut offset = data_start;

        for (row_idx, &comp_len) in row_lengths.iter().enumerate() {
            if offset + comp_len > data.len() {
                println!(
                    "      VMA row {} overflow: offset {} + {} > {}",
                    row_idx,
                    offset,
                    comp_len,
                    data.len()
                );
                return None;
            }

            if let Some(row_data) = packbits_decode_row(&data[offset..offset + comp_len], width) {
                decoded.extend(row_data);
            } else {
                println!("      VMA failed to decode row {}", row_idx);
                return None;
            }
            offset += comp_len;
        }
        decoded
    } else {
        println!("      VMA unsupported compression: {}", compression);
        return None;
    };

    if decoded.len() != pixel_count {
        println!(
            "      VMA decoded size mismatch: {} vs {}",
            decoded.len(),
            pixel_count
        );
        return None;
    }

    // Total bytes consumed: 8 (version + size fields) + size
    let total_consumed = 8 + size;
    Some((decoded, total_consumed))
}

fn packbits_decode_row(input: &[u8], expected_len: usize) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(expected_len);
    let mut i = 0;

    while i < input.len() && output.len() < expected_len {
        let b = input[i] as i8;
        i += 1;

        if b == -128 {
            // No-op
        } else if b >= 0 {
            let count = (b as usize) + 1;
            let to_copy = count.min(expected_len - output.len()).min(input.len() - i);
            output.extend_from_slice(&input[i..i + to_copy]);
            i += count;
        } else {
            let count = ((-b) as usize) + 1;
            if i >= input.len() {
                break;
            }
            let val = input[i];
            i += 1;
            for _ in 0..count.min(expected_len - output.len()) {
                output.push(val);
            }
        }
    }

    if output.len() >= expected_len {
        output.truncate(expected_len);
        Some(output)
    } else {
        None
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let abr_path = Path::new("f:/CodeProjects/PaintBoard/abr/liuyang_paintbrushes.abr");
    let mut file = File::open(abr_path)?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)?;

    let abr = AbrParser::parse(&data)?;

    println!("MULTI-CHANNEL VMA ABR PATTERN DECODER");
    println!("=====================================");
    println!("ABR File: {}", abr_path.display());
    println!("Patterns found: {}\n", abr.patterns.len());

    let output_dir = Path::new("f:/CodeProjects/PaintBoard/debug_output/vma_decode");
    if !output_dir.exists() {
        std::fs::create_dir_all(output_dir)?;
    }

    for (idx, pattern) in abr.patterns.iter().enumerate() {
        let safe_name = sanitize_filename(&pattern.name);

        println!(
            "Pattern #{}: {} ({})",
            idx,
            pattern.name.trim_end_matches('\0'),
            pattern.id
        );
        println!("  Size: {}x{}", pattern.width, pattern.height);
        println!(
            "  Mode: {} ({})",
            pattern.mode,
            if pattern.mode == 1 {
                "Grayscale"
            } else if pattern.mode == 3 {
                "RGB"
            } else {
                "Unknown"
            }
        );
        println!("  Data Length: {}", pattern.data.len());

        // Print first 48 bytes for analysis
        if idx == 0 || pattern.data.len() < 1000 {
            print!("  First 48 bytes: ");
            for i in 0..48.min(pattern.data.len()) {
                print!("{:02X} ", pattern.data[i]);
            }
            println!();
        }

        let width = pattern.width as usize;
        let height = pattern.height as usize;
        let n_channels = if pattern.mode == 3 { 3 } else { 1 };

        let mut channels: Vec<Vec<u8>> = Vec::new();
        let mut offset = 0;
        let mut success = true;

        for chan_idx in 0..n_channels {
            println!("  Decoding channel {} at offset {}...", chan_idx, offset);

            if offset >= pattern.data.len() {
                println!("    ✗ Ran out of data");
                success = false;
                break;
            }

            match decode_vma_channel(&pattern.data[offset..], width, height) {
                Some((chan_data, consumed)) => {
                    println!(
                        "    ✓ Channel {} decoded, {} bytes consumed",
                        chan_idx, consumed
                    );
                    channels.push(chan_data);
                    offset += consumed;
                }
                None => {
                    println!("    ✗ Failed to decode channel {}", chan_idx);
                    success = false;
                    break;
                }
            }
        }

        if success && channels.len() == n_channels {
            if pattern.mode == 3 {
                // RGB
                let mut img = RgbaImage::new(pattern.width, pattern.height);
                let pixels = width * height;

                for y in 0..height {
                    for x in 0..width {
                        let i = y * width + x;
                        let r = channels[0][i];
                        let g = channels[1][i];
                        let b = channels[2][i];
                        img.put_pixel(x as u32, y as u32, Rgba([r, g, b, 255]));
                    }
                }

                let filename = output_dir.join(format!("p{}_{}.png", idx, safe_name));
                img.save(&filename)?;
                println!("  ✓ SAVED: {}", filename.display());
            } else {
                // Grayscale
                let mut img = GrayImage::new(pattern.width, pattern.height);

                for y in 0..height {
                    for x in 0..width {
                        let i = y * width + x;
                        img.put_pixel(x as u32, y as u32, Luma([channels[0][i]]));
                    }
                }

                let filename = output_dir.join(format!("p{}_{}.png", idx, safe_name));
                img.save(&filename)?;
                println!("  ✓ SAVED: {}", filename.display());
            }
        } else {
            println!("  ✗ Multi-channel decode failed");
        }

        println!();
    }

    println!("Done!");
    Ok(())
}
