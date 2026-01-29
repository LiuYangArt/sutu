/// Try different data start offsets for ABR patterns
use image::{Rgba, RgbaImage};
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

    println!("DATA OFFSET TEST");
    println!("================\n");

    let output_dir = Path::new("f:/CodeProjects/PaintBoard/debug_output/offset_test");
    if !output_dir.exists() {
        std::fs::create_dir_all(output_dir)?;
    }

    // Focus on Bubbles
    let pattern = &abr.patterns[0];
    println!(
        "Pattern: {} ({}x{})",
        pattern.name.trim_end_matches('\0'),
        pattern.width,
        pattern.height
    );
    println!("Data Length: {}", pattern.data.len());

    let width = pattern.width as usize; // 80
    let height = pattern.height as usize; // 80
    let plane_size = width * height; // 6400
    let rgb_size = plane_size * 3; // 19200

    // Print more hex
    println!("\nHex dump (first 128 bytes):");
    for row in 0..8 {
        let start = row * 16;
        print!("  {:04X}: ", start);
        for i in start..(start + 16).min(pattern.data.len()) {
            print!("{:02X} ", pattern.data[i]);
        }
        // Also show as ASCII
        print!(" |");
        for i in start..(start + 16).min(pattern.data.len()) {
            let c = pattern.data[i];
            if c >= 32 && c < 127 {
                print!("{}", c as char);
            } else {
                print!(".");
            }
        }
        println!("|");
    }

    // Try decoding from different offsets
    println!("\n--- Trying different data start offsets ---");

    for offset in [0, 2, 4, 8, 22, 24, 26, 28, 30, 31, 32, 38, 56, 58, 60, 62] {
        if offset >= pattern.data.len() {
            continue;
        }

        if let Some(decoded) = packbits_decode(&pattern.data[offset..], rgb_size) {
            println!(
                "\nOffset {}: Decoded {} bytes successfully",
                offset,
                decoded.len()
            );

            // Check if data looks reasonable (not all zeros or same value)
            let first_10: Vec<u8> = decoded.iter().take(10).cloned().collect();
            let last_10: Vec<u8> = decoded.iter().rev().take(10).cloned().collect();
            println!("  First 10: {:?}", first_10);
            println!("  Last 10:  {:?}", last_10);

            // Create image (planar RGB)
            let mut img = RgbaImage::new(width as u32, height as u32);

            for y in 0..height {
                for x in 0..width {
                    let i = y * width + x;
                    let r = decoded[i];
                    let g = decoded[plane_size + i];
                    let b = decoded[2 * plane_size + i];
                    img.put_pixel(x as u32, y as u32, Rgba([r, g, b, 255]));
                }
            }

            let filename = output_dir.join(format!("bubbles_offset{}.png", offset));
            img.save(&filename)?;
            println!("  Saved: {}", filename.display());
        } else {
            println!("Offset {}: Decode failed", offset);
        }
    }

    println!("\nDone!");
    Ok(())
}
