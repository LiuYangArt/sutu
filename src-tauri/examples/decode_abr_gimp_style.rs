/// Debug script for ABR pattern decoding
/// Based on GIMP's gimppattern-load.c implementation
use image::{GrayAlphaImage, LumaA, Rgba, RgbaImage};
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

/// Decode a VMA channel from pattern data
/// Returns (decoded_channel_data, bytes_consumed)
fn decode_vma_channel(data: &[u8], expected_size: usize) -> Option<(Vec<u8>, usize)> {
    if data.len() < 31 {
        println!("    [VMA] Data too short: {} < 31", data.len());
        return None;
    }

    // Read VMA channel header
    let chan_version = i32::from_be_bytes([data[0], data[1], data[2], data[3]]);
    let chan_size = i32::from_be_bytes([data[4], data[5], data[6], data[7]]) as usize;
    let _chan_dummy = i32::from_be_bytes([data[8], data[9], data[10], data[11]]);
    let chan_top = i32::from_be_bytes([data[12], data[13], data[14], data[15]]);
    let chan_left = i32::from_be_bytes([data[16], data[17], data[18], data[19]]);
    let chan_bottom = i32::from_be_bytes([data[20], data[21], data[22], data[23]]);
    let chan_right = i32::from_be_bytes([data[24], data[25], data[26], data[27]]);
    let chan_depth = i16::from_be_bytes([data[28], data[29]]);
    let chan_compression = data[30];

    let width = (chan_right - chan_left) as usize;
    let height = (chan_bottom - chan_top) as usize;

    println!(
        "    [VMA] ver={}, size={}, rect=({},{},{},{}), dim={}x{}, depth={}, comp={}",
        chan_version,
        chan_size,
        chan_top,
        chan_left,
        chan_bottom,
        chan_right,
        width,
        height,
        chan_depth,
        chan_compression
    );

    if chan_depth != 8 {
        println!("    [VMA] Unsupported depth: {}", chan_depth);
        return None;
    }

    if width * height != expected_size {
        println!(
            "    [VMA] Size mismatch: {}x{} = {} vs expected {}",
            width,
            height,
            width * height,
            expected_size
        );
        return None;
    }

    let channel_data = if chan_compression == 0 {
        // Uncompressed - just read raw bytes
        if data.len() < 31 + expected_size {
            println!(
                "    [VMA] Not enough data for raw: {} < {}",
                data.len(),
                31 + expected_size
            );
            return None;
        }
        data[31..31 + expected_size].to_vec()
    } else if chan_compression == 1 {
        // RLE compressed - use GIMP-style row table decode
        gimp_rle_decode(&data[31..], width, height)?
    } else {
        println!("    [VMA] Unknown compression: {}", chan_compression);
        return None;
    };

    // Return channel data and total bytes consumed (header offset + chan_size)
    // NOTE: chan_size includes everything after the first 8 bytes (version + size)
    let total_consumed = 8 + chan_size;
    Some((channel_data, total_consumed))
}

/// GIMP-style RLE decode with row table
fn gimp_rle_decode(data: &[u8], width: usize, height: usize) -> Option<Vec<u8>> {
    if data.len() < height * 2 {
        return None;
    }

    // Read row lengths table
    let mut row_lengths = Vec::with_capacity(height);
    for i in 0..height {
        let len = i16::from_be_bytes([data[i * 2], data[i * 2 + 1]]) as usize;
        row_lengths.push(len);
    }

    // Validate row lengths
    let total_compressed: usize = row_lengths.iter().sum();
    let data_start = height * 2;

    if data.len() < data_start + total_compressed {
        return None;
    }

    // Decode each row using PackBits
    let mut output = Vec::with_capacity(width * height);
    let mut offset = data_start;

    for &comp_len in &row_lengths {
        let row_data = &data[offset..offset + comp_len];
        let decoded_row = packbits_decode_row(row_data, width)?;
        output.extend(decoded_row);
        offset += comp_len;
    }

    if output.len() == width * height {
        Some(output)
    } else {
        None
    }
}

/// PackBits decode for a single row
fn packbits_decode_row(input: &[u8], expected_len: usize) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(expected_len);
    let mut i = 0;

    while i < input.len() && output.len() < expected_len {
        let b = input[i] as i8;
        i += 1;

        if b == -128 {
            // No-op
        } else if b >= 0 {
            // Literal run: copy (b+1) bytes
            let count = (b as usize) + 1;
            let remaining = expected_len - output.len();
            let to_copy = count.min(remaining).min(input.len() - i);
            output.extend_from_slice(&input[i..i + to_copy]);
            i += count;
        } else {
            // Repeat run: repeat next byte (-b+1) times
            let count = ((-b) as usize) + 1;
            if i >= input.len() {
                break;
            }
            let val = input[i];
            i += 1;
            let remaining = expected_len - output.len();
            for _ in 0..count.min(remaining) {
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

    println!("GIMP-STYLE ABR PATTERN DECODER");
    println!("==============================");
    println!("ABR File: {}", abr_path.display());
    println!("Patterns found: {}\n", abr.patterns.len());

    let output_dir = Path::new("f:/CodeProjects/PaintBoard/debug_output/gimp_decode");
    if !output_dir.exists() {
        std::fs::create_dir_all(output_dir)?;
    }

    for (idx, pattern) in abr.patterns.iter().enumerate() {
        let safe_name = sanitize_filename(&pattern.name);

        println!("Pattern #{}: {} ({})", idx, pattern.name, pattern.id);
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

        // Hex dump first 128 bytes to analyze structure
        if idx == 0 {
            println!("  First 128 bytes hex dump:");
            for row in 0..8 {
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

            // Print potential header values at different offsets
            println!("\n  Searching for VMA-like headers...");
            for start_offset in [0, 2, 4, 8, 22, 24, 26, 30, 31] {
                if start_offset + 31 > pattern.data.len() {
                    continue;
                }
                let d = &pattern.data[start_offset..];
                let ver = i32::from_be_bytes([d[0], d[1], d[2], d[3]]);
                let size = i32::from_be_bytes([d[4], d[5], d[6], d[7]]);
                let top = i32::from_be_bytes([d[12], d[13], d[14], d[15]]);
                let left = i32::from_be_bytes([d[16], d[17], d[18], d[19]]);
                let bottom = i32::from_be_bytes([d[20], d[21], d[22], d[23]]);
                let right = i32::from_be_bytes([d[24], d[25], d[26], d[27]]);
                let depth = i16::from_be_bytes([d[28], d[29]]);
                let comp = d[30];
                println!(
                    "    @{}: ver={}, size={}, rect=({},{},{},{}), depth={}, comp={}",
                    start_offset, ver, size, top, left, bottom, right, depth, comp
                );
                // Search for 2-byte value 80 (0x0050 BE)
                println!("\n  Searching for value 80 (0x0050 BE) in first 50 bytes:");
                for i in 0..50.min(pattern.data.len() - 1) {
                    let val = u16::from_be_bytes([pattern.data[i], pattern.data[i + 1]]);
                    if val == 80 {
                        println!("    Found 80 at offset {}", i);
                    }
                }

                // Try parsing with 2-byte fields at offset 12
                println!("\n  Trying 2-byte fields:");
                if pattern.data.len() >= 30 {
                    let d = &pattern.data;
                    // Try offset 12 for 2-byte values
                    let h_at_12 = u16::from_be_bytes([d[12], d[13]]);
                    let w_at_14 = u16::from_be_bytes([d[14], d[15]]);
                    let h_at_16 = u16::from_be_bytes([d[16], d[17]]);
                    let w_at_18 = u16::from_be_bytes([d[18], d[19]]);
                    println!("    @12-13: {} (expect height 80)", h_at_12);
                    println!("    @14-15: {} (expect width 80)", w_at_14);
                    println!("    @16-17: {}", h_at_16);
                    println!("    @18-19: {}", w_at_18);

                    // Maybe the VMA header is different - try GIMP's exact format
                    // GIMP: version(4), size(4), dummy(4), top(4), left(4), bottom(4), right(4), depth(2), comp(1)
                    // = 31 bytes header
                    // But our data doesn't seem to have this at offset 0

                    // Let's try: header starts at offset 2 or 4
                    for header_offset in [0, 2, 4, 8, 22] {
                        if header_offset + 31 > pattern.data.len() {
                            continue;
                        }
                        let d = &pattern.data[header_offset..];
                        // Try 2-byte fields for rect
                        let top = u16::from_be_bytes([d[8], d[9]]) as i32;
                        let left = u16::from_be_bytes([d[10], d[11]]) as i32;
                        let bottom = u16::from_be_bytes([d[12], d[13]]) as i32;
                        let right = u16::from_be_bytes([d[14], d[15]]) as i32;
                        let depth = u16::from_be_bytes([d[16], d[17]]);
                        let comp = d[18];
                        let w = right - left;
                        let h = bottom - top;
                        println!("    @{} (2-byte rect): rect=({},{},{},{}), dim={}x{}, depth={}, comp={}",
                        header_offset, top, left, bottom, right, w, h, depth, comp);
                    }
                }
            }
        }

        let width = pattern.width as usize;
        let height = pattern.height as usize;
        let pixel_count = width * height;

        // Pattern data structure (discovered from hex dump):
        // Bytes 0-3: version/magic (0x03 00 00 4B for Bubbles)
        // Bytes 4-7: size
        // Bytes 8-11: dummy
        // Bytes 12-15: top (0)
        // Bytes 16-19: left (0)
        // Bytes 20-23: bottom (height)
        // Bytes 24-27: right (width)
        // Byte 28: depth (24 for RGB, 8 for grayscale)
        // Byte 29: compression (1=RLE)
        // Bytes 30+: row table (n_rows * 2 bytes) then RLE data

        // For RGB: n_rows = height * 3, data is planar (all R, all G, all B)
        // For Grayscale: n_rows = height

        if pattern.data.len() < 31 {
            println!("  [SKIP] Data too short");
            continue;
        }

        // Parse header
        let header_top = i32::from_be_bytes([
            pattern.data[12],
            pattern.data[13],
            pattern.data[14],
            pattern.data[15],
        ]);
        let header_left = i32::from_be_bytes([
            pattern.data[16],
            pattern.data[17],
            pattern.data[18],
            pattern.data[19],
        ]);
        let header_bottom = i32::from_be_bytes([
            pattern.data[20],
            pattern.data[21],
            pattern.data[22],
            pattern.data[23],
        ]);
        let header_right = i32::from_be_bytes([
            pattern.data[24],
            pattern.data[25],
            pattern.data[26],
            pattern.data[27],
        ]);
        let header_depth = u8::from_be_bytes([pattern.data[28]]);
        let header_compression = pattern.data[29];

        let img_width = (header_right - header_left) as usize;
        let img_height = (header_bottom - header_top) as usize;

        println!(
            "  Header: rect=({},{},{},{}), dim={}x{}, depth={}, comp={}",
            header_top,
            header_left,
            header_bottom,
            header_right,
            img_width,
            img_height,
            header_depth,
            header_compression
        );

        // Determine number of rows based on mode
        let n_channels = if pattern.mode == 3 { 3 } else { 1 };
        let n_rows = img_height * n_channels;

        // Row table starts at byte 30
        let row_table_start = 30;
        let row_table_size = n_rows * 2;
        let data_start = row_table_start + row_table_size;

        if pattern.data.len() < data_start {
            println!(
                "  [FAIL] Not enough data for row table: {} < {}",
                pattern.data.len(),
                data_start
            );
            continue;
        }

        // Read row lengths
        let mut row_lengths = Vec::with_capacity(n_rows);
        for i in 0..n_rows {
            let offset = row_table_start + i * 2;
            let len = i16::from_be_bytes([pattern.data[offset], pattern.data[offset + 1]]) as usize;
            row_lengths.push(len);
        }

        println!(
            "  Row table: {} rows, first few lengths: {:?}",
            n_rows,
            &row_lengths[..5.min(row_lengths.len())]
        );

        // Decode all rows using PackBits
        let mut all_decoded = Vec::with_capacity(img_width * n_rows);
        let mut offset = data_start;

        for (row_idx, &comp_len) in row_lengths.iter().enumerate() {
            if offset + comp_len > pattern.data.len() {
                println!(
                    "  [FAIL] Row {} overflow: offset {} + len {} > data len {}",
                    row_idx,
                    offset,
                    comp_len,
                    pattern.data.len()
                );
                break;
            }

            let row_data = &pattern.data[offset..offset + comp_len];
            match packbits_decode_row(row_data, img_width) {
                Some(decoded_row) => {
                    all_decoded.extend(decoded_row);
                }
                None => {
                    println!("  [FAIL] PackBits decode failed for row {}", row_idx);
                    break;
                }
            }
            offset += comp_len;
        }

        let expected_decoded = img_width * n_rows;
        println!(
            "  Decoded {} bytes, expected {}",
            all_decoded.len(),
            expected_decoded
        );

        if all_decoded.len() != expected_decoded {
            println!("  [FAIL] Incomplete decode");
            continue;
        }

        // Create image based on mode
        match pattern.mode {
            3 => {
                // RGB planar -> interleaved
                let mut img = RgbaImage::new(img_width as u32, img_height as u32);
                let plane_size = img_width * img_height;

                for y in 0..img_height {
                    for x in 0..img_width {
                        let i = y * img_width + x;
                        let r = all_decoded[i]; // R plane
                        let g = all_decoded[plane_size + i]; // G plane
                        let b = all_decoded[2 * plane_size + i]; // B plane
                        img.put_pixel(x as u32, y as u32, Rgba([r, g, b, 255]));
                    }
                }

                let filename = output_dir.join(format!("p{}_{}.png", idx, safe_name));
                img.save(&filename)?;
                println!("  ✓ SAVED: {}", filename.display());
            }
            1 => {
                // Grayscale
                let mut img = GrayAlphaImage::new(img_width as u32, img_height as u32);

                for y in 0..img_height {
                    for x in 0..img_width {
                        let i = y * img_width + x;
                        let g = all_decoded[i];
                        img.put_pixel(x as u32, y as u32, LumaA([g, 255]));
                    }
                }

                let filename = output_dir.join(format!("p{}_{}.png", idx, safe_name));
                img.save(&filename)?;
                println!("  ✓ SAVED: {}", filename.display());
            }
            _ => {
                println!("  [SKIP] Unsupported mode: {}", pattern.mode);
            }
        }

        println!();
    }

    println!("Done!");
    Ok(())
}
