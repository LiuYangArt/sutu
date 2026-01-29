/// Try different row strides for ABR patterns
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

    println!("ROW STRIDE TEST");
    println!("===============\n");

    let output_dir = Path::new("f:/CodeProjects/PaintBoard/debug_output/stride_test");
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

    // Decode enough data for testing different strides
    let max_decode = 25000; // More than 80*80*3
    let decoded = packbits_decode(&pattern.data, max_decode).expect("Failed to decode");
    println!("Decoded {} bytes\n", decoded.len());

    // Try different row strides
    // Maybe each row is padded to 4-byte boundary: 80 -> 80 (already multiple of 4)
    // Or maybe there's a header between each row

    for stride in [80usize, 81, 82, 84, 88, 96, 100, 128] {
        let plane_size = stride * height;
        let rgb_size = plane_size * 3;

        if rgb_size > decoded.len() {
            continue;
        }

        let mut img = RgbaImage::new(width as u32, height as u32);

        for y in 0..height {
            for x in 0..width {
                let r = decoded[y * stride + x];
                let g = decoded[plane_size + y * stride + x];
                let b = decoded[2 * plane_size + y * stride + x];
                img.put_pixel(x as u32, y as u32, Rgba([r, g, b, 255]));
            }
        }

        let filename = output_dir.join(format!("bubbles_stride{}.png", stride));
        img.save(&filename)?;
        println!(
            "Saved: {} (stride={}, plane_size={})",
            filename.display(),
            stride,
            plane_size
        );
    }

    // Also try: maybe channels are interleaved per-row (R row, G row, B row, R row, G row, B row, ...)
    println!("\n--- Trying row-interleaved format ---");
    {
        let mut img = RgbaImage::new(width as u32, height as u32);
        let row_size = width; // 80

        for y in 0..height {
            for x in 0..width {
                let r = decoded[(y * 3 + 0) * row_size + x];
                let g = decoded[(y * 3 + 1) * row_size + x];
                let b = decoded[(y * 3 + 2) * row_size + x];
                img.put_pixel(x as u32, y as u32, Rgba([r, g, b, 255]));
            }
        }

        let filename = output_dir.join("bubbles_row_interleaved.png");
        img.save(&filename)?;
        println!("Saved: {} (row interleaved)", filename.display());
    }

    // Try: maybe there's a header before the actual image data
    // and we need to find where the real data starts
    println!("\n--- Trying to find valid grayscale image start ---");

    // For a grayscale reference, let's just show the first 3 planes as separate images
    for (plane_idx, plane_name) in [(0, "R"), (1, "G"), (2, "B")].iter() {
        let offset = plane_idx * width * height;

        let mut img = RgbaImage::new(width as u32, height as u32);
        for y in 0..height {
            for x in 0..width {
                let v = decoded[offset + y * width + x];
                img.put_pixel(x as u32, y as u32, Rgba([v, v, v, 255]));
            }
        }

        let filename = output_dir.join(format!("bubbles_plane_{}.png", plane_name));
        img.save(&filename)?;
        println!("Saved: {} (plane {})", filename.display(), plane_name);
    }

    println!("\nDone!");
    Ok(())
}
