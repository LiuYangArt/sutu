/// Simple ABR pattern decoder
/// Focused on correctly decoding RGB planar data
use image::{GrayImage, Luma, Rgba, RgbaImage};
use paintboard_lib::abr::AbrParser;
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// Sanitize a pattern name for use in filenames
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

/// Simple PackBits decode - decode until we have enough bytes
fn packbits_decode(input: &[u8], expected_len: usize) -> Option<Vec<u8>> {
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
            let to_add = count.min(expected_len - output.len());
            for _ in 0..to_add {
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

/// Try to find the correct data offset by searching for valid RLE-decoded data
fn find_data_offset_and_decode(data: &[u8], expected_len: usize) -> Option<(usize, Vec<u8>)> {
    // Try different starting offsets
    for offset in [0, 2, 4, 8, 22, 24, 26, 28, 30, 31, 32] {
        if offset >= data.len() {
            continue;
        }

        if let Some(decoded) = packbits_decode(&data[offset..], expected_len) {
            return Some((offset, decoded));
        }
    }
    None
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let abr_path = Path::new("f:/CodeProjects/PaintBoard/abr/liuyang_paintbrushes.abr");
    let mut file = File::open(abr_path)?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)?;

    let abr = AbrParser::parse(&data)?;

    println!("SIMPLE ABR PATTERN DECODER");
    println!("==========================");
    println!("ABR File: {}", abr_path.display());
    println!("Patterns found: {}\n", abr.patterns.len());

    let output_dir = Path::new("f:/CodeProjects/PaintBoard/debug_output/simple_decode");
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

        let width = pattern.width as usize;
        let height = pattern.height as usize;
        let pixels = width * height;

        let n_channels = if pattern.mode == 3 { 3 } else { 1 };
        let expected_decoded = pixels * n_channels;

        // Try to find a valid offset and decode
        match find_data_offset_and_decode(&pattern.data, expected_decoded) {
            Some((offset, decoded)) => {
                println!("  ✓ Decoded {} bytes from offset {}", decoded.len(), offset);

                if pattern.mode == 3 {
                    // RGB planar -> RGBA interleaved
                    let mut img = RgbaImage::new(pattern.width, pattern.height);

                    for y in 0..height {
                        for x in 0..width {
                            let i = y * width + x;
                            let r = decoded[i];
                            let g = decoded[pixels + i];
                            let b = decoded[2 * pixels + i];
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
                            img.put_pixel(x as u32, y as u32, Luma([decoded[i]]));
                        }
                    }

                    let filename = output_dir.join(format!("p{}_{}.png", idx, safe_name));
                    img.save(&filename)?;
                    println!("  ✓ SAVED: {}", filename.display());
                }
            }
            None => {
                println!("  ✗ Failed to decode with any offset");

                // Dump first 64 bytes for debugging
                println!("  First 64 bytes:");
                for row in 0..4 {
                    let start = row * 16;
                    let end = (start + 16).min(pattern.data.len());
                    if start >= pattern.data.len() {
                        break;
                    }

                    print!("    {:04X}: ", start);
                    for i in start..end {
                        print!("{:02X} ", pattern.data[i]);
                    }
                    println!();
                }
            }
        }

        println!();
    }

    println!("Done!");
    Ok(())
}
