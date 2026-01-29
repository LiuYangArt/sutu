/// Decode Pattern #8 - fixed overflow
use image::{GrayImage, Luma};
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
    let pattern = &abr.patterns[8];

    println!(
        "Pattern #8: {} ({}x{})",
        pattern.name.trim_end_matches('\0'),
        pattern.width,
        pattern.height
    );
    println!("Mode: {} (Grayscale)", pattern.mode);
    println!("Data length: {}\n", pattern.data.len());

    let pattern_width = pattern.width as usize;
    let pattern_height = pattern.height as usize;

    println!("Searching for VMA...");

    for test_offset in 0..100 {
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

        // Use checked_sub to prevent overflow
        let Some(h_diff) = bottom.checked_sub(top) else {
            continue;
        };
        let Some(w_diff) = right.checked_sub(left) else {
            continue;
        };

        if h_diff <= 0 || w_diff <= 0 {
            continue;
        }

        let vma_height = h_diff as usize;
        let vma_width = w_diff as usize;

        // Check match with swapping
        let dims_match = (vma_height == pattern_height && vma_width == pattern_width)
            || (vma_height == pattern_width && vma_width == pattern_height);

        if dims_match && (0..=10).contains(&version) && depth == 8 && compression <= 1 {
            println!(
                "  Found VMA at offset {}: ver={}, size={}, rect={}x{}, comp={}",
                test_offset, version, size, vma_width, vma_height, compression
            );

            // Decode
            let actual_width = vma_width;
            let actual_height = vma_height;
            let pixel_count = actual_width * actual_height;

            println!("  Decoding {} pixels...", pixel_count);

            if compression == 0 {
                // Uncompressed
                let header_size = 31;
                let data_start = test_offset + header_size;
                let data_end = data_start + pixel_count;

                if data_end > pattern.data.len() {
                    println!(
                        "    Not enough data: need {} bytes, have {}",
                        data_end,
                        pattern.data.len()
                    );
                    continue;
                }

                let pixels = &pattern.data[data_start..data_end];

                // Save image
                let mut img = GrayImage::new(actual_width as u32, actual_height as u32);
                for y in 0..actual_height {
                    for x in 0..actual_width {
                        img.put_pixel(x as u32, y as u32, Luma([pixels[y * actual_width + x]]));
                    }
                }

                let output_dir =
                    Path::new("f:/CodeProjects/PaintBoard/debug_output/correct_decode");
                if !output_dir.exists() {
                    std::fs::create_dir_all(output_dir)?;
                }
                let filename = output_dir.join("p8_sparthtex01.png");
                img.save(&filename)?;
                println!("    Saved: {}", filename.display());
            }

            break;
        }
    }

    println!("\nDone!");
    Ok(())
}
