/// Test GIMP's 37-byte skip approach
use image::{GrayImage, Luma, Rgba, RgbaImage};
use paintboard_lib::abr::AbrParser;
use std::fs::File;
use std::io::Read;
use std::path::Path;

fn packbits_decode_row(input: &[u8], expected_len: usize) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(expected_len);
    let mut i = 0;

    while i < input.len() && output.len() < expected_len {
        let b = input[i] as i8;
        i += 1;

        if b == -128 {
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

/// Decode a VMA channel at given offset
/// Returns (decoded_data, bytes_consumed)
fn decode_vma_channel(data: &[u8], width: usize, height: usize) -> Option<(Vec<u8>, usize)> {
    if data.len() < 31 {
        println!("      Data too short: {}", data.len());
        return None;
    }

    // VMA header (31 bytes):
    // 0-3: version (BE i32)
    // 4-7: size (BE i32) - bytes after this field
    // 8-11: depth/dummy (BE i32)
    // 12-15: top (BE i32)
    // 16-19: left (BE i32)
    // 20-23: bottom (BE i32)
    // 24-27: right (BE i32)
    // 28-29: depth (BE i16)
    // 30: compression (0=raw, 1=RLE)

    let version = i32::from_be_bytes([data[0], data[1], data[2], data[3]]);
    let size = i32::from_be_bytes([data[4], data[5], data[6], data[7]]) as usize;
    let top = i32::from_be_bytes([data[12], data[13], data[14], data[15]]);
    let left = i32::from_be_bytes([data[16], data[17], data[18], data[19]]);
    let bottom = i32::from_be_bytes([data[20], data[21], data[22], data[23]]);
    let right = i32::from_be_bytes([data[24], data[25], data[26], data[27]]);
    let depth = i16::from_be_bytes([data[28], data[29]]);
    let compression = data[30];

    println!(
        "      VMA: ver={}, size={}, rect=({},{},{},{}), depth={}, comp={}",
        version, size, top, left, bottom, right, depth, compression
    );

    if top < 0 || left < 0 || bottom <= top || right <= left {
        return None;
    }

    let vma_width = (right - left) as usize;
    let vma_height = (bottom - top) as usize;

    if vma_width != width || vma_height != height {
        println!(
            "      Dimension mismatch: VMA {}x{} vs expected {}x{}",
            vma_width, vma_height, width, height
        );
        return None;
    }

    if depth != 8 {
        println!("      Unsupported depth: {}", depth);
        return None;
    }

    let pixel_count = width * height;
    let header_size = 31;

    let decoded = if compression == 0 {
        if data.len() < header_size + pixel_count {
            return None;
        }
        data[header_size..header_size + pixel_count].to_vec()
    } else if compression == 1 {
        // RLE with row table
        let row_table_size = height * 2;
        if data.len() < header_size + row_table_size {
            return None;
        }

        let mut row_lengths = Vec::with_capacity(height);
        for i in 0..height {
            let offset = header_size + i * 2;
            let len = u16::from_be_bytes([data[offset], data[offset + 1]]) as usize;
            row_lengths.push(len);
        }

        let data_start = header_size + row_table_size;
        let mut decoded = Vec::with_capacity(pixel_count);
        let mut offset = data_start;

        for &comp_len in &row_lengths {
            if offset + comp_len > data.len() {
                return None;
            }

            if let Some(row_data) = packbits_decode_row(&data[offset..offset + comp_len], width) {
                decoded.extend(row_data);
            } else {
                return None;
            }
            offset += comp_len;
        }
        decoded
    } else {
        return None;
    };

    if decoded.len() != pixel_count {
        return None;
    }

    let total_consumed = 8 + size;
    Some((decoded, total_consumed))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let abr_path = Path::new("f:/CodeProjects/PaintBoard/abr/liuyang_paintbrushes.abr");
    let mut file = File::open(abr_path)?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)?;

    let abr = AbrParser::parse(&data)?;

    println!("GIMP 37-BYTE SKIP TEST");
    println!("======================\n");

    let output_dir = Path::new("f:/CodeProjects/PaintBoard/debug_output/gimp_skip");
    if !output_dir.exists() {
        std::fs::create_dir_all(output_dir)?;
    }

    let pattern = &abr.patterns[0];
    println!(
        "Pattern: {} ({}x{})",
        pattern.name.trim_end_matches('\0'),
        pattern.width,
        pattern.height
    );
    println!("Mode: {}", pattern.mode);
    println!("Data Length: {}\n", pattern.data.len());

    // Print hex for pattern ID area
    println!("First 80 bytes of pattern.data:");
    for row in 0..5 {
        let start = row * 16;
        print!("  {:04X}: ", start);
        for i in start..(start + 16).min(pattern.data.len()) {
            print!("{:02X} ", pattern.data[i]);
        }
        println!();
    }

    let width = pattern.width as usize;
    let height = pattern.height as usize;
    let n_channels = if pattern.mode == 3 { 3 } else { 1 };

    // Try different skip values before VMA header
    // GIMP uses 37 bytes for pattern ID, but our parser already consumed the ID
    // So we need to find where the actual VMA data starts

    println!("\n--- Testing VMA header at different offsets ---");

    for skip in [
        0, 4, 8, 22, 24, 26, 28, 30, 32, 37, 40, 44, 48, 52, 56, 58, 60,
    ] {
        if skip + 31 > pattern.data.len() {
            continue;
        }

        println!("\nTrying skip={} (VMA header at offset {})", skip, skip);

        let mut offset = skip;
        let mut channels: Vec<Vec<u8>> = Vec::new();
        let mut success = true;

        for chan_idx in 0..n_channels {
            if offset >= pattern.data.len() {
                success = false;
                break;
            }

            println!("  Channel {} at offset {}:", chan_idx, offset);

            match decode_vma_channel(&pattern.data[offset..], width, height) {
                Some((chan_data, consumed)) => {
                    println!(
                        "    ✓ Decoded {} bytes, consumed {}",
                        chan_data.len(),
                        consumed
                    );
                    channels.push(chan_data);
                    offset += consumed;
                }
                None => {
                    println!("    ✗ Failed");
                    success = false;
                    break;
                }
            }
        }

        if success && channels.len() == n_channels {
            println!("  All channels decoded!");

            if pattern.mode == 3 {
                let mut img = RgbaImage::new(width as u32, height as u32);
                for y in 0..height {
                    for x in 0..width {
                        let i = y * width + x;
                        let r = channels[0][i];
                        let g = channels[1][i];
                        let b = channels[2][i];
                        img.put_pixel(x as u32, y as u32, Rgba([r, g, b, 255]));
                    }
                }

                let filename = output_dir.join(format!("bubbles_skip{}.png", skip));
                img.save(&filename)?;
                println!("  ✓ SAVED: {}", filename.display());
            } else {
                let mut img = GrayImage::new(width as u32, height as u32);
                for y in 0..height {
                    for x in 0..width {
                        let i = y * width + x;
                        img.put_pixel(x as u32, y as u32, Luma([channels[0][i]]));
                    }
                }

                let filename = output_dir.join(format!("pattern_skip{}.png", skip));
                img.save(&filename)?;
                println!("  ✓ SAVED: {}", filename.display());
            }
        }
    }

    println!("\nDone!");
    Ok(())
}
