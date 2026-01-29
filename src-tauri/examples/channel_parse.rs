/// Parse ABR pattern with channel-based structure
use image::{GrayImage, Luma, Rgba, RgbaImage};
use paintboard_lib::abr::AbrParser;
use std::fs::File;
use std::io::Read;
use std::path::Path;

fn packbits_decode_row(input: &[u8], expected_len: usize) -> Option<Vec<u8>> {
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

    println!("CHANNEL-BASED ABR PARSING");
    println!("=========================\n");

    let output_dir = Path::new("f:/CodeProjects/PaintBoard/debug_output/channel_parse");
    if !output_dir.exists() {
        std::fs::create_dir_all(output_dir)?;
    }

    let pattern = &abr.patterns[0];
    println!(
        "Pattern: {} ({}x{})",
        pattern.name.trim_end_matches('\0'),
        pattern.width,
        pattern.height
    );
    println!(
        "Mode: {} ({})",
        pattern.mode,
        if pattern.mode == 3 {
            "RGB"
        } else {
            "Grayscale"
        }
    );
    println!("Data Length: {}\n", pattern.data.len());

    // Hex dump of first 128 bytes
    println!("Image data hex (first 128 bytes):");
    for row in 0..8 {
        let start = row * 16;
        if start >= pattern.data.len() {
            break;
        }
        print!("  {:04X}: ", start);
        for i in start..(start + 16).min(pattern.data.len()) {
            print!("{:02X} ", pattern.data[i]);
        }
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

    let width = pattern.width as usize;
    let height = pattern.height as usize;

    // Analysis of first bytes:
    // 03 00 00 4B CD 00 00 00 00 00 00 00 00 00 00 00
    // ^^ might be n_channels (3 for RGB)
    //    ^^ ^^ ^^ ^^ this might be channel 0 size or another header

    // Let's try: byte 0 = n_channels
    let n_channels_byte = pattern.data[0];
    println!("\nByte[0] = {} (possible n_channels)", n_channels_byte);

    // If n_channels = 3, next might be VMA for each channel
    // Or a simpler format with just sizes and RLE data

    // Let's try to find valid VMA headers at different offsets
    println!("\n--- Searching for VMA-like structures ---");

    for test_offset in 0..100 {
        if test_offset + 31 > pattern.data.len() {
            break;
        }

        let d = &pattern.data[test_offset..];

        let version = i32::from_be_bytes([d[0], d[1], d[2], d[3]]);
        let size = u32::from_be_bytes([d[4], d[5], d[6], d[7]]) as usize;
        let top = i32::from_be_bytes([d[12], d[13], d[14], d[15]]);
        let left = i32::from_be_bytes([d[16], d[17], d[18], d[19]]);
        let bottom = i32::from_be_bytes([d[20], d[21], d[22], d[23]]);
        let right = i32::from_be_bytes([d[24], d[25], d[26], d[27]]);
        let depth = i16::from_be_bytes([d[28], d[29]]);
        let compression = d[30];

        // Check if this looks like valid VMA
        if version >= 0
            && version <= 10
            && size > 0
            && size < 1000000
            && top >= 0
            && left >= 0
            && bottom > top
            && right > left
            && (bottom - top) as usize == height
            && (right - left) as usize == width
            && depth == 8
            && compression <= 1
        {
            println!("Found valid VMA at offset {}:", test_offset);
            println!(
                "  ver={}, size={}, rect=({},{},{},{}), depth={}, comp={}",
                version, size, top, left, bottom, right, depth, compression
            );

            // Try to decode this channel
            if compression == 1 {
                let row_table_size = height * 2;
                let header_size = 31;

                if test_offset + header_size + row_table_size < pattern.data.len() {
                    let mut row_lengths: Vec<usize> = Vec::new();
                    let mut valid = true;

                    for i in 0..height {
                        let idx = test_offset + header_size + i * 2;
                        let len =
                            u16::from_be_bytes([pattern.data[idx], pattern.data[idx + 1]]) as usize;
                        if len > 500 {
                            // Reasonable limit for compressed row of 80 pixels
                            valid = false;
                            break;
                        }
                        row_lengths.push(len);
                    }

                    if valid {
                        let total_compressed: usize = row_lengths.iter().sum();
                        let data_start = test_offset + header_size + row_table_size;

                        println!(
                            "  Row table: first 5 lengths = {:?}",
                            &row_lengths[..5.min(row_lengths.len())]
                        );
                        println!(
                            "  Total compressed: {}, data starts at {}",
                            total_compressed, data_start
                        );

                        if data_start + total_compressed <= pattern.data.len() {
                            // Try to decode
                            let mut decoded = Vec::with_capacity(width * height);
                            let mut offset = data_start;
                            let mut success = true;

                            for (row_idx, &comp_len) in row_lengths.iter().enumerate() {
                                if let Some(row_data) = packbits_decode_row(
                                    &pattern.data[offset..offset + comp_len],
                                    width,
                                ) {
                                    decoded.extend(row_data);
                                } else {
                                    println!("  Failed at row {}", row_idx);
                                    success = false;
                                    break;
                                }
                                offset += comp_len;
                            }

                            if success && decoded.len() == width * height {
                                println!("  ✓ Decoded channel: {} bytes", decoded.len());

                                // Save as grayscale to see if it looks correct
                                let mut img = GrayImage::new(width as u32, height as u32);
                                for y in 0..height {
                                    for x in 0..width {
                                        img.put_pixel(
                                            x as u32,
                                            y as u32,
                                            Luma([decoded[y * width + x]]),
                                        );
                                    }
                                }

                                let filename =
                                    output_dir.join(format!("channel_at_{}.png", test_offset));
                                img.save(&filename)?;
                                println!("  Saved: {}", filename.display());
                            }
                        }
                    }
                }
            }
        }
    }

    println!("\nDone!");
    Ok(())
}
