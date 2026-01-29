/// Try direct RLE decode for Pattern #6
use image::{GrayImage, Luma};
use paintboard_lib::abr::AbrParser;
use std::fs::File;
use std::io::Read;
use std::path::Path;

fn packbits_decode(input: &[u8], expected_len: usize) -> Option<Vec<u8>> {
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let abr_path = Path::new("f:/CodeProjects/PaintBoard/abr/liuyang_paintbrushes.abr");
    let mut file = File::open(abr_path)?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)?;

    let abr = AbrParser::parse(&data)?;
    let pattern = &abr.patterns[6];

    println!(
        "Pattern #6: {} ({}x{})",
        pattern.name.trim_end_matches('\0'),
        pattern.width,
        pattern.height
    );
    println!(
        "Mode: {}, Data Length: {}\n",
        pattern.mode,
        pattern.data.len()
    );

    let width = pattern.width as usize; // 1996
    let height = pattern.height as usize; // 1804
    let expected = width * height; // 3600784

    let output_dir = Path::new("f:/CodeProjects/PaintBoard/debug_output/p6_test");
    if !output_dir.exists() {
        std::fs::create_dir_all(output_dir)?;
    }

    // The structure appears to be:
    // [0]: mode/type (03)
    // [1-4]: size (00 36 F2 27 = 3600935)
    // [5-?]: header with dimensions
    // Then row table + RLE data

    // Looking at the hex:
    // 0x18 (24): 00 00 00 01 = compression type?
    // 0x1E (30): 00 36 F1 A7 = another size (3600807)

    // Try: at offset 31 we have "A7 00 00 00 08..."
    // This could be a VMA-like structure

    println!("Trying different offsets for row table:");

    for row_table_offset in [31, 35, 38, 39, 55, 56, 57, 58] {
        // Assume row table with 2-byte lengths
        if row_table_offset + height * 2 >= pattern.data.len() {
            continue;
        }

        let mut row_lengths: Vec<usize> = Vec::new();
        let mut valid = true;

        for i in 0..height {
            let idx = row_table_offset + i * 2;
            let len = u16::from_be_bytes([pattern.data[idx], pattern.data[idx + 1]]) as usize;
            if len > 5000 {
                // Max reasonable for compressed row
                valid = false;
                break;
            }
            row_lengths.push(len);
        }

        if !valid {
            println!("  Offset {}: Invalid row lengths", row_table_offset);
            continue;
        }

        let total_compressed: usize = row_lengths.iter().sum();
        let data_start = row_table_offset + height * 2;

        println!(
            "  Offset {}: First 5 lengths={:?}, total={}, data_start={}",
            row_table_offset,
            &row_lengths[..5],
            total_compressed,
            data_start
        );

        if data_start + total_compressed > pattern.data.len() {
            println!(
                "    Not enough data ({} + {} > {})",
                data_start,
                total_compressed,
                pattern.data.len()
            );
            continue;
        }

        // Try to decode
        let mut decoded = Vec::with_capacity(expected);
        let mut pos = data_start;
        let mut success = true;

        for (row_idx, &comp_len) in row_lengths.iter().enumerate() {
            if pos + comp_len > pattern.data.len() {
                success = false;
                break;
            }

            // PackBits decode for one row
            let mut row = Vec::with_capacity(width);
            let mut i = 0;
            let input = &pattern.data[pos..pos + comp_len];

            while i < input.len() && row.len() < width {
                let b = input[i] as i8;
                i += 1;

                if b == -128 {
                } else if b >= 0 {
                    let count = (b as usize) + 1;
                    for j in 0..count.min(width - row.len()) {
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
                        for _ in 0..count.min(width - row.len()) {
                            row.push(val);
                        }
                    }
                }
            }

            if row.len() != width {
                success = false;
                println!(
                    "    Row {} decode failed: got {} bytes, expected {}",
                    row_idx,
                    row.len(),
                    width
                );
                break;
            }

            decoded.extend(row);
            pos += comp_len;

            if row_idx < 3 {
                println!(
                    "    Row {}: decoded {} bytes from {} compressed",
                    row_idx, width, comp_len
                );
            }
        }

        if success && decoded.len() == expected {
            println!("    ✓ Successfully decoded {} bytes!", decoded.len());

            // Save image
            let mut img = GrayImage::new(width as u32, height as u32);
            for y in 0..height {
                for x in 0..width {
                    img.put_pixel(x as u32, y as u32, Luma([decoded[y * width + x]]));
                }
            }

            let filename = output_dir.join(format!("p6_offset{}.png", row_table_offset));
            img.save(&filename)?;
            println!("    ✓ SAVED: {}", filename.display());
            break;
        } else if !decoded.is_empty() {
            println!(
                "    Partial decode: {} bytes (expected {})",
                decoded.len(),
                expected
            );
        }
    }

    println!("\nDone!");
    Ok(())
}
