/// Little-Endian ABR pattern decoder
/// Based on hex analysis showing LE format
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

/// Decode VMA channel with LE integers
fn decode_vma_channel_le(
    data: &[u8],
    expected_width: usize,
    expected_height: usize,
) -> Option<(Vec<u8>, usize)> {
    if data.len() < 31 {
        return None;
    }

    // Try different header interpretations
    // Interpretation 1: Standard 31-byte header but with LE integers
    let version = i32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    let size = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;

    // Try LE for rect fields
    let top = i32::from_le_bytes([data[12], data[13], data[14], data[15]]);
    let left = i32::from_le_bytes([data[16], data[17], data[18], data[19]]);
    let bottom = i32::from_le_bytes([data[20], data[21], data[22], data[23]]);
    let right = i32::from_le_bytes([data[24], data[25], data[26], data[27]]);
    let depth = i16::from_le_bytes([data[28], data[29]]);
    let compression = data[30];

    println!(
        "      LE: ver={}, size={}, rect=({},{},{},{}), depth={}, comp={}",
        version, size, top, left, bottom, right, depth, compression
    );

    if top < 0 || left < 0 || bottom <= top || right <= left {
        return None;
    }

    let width = (right - left) as usize;
    let height = (bottom - top) as usize;

    if width != expected_width || height != expected_height {
        println!(
            "      LE dim mismatch: {}x{} vs {}x{}",
            width, height, expected_width, expected_height
        );
        return None;
    }

    if depth != 8 {
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
        // RLE with row table (2 bytes per row, LE)
        let row_table_size = height * 2;
        if data.len() < header_size + row_table_size {
            return None;
        }

        let mut row_lengths = Vec::with_capacity(height);
        for i in 0..height {
            let offset = header_size + i * 2;
            // Try both BE and LE for row lengths
            let len_be = i16::from_be_bytes([data[offset], data[offset + 1]]) as usize;
            let len_le = i16::from_le_bytes([data[offset], data[offset + 1]]) as usize;
            // Use whichever seems more reasonable
            let len = if len_be < 1000 && len_be > 0 {
                len_be
            } else {
                len_le
            };
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

    println!("LE ABR PATTERN DECODER - HEADER ANALYSIS");
    println!("========================================");

    let output_dir = Path::new("f:/CodeProjects/PaintBoard/debug_output/le_decode");
    if !output_dir.exists() {
        std::fs::create_dir_all(output_dir)?;
    }

    // Focus on Bubbles first
    let pattern = &abr.patterns[0];
    let safe_name = sanitize_filename(&pattern.name);

    println!(
        "Pattern #0: {} ({})",
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

    // Print first 64 bytes with analysis
    println!("\n  Hex dump with analysis:");
    for row in 0..4 {
        let start = row * 16;
        print!("  {:04X}: ", start);
        for i in start..(start + 16).min(pattern.data.len()) {
            print!("{:02X} ", pattern.data[i]);
        }
        println!();
    }

    println!("\n  Possible interpretations:");

    // Try different header sizes and row table formats
    for (header_size, desc) in [
        (26, "26-byte header"),
        (28, "28-byte header"),
        (30, "30-byte header"),
        (31, "31-byte header"),
    ] {
        println!("\n  === Try: {} + row table (240 rows) ===", desc);
        let n_rows = 80 * 3; // 240 rows for RGB planar
        let row_table_size = n_rows * 2;
        let data_start = header_size + row_table_size;

        if pattern.data.len() < header_size + row_table_size {
            println!("    Skipped: not enough data");
            continue;
        }

        // Read row lengths (BE u16)
        let mut row_lengths: Vec<usize> = Vec::new();
        let mut all_valid = true;
        for i in 0..n_rows {
            let offset = header_size + i * 2;
            let len = u16::from_be_bytes([pattern.data[offset], pattern.data[offset + 1]]) as usize;
            if len > 1000 {
                all_valid = false;
                break;
            }
            row_lengths.push(len);
        }

        if !all_valid {
            println!("    Skipped: row lengths out of range");
            continue;
        }

        let total_compressed: usize = row_lengths.iter().sum();
        println!(
            "    First 10 row lengths: {:?}",
            &row_lengths[..10.min(row_lengths.len())]
        );
        println!(
            "    Total compressed: {}, data_start: {}, expected_end: {}, actual: {}",
            total_compressed,
            data_start,
            data_start + total_compressed,
            pattern.data.len()
        );

        if data_start + total_compressed <= pattern.data.len() {
            // Try to decode
            let mut decoded = Vec::with_capacity(80 * 80 * 3);
            let mut offset = data_start;
            let mut success = true;

            for (row_idx, &comp_len) in row_lengths.iter().enumerate() {
                if offset + comp_len > pattern.data.len() {
                    println!("    Row {} overflow", row_idx);
                    success = false;
                    break;
                }

                if let Some(row_data) =
                    packbits_decode_row(&pattern.data[offset..offset + comp_len], 80)
                {
                    decoded.extend(row_data);
                } else {
                    println!("    Row {} decode failed (comp_len={})", row_idx, comp_len);
                    success = false;
                    break;
                }
                offset += comp_len;
            }

            if success && decoded.len() == 80 * 80 * 3 {
                println!("    ✓ Decoded {} bytes!", decoded.len());

                // Create RGB image (planar to interleaved)
                let mut img = RgbaImage::new(80, 80);
                let plane_size = 80 * 80;

                for y in 0..80 {
                    for x in 0..80 {
                        let i = y * 80 + x;
                        let r = decoded[i];
                        let g = decoded[plane_size + i];
                        let b = decoded[2 * plane_size + i];
                        img.put_pixel(x as u32, y as u32, Rgba([r, g, b, 255]));
                    }
                }

                let filename = output_dir.join(format!("p0_Bubbles_{}.png", header_size));
                img.save(&filename)?;
                println!("    ✓ SAVED: {}", filename.display());
            } else if success {
                println!(
                    "    Decoded {} bytes (expected {})",
                    decoded.len(),
                    80 * 80 * 3
                );
            }
        }
    }

    // Also try searching for the row table by looking for reasonable values
    println!("\n  === Searching for row table start ===");
    for start_offset in 0..60 {
        if start_offset + 240 * 2 + 1000 > pattern.data.len() {
            continue;
        }

        // Check if this looks like a row table
        let mut valid = true;
        let mut row_lengths: Vec<usize> = Vec::new();

        for i in 0..240 {
            let offset = start_offset + i * 2;
            let len = u16::from_be_bytes([pattern.data[offset], pattern.data[offset + 1]]) as usize;
            if len == 0 || len > 200 {
                // Each row of 80 pixels shouldn't compress to > 200 bytes
                valid = false;
                break;
            }
            row_lengths.push(len);
        }

        if valid {
            let total_compressed: usize = row_lengths.iter().sum();
            let data_start = start_offset + 480;

            if data_start + total_compressed <= pattern.data.len()
                && data_start + total_compressed + 500 >= pattern.data.len()
            {
                println!("    Found potential row table at offset {}", start_offset);
                println!("    First 10 lengths: {:?}", &row_lengths[..10]);
                println!(
                    "    Total compressed: {}, ends at: {}",
                    total_compressed,
                    data_start + total_compressed
                );

                // Try to decode
                let mut decoded = Vec::with_capacity(80 * 80 * 3);
                let mut offset = data_start;
                let mut success = true;

                for (row_idx, &comp_len) in row_lengths.iter().enumerate() {
                    if let Some(row_data) =
                        packbits_decode_row(&pattern.data[offset..offset + comp_len], 80)
                    {
                        decoded.extend(row_data);
                    } else {
                        success = false;
                        break;
                    }
                    offset += comp_len;
                }

                if success && decoded.len() == 80 * 80 * 3 {
                    println!("    ✓ Decoded successfully!");

                    let mut img = RgbaImage::new(80, 80);
                    let plane_size = 80 * 80;

                    for y in 0..80 {
                        for x in 0..80 {
                            let i = y * 80 + x;
                            let r = decoded[i];
                            let g = decoded[plane_size + i];
                            let b = decoded[2 * plane_size + i];
                            img.put_pixel(x as u32, y as u32, Rgba([r, g, b, 255]));
                        }
                    }

                    let filename =
                        output_dir.join(format!("p0_Bubbles_offset{}.png", start_offset));
                    img.save(&filename)?;
                    println!("    ✓ SAVED: {}", filename.display());
                }
            }
        }
    }

    println!("\nDone!");
    Ok(())
}
