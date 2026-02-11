#![allow(clippy::unwrap_used)]

/// Correct ABR pattern decoder based on discovered structure
/// Handles both normal and swapped width/height in VMA rects
use image::{GrayImage, Luma, Rgba, RgbaImage};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use sutu_lib::abr::AbrParser;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let abr_path = Path::new("f:/CodeProjects/PaintBoard/abr/liuyang_paintbrushes.abr");
    let mut file = File::open(abr_path)?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)?;

    let abr = AbrParser::parse(&data)?;

    println!("CORRECT ABR PATTERN DECODER v2");
    println!("==============================\n");

    let output_dir = Path::new("f:/CodeProjects/PaintBoard/debug_output/correct_decode");
    if !output_dir.exists() {
        std::fs::create_dir_all(output_dir)?;
    }

    for (idx, pattern) in abr.patterns.iter().enumerate() {
        println!(
            "Pattern #{}: {} ({}x{})",
            idx,
            pattern.name.trim_end_matches('\0'),
            pattern.width,
            pattern.height
        );
        println!(
            "  Mode: {} ({})",
            pattern.mode,
            if pattern.mode == 3 {
                "RGB"
            } else if pattern.mode == 1 {
                "Grayscale"
            } else {
                "Unknown"
            }
        );
        println!("  Data Length: {}", pattern.data.len());

        let pattern_width = pattern.width as usize;
        let pattern_height = pattern.height as usize;
        let n_channels = if pattern.mode == 3 { 3 } else { 1 };

        // Search for VMA header
        let mut vma_info: Option<(usize, usize, usize)> = None; // (offset, vma_width, vma_height)

        for test_offset in 0..1000 {
            if test_offset + 31 > pattern.data.len() {
                break;
            }

            let d = &pattern.data[test_offset..];

            let version = i32::from_be_bytes([d[0], d[1], d[2], d[3]]);
            let size = u32::from_be_bytes([d[4], d[5], d[6], d[7]]);
            let top = i32::from_be_bytes([d[12], d[13], d[14], d[15]]);
            let left = i32::from_be_bytes([d[16], d[17], d[18], d[19]]);
            let bottom = i32::from_be_bytes([d[20], d[21], d[22], d[23]]);
            let right = i32::from_be_bytes([d[24], d[25], d[26], d[27]]);
            let depth = i16::from_be_bytes([d[28], d[29]]);
            let compression = d[30];

            // Use checked_sub to prevent overflow panic
            let Some(h_diff) = bottom.checked_sub(top) else {
                continue;
            };
            let Some(w_diff) = right.checked_sub(left) else {
                continue;
            };

            if h_diff <= 0 || w_diff <= 0 {
                continue;
            }

            // VMA dimensions
            let vma_height = h_diff as usize;
            let vma_width = w_diff as usize;

            // Check if dimensions match (allow swapped)
            let dims_match = (vma_height == pattern_height && vma_width == pattern_width)
                || (vma_height == pattern_width && vma_width == pattern_height);

            if (0..=10).contains(&version)
                && size > 0
                && size < 10000000
                && dims_match
                && depth == 8
                && compression <= 1
            {
                println!(
                    "  Found VMA at offset {}: ver={}, size={}, rect={}x{}, compression={}",
                    test_offset, version, size, vma_width, vma_height, compression
                );
                vma_info = Some((test_offset, vma_width, vma_height));
                break;
            }
        }

        if vma_info.is_none() {
            println!("  ✗ No valid VMA header found\n");
            continue;
        }

        let (vma_start, actual_width, actual_height) = vma_info.unwrap();
        let mut channels: Vec<Vec<u8>> = Vec::new();
        let mut offset = vma_start;

        for chan_idx in 0..n_channels {
            if offset + 31 > pattern.data.len() {
                println!("  ✗ Not enough data for channel {}\n", chan_idx);
                break;
            }

            let d = &pattern.data[offset..];

            let version = i32::from_be_bytes([d[0], d[1], d[2], d[3]]);
            let size = u32::from_be_bytes([d[4], d[5], d[6], d[7]]) as usize;
            let compression = d[30];

            println!(
                "  Channel {}: VMA at {}, ver={}, size={}, comp={}",
                chan_idx, offset, version, size, compression
            );

            let header_size = 31;
            let pixel_count = actual_width * actual_height;

            let chan_data = if compression == 0 {
                // Uncompressed
                if offset + header_size + pixel_count > pattern.data.len() {
                    println!("    ✗ Not enough uncompressed data");
                    break;
                }
                pattern.data[offset + header_size..offset + header_size + pixel_count].to_vec()
            } else {
                // RLE compressed with row table
                let row_table_size = actual_height * 2;
                if offset + header_size + row_table_size > pattern.data.len() {
                    println!("    ✗ Not enough data for row table");
                    break;
                }

                let mut row_lengths: Vec<usize> = Vec::new();
                for i in 0..actual_height {
                    let idx = offset + header_size + i * 2;
                    let len =
                        u16::from_be_bytes([pattern.data[idx], pattern.data[idx + 1]]) as usize;
                    row_lengths.push(len);
                }

                let data_start = offset + header_size + row_table_size;
                let mut decoded = Vec::with_capacity(pixel_count);
                let mut pos = data_start;

                for &comp_len in &row_lengths {
                    if pos + comp_len > pattern.data.len() {
                        break;
                    }

                    // PackBits decode
                    let mut row = Vec::with_capacity(actual_width);
                    let mut i = 0;
                    let input = &pattern.data[pos..pos + comp_len];

                    while i < input.len() && row.len() < actual_width {
                        let b = input[i] as i8;
                        i += 1;

                        if b == -128 {
                        } else if b >= 0 {
                            let count = (b as usize) + 1;
                            for j in 0..count.min(actual_width - row.len()) {
                                if i + j < input.len() {
                                    row.push(input[i + j]);
                                }
                            }
                            i += count;
                        } else {
                            let count = ((-b) as usize) + 1;
                            if i < input.len() {
                                let val = input[i];
                                i += 1;
                                for _ in 0..count.min(actual_width - row.len()) {
                                    row.push(val);
                                }
                            }
                        }
                    }

                    decoded.extend(row);
                    pos += comp_len;
                }

                decoded
            };

            if chan_data.len() == pixel_count {
                println!("    ✓ Decoded {} bytes", chan_data.len());
                channels.push(chan_data);

                // Move to next channel
                // Total consumed = 8 + size (version + size fields, then size bytes)
                offset += 8 + size;
            } else {
                println!(
                    "    ✗ Size mismatch: {} vs expected {}",
                    chan_data.len(),
                    pixel_count
                );
                break;
            }
        }

        if channels.len() == n_channels {
            let safe_name: String = pattern
                .name
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c == ' ')
                .take(40)
                .collect::<String>()
                .trim()
                .replace(' ', "_");

            if pattern.mode == 3 {
                let mut img = RgbaImage::new(actual_width as u32, actual_height as u32);
                for y in 0..actual_height {
                    for x in 0..actual_width {
                        let i = y * actual_width + x;
                        let r = channels[0][i];
                        let g = channels[1][i];
                        let b = channels[2][i];
                        img.put_pixel(x as u32, y as u32, Rgba([r, g, b, 255]));
                    }
                }
                let filename = output_dir.join(format!("p{}_{}.png", idx, safe_name));
                img.save(&filename)?;
                println!("  ✓ SAVED RGB: {}\n", filename.display());
            } else {
                let mut img = GrayImage::new(actual_width as u32, actual_height as u32);
                for y in 0..actual_height {
                    for x in 0..actual_width {
                        img.put_pixel(
                            x as u32,
                            y as u32,
                            Luma([channels[0][y * actual_width + x]]),
                        );
                    }
                }
                let filename = output_dir.join(format!("p{}_{}.png", idx, safe_name));
                img.save(&filename)?;
                println!("  ✓ SAVED Grayscale: {}\n", filename.display());
            }
        } else {
            println!("  ✗ Failed to decode all channels\n");
        }
    }

    println!("Done!");
    Ok(())
}
