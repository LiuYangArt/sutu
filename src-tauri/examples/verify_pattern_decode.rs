//! Test script to verify pattern decode_image() matches correct_decode.rs output
//!
//! Run with: cargo run --example verify_pattern_decode

#![allow(warnings)]

use image::{GrayImage, Luma, Rgba, RgbaImage};
use paintboard_lib::abr::AbrParser;
use std::fs::File;
use std::io::Read;
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let abr_path = Path::new("f:/CodeProjects/PaintBoard/abr/liuyang_paintbrushes.abr");
    let mut file = File::open(abr_path)?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)?;

    let abr = AbrParser::parse(&data)?;

    println!("VERIFY PATTERN DECODE_IMAGE OUTPUT");
    println!("===================================\n");

    let output_dir = Path::new("f:/CodeProjects/PaintBoard/debug_output/verify_decode");
    if !output_dir.exists() {
        std::fs::create_dir_all(output_dir)?;
    }

    let mut success_count = 0;
    let mut fail_count = 0;

    for (idx, pattern) in abr.patterns.iter().enumerate() {
        let safe_name: String = pattern
            .name
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c == ' ')
            .take(40)
            .collect::<String>()
            .trim()
            .replace(' ', "_");

        // Use the integrated decode_image() method
        match pattern.decode_image() {
            Some(rgba_data) => {
                let expected_size = (pattern.width * pattern.height * 4) as usize;
                if rgba_data.len() != expected_size {
                    println!(
                        "✗ Pattern #{} '{}': Size mismatch {} vs expected {}",
                        idx,
                        pattern.name,
                        rgba_data.len(),
                        expected_size
                    );
                    fail_count += 1;
                    continue;
                }

                // Save the image
                let mut img = RgbaImage::new(pattern.width, pattern.height);
                for y in 0..pattern.height {
                    for x in 0..pattern.width {
                        let i = ((y * pattern.width + x) * 4) as usize;
                        let r = rgba_data[i];
                        let g = rgba_data[i + 1];
                        let b = rgba_data[i + 2];
                        let a = rgba_data[i + 3];
                        img.put_pixel(x, y, Rgba([r, g, b, a]));
                    }
                }

                let filename = output_dir.join(format!("decode_image_{}_{}.png", idx, safe_name));
                img.save(&filename)?;

                println!(
                    "✓ Pattern #{} '{}' ({}x{}, {}): Saved to {}",
                    idx,
                    pattern.name,
                    pattern.width,
                    pattern.height,
                    pattern.mode_name(),
                    filename.display()
                );
                success_count += 1;
            }
            None => {
                println!(
                    "✗ Pattern #{} '{}' ({}x{}, {}): decode_image() returned None",
                    idx,
                    pattern.name,
                    pattern.width,
                    pattern.height,
                    pattern.mode_name()
                );
                fail_count += 1;
            }
        }
    }

    println!("\n===================================");
    println!(
        "Results: {}/{} successful",
        success_count,
        success_count + fail_count
    );

    if fail_count > 0 {
        println!("\n⚠ {} patterns failed to decode!", fail_count);
    } else {
        println!("\n✓ All patterns decoded successfully!");
    }

    Ok(())
}
