use image::{GrayImage, Luma, Rgb, RgbImage};
use paintboard_lib::abr::AbrParser;
use std::fs::File;
use std::io::{Cursor, Read, Write};
use std::path::Path;

// Include the packbits_decode function here to avoid visibility issues if it's private
fn packbits_decode(input: &[u8], expected_len: usize) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(expected_len);
    let mut i = 0;
    while i < input.len() {
        if output.len() >= expected_len {
            break;
        }
        let b = input[i] as i8;
        i += 1;
        if b == -128 {
            // No-op
        } else if b >= 0 {
            // Literal run
            let count = (b as usize) + 1;
            if i + count > input.len() {
                // Determine if we can just copy what's left
                let remaining = input.len() - i;
                output.extend_from_slice(&input[i..i + remaining]);
                break;
            }
            output.extend_from_slice(&input[i..i + count]);
            i += count;
        } else {
            // Replicate run
            let count = ((-b) as usize) + 1;
            if i >= input.len() {
                break;
            }
            let val = input[i];
            i += 1;
            for _ in 0..count {
                output.push(val);
            }
        }
    }

    if output.len() < expected_len {
        return None;
    }
    Some(output)
}

fn save_rgb_planar(filename: &str, decoded: &[u8], width: u32, height: u32) {
    let area = (width * height) as usize;
    if decoded.len() < area * 3 {
        println!(
            "  [WARN] Data length {} too small for Planar RGB (need {})",
            decoded.len(),
            area * 3
        );
        return;
    }

    let (r_plane, rest) = decoded.split_at(area);
    let (g_plane, b_rest) = rest.split_at(area);
    let b_plane = &b_rest[..area];

    let mut img = RgbImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) as usize;
            img.put_pixel(x, y, Rgb([r_plane[i], g_plane[i], b_plane[i]]));
        }
    }
    img.save(filename).expect("Failed to save image");
    println!("  Saved {}", filename);
}

fn save_rgb_interleaved(filename: &str, decoded: &[u8], width: u32, height: u32) {
    let area = (width * height) as usize;
    if decoded.len() < area * 3 {
        println!(
            "  [WARN] Data length {} too small for Interleaved RGB (need {})",
            decoded.len(),
            area * 3
        );
        return;
    }

    let mut img = RgbImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) as usize;
            let offset = i * 3;
            if offset + 2 < decoded.len() {
                img.put_pixel(
                    x,
                    y,
                    Rgb([decoded[offset], decoded[offset + 1], decoded[offset + 2]]),
                );
            }
        }
    }
    img.save(filename).expect("Failed to save image");
    println!("  Saved {}", filename);
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path_str = r"f:\CodeProjects\PaintBoard\abr\liuyang_paintbrushes.abr";
    println!("DEBUGGING ABR: {}", path_str);

    let mut file = File::open(path_str)?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)?;

    println!("File size: {} bytes", buffer.len());

    let abr = AbrParser::parse(&buffer).expect("Failed to parse ABR");

    println!("Patterns found: {}", abr.patterns.len());

    let output_dir = Path::new(r"f:\CodeProjects\PaintBoard\debug_output");
    if !output_dir.exists() {
        std::fs::create_dir_all(output_dir)?;
    }

    for (idx, pattern) in abr.patterns.iter().enumerate() {
        println!("\nPattern #{}: {} (ID: {})", idx, pattern.name, pattern.id);
        println!("  Size: {}x{}", pattern.width, pattern.height);
        println!("  Mode: {:?}", pattern.mode); // 3=RGB, 1=Gray
        println!("  Raw Data Length: {}", pattern.data.len());

        let expected_pixels = (pattern.width * pattern.height) as usize;
        let expected_bytes = if pattern.mode == 3 {
            expected_pixels * 3
        } else {
            expected_pixels
        };

        println!("  Expected Bytes: {}", expected_bytes);

        // STRATEGY 1: Raw Grayscale Check
        // If data length is >= expected pixels, check if overhead is small-ish (implying header)
        if pattern.mode == 1 && pattern.data.len() >= expected_pixels {
            let overhead = pattern.data.len() - expected_pixels;
            println!("  [Strategy 1: Raw Check] Overhead: {}", overhead);

            // Heuristic: If overhead is small (< 5000 bytes) and consistent with a header
            // Or if just fits.
            if overhead < 5000 {
                // assume raw data at end
                let raw_start = overhead;
                let raw_data = &pattern.data[raw_start..raw_start + expected_pixels];

                let mut img = GrayImage::new(pattern.width as u32, pattern.height as u32);
                for y in 0..pattern.height {
                    for x in 0..pattern.width {
                        let i = (y * pattern.width + x) as usize;
                        img.put_pixel(x as u32, y as u32, Luma([raw_data[i]]));
                    }
                }
                let filename = output_dir.join(format!("p{}_raw_gray_offset{}.png", idx, overhead));
                img.save(&filename).ok();
                println!("    ✓ Saved Raw Grayscale {}", filename.display());
            }
        }

        // STRATEGY 2: Universal Row Table Scan (RLE)
        // Only if scan_h > 0
        let scan_h = pattern.height as usize;
        let scan_w = pattern.width as usize;

        if scan_h > 0 {
            println!("  [Strategy 2: Universal RLE Scan]");
            // Scan for valid row table
            for rt_offset in 20..300.min(pattern.data.len()) {
                let table_size = scan_h * 2;
                if rt_offset + table_size > pattern.data.len() {
                    break;
                }

                let mut row_lengths: Vec<usize> = Vec::with_capacity(scan_h);
                let mut valid = true;

                for i in 0..scan_h {
                    let start = rt_offset + i * 2;
                    let len = i16::from_be_bytes([pattern.data[start], pattern.data[start + 1]]);
                    // Heuristic: valid row length
                    if len <= 0 || len as usize > scan_w * 2 {
                        valid = false;
                        break;
                    }
                    row_lengths.push(len as usize);
                }

                if valid {
                    let total_comp: usize = row_lengths.iter().sum();
                    // Basic sanity check: compressed data size
                    let remaining = pattern.data.len() - rt_offset - table_size;
                    if total_comp > remaining {
                        continue;
                    }

                    // Try decode
                    let data_start = rt_offset + table_size;
                    let mut decoded = Vec::with_capacity(expected_pixels);
                    let mut stream_pos = data_start;
                    let mut success = true;

                    for &comp_len in &row_lengths {
                        if stream_pos + comp_len > pattern.data.len() {
                            success = false;
                            break;
                        }
                        let row_data = &pattern.data[stream_pos..stream_pos + comp_len];
                        if let Some(row_decoded) = packbits_decode(row_data, scan_w) {
                            decoded.extend_from_slice(&row_decoded);
                        } else {
                            success = false;
                            break;
                        }
                        stream_pos += comp_len;
                    }

                    if success && decoded.len() == expected_pixels {
                        println!(
                            "    ✓✓ FOUND VALID ROW TABLE AT {}! Total compressed: {}",
                            rt_offset, total_comp
                        );
                        let mut img = GrayImage::new(scan_w as u32, scan_h as u32);
                        for y in 0..scan_h {
                            for x in 0..scan_w {
                                let i = y * scan_w + x;
                                img.put_pixel(x as u32, y as u32, Luma([decoded[i]]));
                            }
                        }
                        let filename =
                            output_dir.join(format!("p{}_univ_rt{}.png", idx, rt_offset));
                        img.save(&filename).ok();
                        println!("      Saved {}", filename.display());

                        // Break after finding one valid interpretation? Maybe not, keep scanning for safety in debug
                        // break;
                    }
                }
            }
        }

        // Limit to first 12 patterns
        if idx >= 11 {
            break;
        }
    }

    Ok(())
}

// Version of packbits_decode that returns bytes consumed and stops at exact len
fn packbits_decode_limit(input: &[u8], target_len: usize) -> Option<(Vec<u8>, usize)> {
    let mut output = Vec::with_capacity(target_len);
    let mut i = 0;
    while i < input.len() {
        if output.len() >= target_len {
            break;
        }
        let b = input[i] as i8;
        i += 1;
        if b == -128 {
            // No-op
        } else if b >= 0 {
            // Literal run
            let count = (b as usize) + 1;
            if output.len() + count > target_len {
                if i + count > input.len() {
                    return None;
                }
                output.extend_from_slice(&input[i..i + count]);
                i += count;
                break;
            }

            if i + count > input.len() {
                return None;
            }
            output.extend_from_slice(&input[i..i + count]);
            i += count;
        } else {
            // Replicate run
            let count = ((-b) as usize) + 1;
            if i >= input.len() {
                return None;
            }
            let val = input[i];
            i += 1;

            let remaining_needed = target_len - output.len();
            let actual_count = std::cmp::min(count, remaining_needed);

            for _ in 0..actual_count {
                output.push(val);
            }

            if output.len() == target_len {
                break;
            }
        }
    }

    if output.len() < target_len {
        return None;
    }
    Some((output, i))
}
