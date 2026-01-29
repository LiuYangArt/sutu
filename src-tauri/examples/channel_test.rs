/// Try different channel arrangements for ABR patterns
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

    println!("CHANNEL ARRANGEMENT TEST");
    println!("========================\n");

    let output_dir = Path::new("f:/CodeProjects/PaintBoard/debug_output/channel_test");
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
    println!("Data Length: {}\n", pattern.data.len());

    let width = pattern.width as usize; // 80
    let height = pattern.height as usize; // 80
    let plane_size = width * height; // 6400

    // Decode full data
    let decoded = packbits_decode(&pattern.data, plane_size * 3).expect("Failed to decode");
    println!("Decoded {} bytes\n", decoded.len());

    // Try different channel orderings
    let orderings = [
        ("RGB", [0, 1, 2]),
        ("RBG", [0, 2, 1]),
        ("GRB", [1, 0, 2]),
        ("GBR", [1, 2, 0]),
        ("BRG", [2, 0, 1]),
        ("BGR", [2, 1, 0]),
    ];

    for (name, order) in orderings {
        let mut img = RgbaImage::new(width as u32, height as u32);

        for y in 0..height {
            for x in 0..width {
                let i = y * width + x;
                let c0 = decoded[order[0] * plane_size + i];
                let c1 = decoded[order[1] * plane_size + i];
                let c2 = decoded[order[2] * plane_size + i];
                img.put_pixel(x as u32, y as u32, Rgba([c0, c1, c2, 255]));
            }
        }

        let filename = output_dir.join(format!("bubbles_{}.png", name));
        img.save(&filename)?;
        println!("Saved: {} (order: {:?})", filename.display(), order);
    }

    // Try different start offsets for each channel
    println!("\n--- Testing channel offsets ---");

    // The user's screenshot suggests each channel might have its own header
    // Let's try decoding each channel separately

    // Decode more than needed and see where valid data might start
    let full_decode = packbits_decode(&pattern.data, pattern.data.len()).unwrap_or_default();
    println!(
        "Full decode: {} bytes from {} bytes compressed",
        full_decode.len(),
        pattern.data.len()
    );

    // Try offsets within the decoded data
    for r_start in [0usize, 1, 2, 4, 8] {
        for g_offset in [plane_size, plane_size + 1, plane_size + 2, plane_size + 4] {
            for b_offset in [
                plane_size * 2,
                plane_size * 2 + 1,
                plane_size * 2 + 2,
                plane_size * 2 + 4,
            ] {
                if r_start + plane_size > full_decode.len()
                    || g_offset + plane_size > full_decode.len()
                    || b_offset + plane_size > full_decode.len()
                {
                    continue;
                }

                let mut img = RgbaImage::new(width as u32, height as u32);

                for y in 0..height {
                    for x in 0..width {
                        let i = y * width + x;
                        let r = full_decode[r_start + i];
                        let g = full_decode[g_offset + i];
                        let b = full_decode[b_offset + i];
                        img.put_pixel(x as u32, y as u32, Rgba([r, g, b, 255]));
                    }
                }

                // Only save if offsets are non-standard
                if r_start != 0 || g_offset != plane_size || b_offset != plane_size * 2 {
                    let filename = output_dir.join(format!(
                        "bubbles_r{}g{}b{}.png",
                        r_start, g_offset, b_offset
                    ));
                    img.save(&filename)?;
                    println!(
                        "Saved: {} (r@{}, g@{}, b@{})",
                        filename.display(),
                        r_start,
                        g_offset,
                        b_offset
                    );
                }
            }
        }
    }

    // Also try: maybe the data is interleaved (R,G,B,R,G,B,...) instead of planar
    println!("\n--- Testing interleaved format ---");

    // RGB interleaved
    if full_decode.len() >= width * height * 3 {
        let mut img = RgbaImage::new(width as u32, height as u32);

        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                let r = full_decode[i];
                let g = full_decode[i + 1];
                let b = full_decode[i + 2];
                img.put_pixel(x as u32, y as u32, Rgba([r, g, b, 255]));
            }
        }

        let filename = output_dir.join("bubbles_interleaved_RGB.png");
        img.save(&filename)?;
        println!("Saved: {} (interleaved RGB)", filename.display());

        // BGR interleaved
        let mut img = RgbaImage::new(width as u32, height as u32);

        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                let b = full_decode[i];
                let g = full_decode[i + 1];
                let r = full_decode[i + 2];
                img.put_pixel(x as u32, y as u32, Rgba([r, g, b, 255]));
            }
        }

        let filename = output_dir.join("bubbles_interleaved_BGR.png");
        img.save(&filename)?;
        println!("Saved: {} (interleaved BGR)", filename.display());
    }

    println!("\nDone!");
    Ok(())
}
