#![allow(warnings)]
use std::collections::HashMap;
use std::path::Path;
use sutu_lib::abr::AbrParser;

fn main() {
    // Setup tracing
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .init();

    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    println!("Reading ABR: {:?}", path);
    let data = std::fs::read(&path).expect("Failed to read file");

    println!("Parsing ABR...");
    let abr = AbrParser::parse(&data).expect("Failed to parse ABR");

    println!("=== Patterns Analysis ===");
    println!("Found {} patterns", abr.patterns.len());
    for (i, p) in abr.patterns.iter().enumerate() {
        println!(
            "Pattern #{}: Name='{}', ID='{}', Mode={}, Size={}x{}, DataLen={}",
            i,
            p.name,
            p.id,
            p.mode,
            p.width,
            p.height,
            p.data.len()
        );

        let head_len = std::cmp::min(p.data.len(), 32);
        println!("  -> Head Hex: {:02X?}", &p.data[0..head_len]);

        let channels = match p.mode {
            1 => 1, // Grayscale
            3 => 3, // RGB
            _ => 0, // Other
        };

        println!("  -> Channels supported by App: {}", channels);
        if channels == 0 {
            println!("  [WARNING] unsupported mode {}", p.mode);
        } else {
            let pixel_count = (p.width * p.height) as usize;
            let expected = pixel_count * channels;
            println!("  -> Expected Uncompressed: {}", expected);

            // Try decoding using logic from commands.rs
            use byteorder::{BigEndian, ReadBytesExt};
            use std::io::Cursor;
            use sutu_lib::file::psd::compression::packbits_decode;

            let mut decoded_data = None;
            let offsets = vec![2, 0];

            // Strategy 1: Blind PackBits
            for &offset in &offsets {
                if offset < p.data.len() {
                    match packbits_decode(&p.data[offset..], expected) {
                        Ok(res) => {
                            println!(
                                "  [SUCCESS] Decoded with Blind Offset {}! Size={}",
                                offset,
                                res.len()
                            );
                            decoded_data = Some(res);
                            break;
                        }
                        Err(e) => {
                            println!("  [DEBUG] Offset {} failed: {}", offset, e);
                        }
                    }
                }
            }

            // Strategy 2: Row Table
            if decoded_data.is_none() && channels > 0 {
                let rows_total = p.height as usize * channels;
                for &offset in &offsets {
                    if offset + (rows_total * 2) > p.data.len() {
                        continue;
                    }

                    let mut cursor = Cursor::new(&p.data[offset..]);
                    let mut row_counts = Vec::with_capacity(rows_total);
                    let mut valid_table = true;

                    for _ in 0..rows_total {
                        match cursor.read_u16::<BigEndian>() {
                            Ok(c) => row_counts.push(c as usize),
                            Err(_) => {
                                valid_table = false;
                                break;
                            }
                        }
                    }

                    if valid_table {
                        let total_rle: usize = row_counts.iter().sum();
                        let header_size = rows_total * 2;
                        let available = p.data.len() - offset - header_size;

                        if total_rle <= available + 256 {
                            let mut stream_pos = offset + header_size;
                            let mut full_output = Vec::with_capacity(expected);
                            let mut fail = false;

                            for count in row_counts {
                                if stream_pos + count > p.data.len() {
                                    fail = true;
                                    break;
                                }
                                // Try decoding scanline
                                // Using 0 as expected len because we rely on stream matching
                                match packbits_decode(&p.data[stream_pos..stream_pos + count], 0) {
                                    Ok(row_data) => {
                                        full_output.extend(row_data);
                                        stream_pos += count;
                                    }
                                    Err(_) => {
                                        // Retry with width?
                                        if let Ok(row_data) = packbits_decode(
                                            &p.data[stream_pos..stream_pos + count],
                                            p.width as usize,
                                        ) {
                                            full_output.extend(row_data);
                                            stream_pos += count;
                                        } else {
                                            fail = true;
                                            break;
                                        }
                                    }
                                }
                            }

                            if !fail && full_output.len() == expected {
                                println!("  [SUCCESS] Decoded with RowTable Offset {}!", offset);
                                decoded_data = Some(full_output);
                                break;
                            }
                        }
                    }
                }
            }

            if decoded_data.is_none() {
                println!("  [FAIL] Could not decode pattern.");
            }
        }
    }

    println!("\n=== Brush Texture Links ===");
    for (i, b) in abr.brushes.iter().enumerate() {
        if let Some(ref tex) = b.texture_settings {
            if tex.depth > 0.0 || tex.scale > 0.0 {
                println!(
                    "Brush #{}: Tex Enabled. Link: ID={:?} Name={:?}",
                    i, tex.pattern_id, tex.pattern_name
                );

                if let Some(ref pid) = tex.pattern_id {
                    let found = abr.patterns.iter().any(|p| p.id == *pid);
                    if !found {
                        println!("  [ERROR] UUID in brush not found in loaded patterns!");
                    } else {
                        println!("  [OK] UUID found.");
                    }
                }
            }
        }
    }
}
