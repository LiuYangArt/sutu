use image::{GrayImage, Luma, Rgb, RgbImage};
use paintboard_lib::abr::AbrParser;
use std::fs::File;
use std::io::{Cursor, Read, Write};
use std::path::Path;

// Include the packbits_decode function here to avoid visibility issues if it's private
fn packbits_decode(input: &[u8], expected_len: usize) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(expected_len);
    let mut i = 0;
    while i < input.len() {
        if output.len() >= expected_len {
            break;
        }
        let b = input[i] as i8;
        i += 1;
        if b == -128 {
            // No-op
        } else if b >= 0 {
            // Literal run
            let count = (b as usize) + 1;
            if i + count > input.len() {
                // Determine if we can just copy what's left
                let remaining = input.len() - i;
                output.extend_from_slice(&input[i..i + remaining]);
                break;
            }
            output.extend_from_slice(&input[i..i + count]);
            i += count;
        } else {
            // Replicate run
            let count = ((-b) as usize) + 1;
            if i >= input.len() {
                break;
            }
            let val = input[i];
            i += 1;
            for _ in 0..count {
                output.push(val);
            }
        }
    }

    if output.len() < expected_len {
        return None;
    }
    Some(output)
}

fn save_rgb_planar(filename: &str, decoded: &[u8], width: u32, height: u32) {
    let area = (width * height) as usize;
    if decoded.len() < area * 3 {
        println!(
            "  [WARN] Data length {} too small for Planar RGB (need {})",
            decoded.len(),
            area * 3
        );
        return;
    }

    let (r_plane, rest) = decoded.split_at(area);
    let (g_plane, b_rest) = rest.split_at(area);
    let b_plane = &b_rest[..area];

    let mut img = RgbImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) as usize;
            img.put_pixel(x, y, Rgb([r_plane[i], g_plane[i], b_plane[i]]));
        }
    }
    img.save(filename).expect("Failed to save image");
    println!("  Saved {}", filename);
}

fn save_rgb_interleaved(filename: &str, decoded: &[u8], width: u32, height: u32) {
    let area = (width * height) as usize;
    if decoded.len() < area * 3 {
        println!(
            "  [WARN] Data length {} too small for Interleaved RGB (need {})",
            decoded.len(),
            area * 3
        );
        return;
    }

    let mut img = RgbImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) as usize;
            let offset = i * 3;
            if offset + 2 < decoded.len() {
                img.put_pixel(
                    x,
                    y,
                    Rgb([decoded[offset], decoded[offset + 1], decoded[offset + 2]]),
                );
            }
        }
    }
    img.save(filename).expect("Failed to save image");
    println!("  Saved {}", filename);
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path_str = r"f:\CodeProjects\PaintBoard\abr\liuyang_paintbrushes.abr";
    println!("DEBUGGING ABR: {}", path_str);

    let mut file = File::open(path_str)?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)?;

    println!("File size: {} bytes", buffer.len());

    let abr = AbrParser::parse(&buffer).expect("Failed to parse ABR");

    println!("Patterns found: {}", abr.patterns.len());

    let output_dir = Path::new(r"f:\CodeProjects\PaintBoard\debug_output");
    if !output_dir.exists() {
        std::fs::create_dir_all(output_dir)?;
    }

    for (idx, pattern) in abr.patterns.iter().enumerate() {
        println!("\nPattern #{}: {} (ID: {})", idx, pattern.name, pattern.id);
        println!("  Size: {}x{}", pattern.width, pattern.height);
        println!("  Mode: {:?}", pattern.mode); // 3=RGB, 1=Gray
        println!("  Raw Data Length: {}", pattern.data.len());

        let expected_pixels = (pattern.width * pattern.height) as usize;
        let expected_bytes = if pattern.mode == 3 {
            expected_pixels * 3
        } else {
            expected_pixels
        };

        println!("  Expected Bytes: {}", expected_bytes);

        // 1. Try Raw (assuming it might be uncompressed)
        let raw_filename = output_dir.join(format!("p{}_raw_planar.png", idx));
        if pattern.mode == 3 {
            save_rgb_planar(
                raw_filename.to_str().unwrap(),
                &pattern.data,
                pattern.width,
                pattern.height,
            );
            save_rgb_interleaved(
                output_dir
                    .join(format!("p{}_raw_interleaved.png", idx))
                    .to_str()
                    .unwrap(),
                &pattern.data,
                pattern.width,
                pattern.height,
            );
        }

        // 2. Try PackBits (Continuous)
        // Offset 0
        if let Some(decoded) = packbits_decode(&pattern.data, expected_bytes) {
            println!("  [Decoded Continuous Offset 0] len: {}", decoded.len());
            if pattern.mode == 3 {
                save_rgb_planar(
                    output_dir
                        .join(format!("p{}_cont0_planar.png", idx))
                        .to_str()
                        .unwrap(),
                    &decoded,
                    pattern.width,
                    pattern.height,
                );
                save_rgb_interleaved(
                    output_dir
                        .join(format!("p{}_cont0_interleaved.png", idx))
                        .to_str()
                        .unwrap(),
                    &decoded,
                    pattern.width,
                    pattern.height,
                );
            }
        } else {
            println!("  [Decoded Continuous Offset 0] Failed");
        }

        // Offset 2 (header skip?)
        if pattern.data.len() > 2 {
            if let Some(decoded) = packbits_decode(&pattern.data[2..], expected_bytes) {
                println!("  [Decoded Continuous Offset 2] len: {}", decoded.len());
                if pattern.mode == 3 {
                    save_rgb_planar(
                        output_dir
                            .join(format!("p{}_cont2_planar.png", idx))
                            .to_str()
                            .unwrap(),
                        &decoded,
                        pattern.width,
                        pattern.height,
                    );
                    save_rgb_interleaved(
                        output_dir
                            .join(format!("p{}_cont2_interleaved.png", idx))
                            .to_str()
                            .unwrap(),
                        &decoded,
                        pattern.width,
                        pattern.height,
                    );
                }
            } else {
                println!("  [Decoded Continuous Offset 2] Failed");
            }
        }

        // 3. Try Scanline Row Table
        // Assuming data starts with row table (Height * 2 or Height * 4 bytes?)
        // Usually scanline tables in simple packbits are often 2 bytes per scanline (size of compressed line)
        // Check if first few bytes look like scanline sizes

        // 4. Try Sequential Planar Decoding (Split Channels)
        // Check if we can decode exactly W*H bytes 3 times
        println!("  [Sequential Planar Decoding] Attempting...");
        let channel_size = expected_pixels;
        let mut offset = 0;
        let mut r_plane = Vec::new();
        let mut g_plane = Vec::new();
        let mut b_plane = Vec::new();

        let mut split_success = false;

        // Try decode R
        if let Some((r_data, consumed_r)) =
            packbits_decode_limit(&pattern.data[offset..], channel_size)
        {
            if r_data.len() == channel_size {
                r_plane = r_data;
                offset += consumed_r;
                // Try decode G
                if offset < pattern.data.len() {
                    if let Some((g_data, consumed_g)) =
                        packbits_decode_limit(&pattern.data[offset..], channel_size)
                    {
                        if g_data.len() == channel_size {
                            g_plane = g_data;
                            offset += consumed_g;
                            // Try decode B
                            if offset < pattern.data.len() {
                                if let Some((b_data, consumed_b)) =
                                    packbits_decode_limit(&pattern.data[offset..], channel_size)
                                {
                                    if b_data.len() == channel_size {
                                        b_plane = b_data;
                                        offset += consumed_b;
                                        println!(
                                            "    Success! Consumed {}/{} bytes",
                                            offset,
                                            pattern.data.len()
                                        );
                                        split_success = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if split_success {
            // Combine Planes
            let mut img = RgbImage::new(pattern.width, pattern.height);
            for y in 0..pattern.height {
                for x in 0..pattern.width {
                    let i = (y * pattern.width + x) as usize;
                    img.put_pixel(x, y, Rgb([r_plane[i], g_plane[i], b_plane[i]]));
                }
            }
            let filename = output_dir.join(format!("p{}_sequential_planar.png", idx));
            img.save(&filename).expect("Failed to save image");
            println!("  Saved {}", filename.to_str().unwrap());
        } else {
            println!("    Failed sequential decoding");
        }

        // For Grayscale patterns, test with VMA (Virtual Memory Array) header parsing
        if pattern.mode == 1 {
            println!("  [Grayscale Mode] Testing...");

            // Print first 32 bytes to understand the structure
            let bytes_to_show = 32.min(pattern.data.len());
            print!("    First {} bytes: ", bytes_to_show);
            for i in 0..bytes_to_show {
                print!("{:02X} ", pattern.data[i]);
            }
            println!();

            // According to GIMP source (gimppattern-load.c):
            //
            // Data structure (after pattern metadata already parsed in patt.rs):
            //
            // IMAGE BLOCK HEADER (28 bytes):
            // - 4 bytes: block version
            // - 4 bytes: block size
            // - 4 bytes: top
            // - 4 bytes: left
            // - 4 bytes: bottom (= height)
            // - 4 bytes: right (= width)
            // - 4 bytes: depth
            //
            // Then per channel, VMA HEADER (31 bytes):
            // - 4 bytes: chan_version
            // - 4 bytes: chan_size
            // - 4 bytes: dummy
            // - 4 bytes: chan_top
            // - 4 bytes: chan_left
            // - 4 bytes: chan_bottom
            // - 4 bytes: chan_right
            // - 2 bytes: chan_depth
            // - 1 byte: compression
            // Then row table (height * 2 bytes), then RLE data

            let image_block_header_size = 28;
            let vma_header_size = 31;
            if pattern.data.len() > image_block_header_size + vma_header_size {
                // Search for height and width values in the data
                let h = pattern.height;
                let w = pattern.width;
                let h_bytes_be = (h as u16).to_be_bytes();
                let w_bytes_be = (w as u16).to_be_bytes();

                println!(
                    "    [Searching for dimensions: {}x{} = 0x{:04X} x 0x{:04X}]",
                    h, w, h, w
                );

                for i in 0..64.min(pattern.data.len().saturating_sub(4)) {
                    // Check for u16 BE height
                    if pattern.data[i] == h_bytes_be[0] && pattern.data[i + 1] == h_bytes_be[1] {
                        // Found height, check if width follows nearby
                        for j in (i + 2)..=(i + 10).min(pattern.data.len().saturating_sub(2)) {
                            if pattern.data[j] == w_bytes_be[0]
                                && pattern.data[j + 1] == w_bytes_be[1]
                            {
                                println!("      Found h@{} w@{} (gap={})", i, j, j - i - 2);
                                // Check compression byte after width
                                if j + 3 < pattern.data.len() {
                                    let after = [pattern.data[j + 2], pattern.data[j + 3]];
                                    println!(
                                        "        Bytes after width: {:02X} {:02X}",
                                        after[0], after[1]
                                    );
                                }
                            }
                        }
                    }
                }

                // Try multiple offsets to find where the actual VMA header starts
                println!("    [Scanning for VMA header...]");

                for test_offset in [0_usize, 2, 4, 8, 28, 59] {
                    if pattern.data.len() <= test_offset + 31 {
                        continue;
                    }

                    // VMA structure: version(4) + size(4) + dummy(4) + rect(16) + depth(2) + compression(1)
                    // rect = top + left + bottom + right (each 4 bytes at offsets 12, 16, 20, 24)
                    let pos = test_offset;
                    let bottom = u32::from_be_bytes([
                        pattern.data[pos + 20],
                        pattern.data[pos + 21],
                        pattern.data[pos + 22],
                        pattern.data[pos + 23],
                    ]) as usize;
                    let right = u32::from_be_bytes([
                        pattern.data[pos + 24],
                        pattern.data[pos + 25],
                        pattern.data[pos + 26],
                        pattern.data[pos + 27],
                    ]) as usize;
                    let depth =
                        u16::from_be_bytes([pattern.data[pos + 28], pattern.data[pos + 29]]);
                    let compression = pattern.data[pos + 30];

                    let is_match =
                        bottom == pattern.height as usize && right == pattern.width as usize;

                    println!(
                        "      offset {:2} -> bottom={:4}, right={:4}, depth={:2}, comp={} {}",
                        test_offset,
                        bottom,
                        right,
                        depth,
                        compression,
                        if is_match { "✓ MATCH!" } else { "" }
                    );
                }

                // DISCOVERED STRUCTURE from dimension search:
                // height at byte 17-18 (u16 BE)
                // width at byte 21-22 (u16 BE)
                // depth at byte 25-26 (likely 0x0018 = 24)
                // compression at byte 30 (0x01 = RLE)
                // row table starts at byte 31
                println!("    [Trying discovered structure: h@17, w@21, comp@30]");

                if pattern.data.len() > 31 + pattern.height as usize * 2 {
                    let h = u16::from_be_bytes([pattern.data[17], pattern.data[18]]) as usize;
                    let w = u16::from_be_bytes([pattern.data[21], pattern.data[22]]) as usize;
                    let depth = u16::from_be_bytes([pattern.data[25], pattern.data[26]]);
                    let compression = pattern.data[30];

                    println!(
                        "      h={}, w={}, depth={}, comp={}",
                        h, w, depth, compression
                    );

                    if h == pattern.height as usize
                        && w == pattern.width as usize
                        && compression == 1
                    {
                        println!("      ✓ Dimensions match!");
                        // Print bytes 31-64 to inspect what follows
                        if pattern.data.len() > 64 {
                            println!("      Bytes 31-64: {:02X?}", &pattern.data[31..64]);
                        }

                        // Try multiple row table start positions
                        for row_table_start in [31_usize, 32, 62, 63] {
                            let row_count = h;
                            let table_size = row_count * 2;

                            if pattern.data.len() > row_table_start + table_size {
                                let mut row_lengths: Vec<usize> = Vec::with_capacity(row_count);
                                let mut valid = true;

                                for i in 0..row_count {
                                    let offset = row_table_start + i * 2;
                                    let len = i16::from_be_bytes([
                                        pattern.data[offset],
                                        pattern.data[offset + 1],
                                    ]);
                                    if len <= 0 || len > 10000 {
                                        valid = false;
                                        break;
                                    }
                                    row_lengths.push(len as usize);
                                }

                                if valid {
                                    println!(
                                        "        rt@{} valid! First 3: {:?}",
                                        row_table_start,
                                        &row_lengths[..3.min(row_lengths.len())]
                                    );
                                    let total_compressed: usize = row_lengths.iter().sum();
                                    let data_start = row_table_start + table_size;

                                    // Row-by-row RLE decode
                                    let mut decoded: Vec<u8> = Vec::with_capacity(h * w);
                                    let mut stream_pos = data_start;
                                    let mut success = true;

                                    for (row_idx, &comp_len) in row_lengths.iter().enumerate() {
                                        if stream_pos + comp_len > pattern.data.len() {
                                            success = false;
                                            break;
                                        }
                                        let row_data =
                                            &pattern.data[stream_pos..stream_pos + comp_len];
                                        if let Some(row_decoded) = packbits_decode(row_data, w) {
                                            decoded.extend_from_slice(&row_decoded);
                                        } else {
                                            success = false;
                                            break;
                                        }
                                        stream_pos += comp_len;
                                    }

                                    if success && decoded.len() == h * w {
                                        println!(
                                            "      ✓✓ DECODE SUCCESS at rt@{}",
                                            row_table_start
                                        );
                                        let mut img = GrayImage::new(w as u32, h as u32);
                                        for y in 0..h {
                                            for x in 0..w {
                                                let i = y * w + x;
                                                img.put_pixel(
                                                    x as u32,
                                                    y as u32,
                                                    Luma([decoded[i]]),
                                                );
                                            }
                                        }
                                        let filename = output_dir
                                            .join(format!("p{}_rt{}.png", idx, row_table_start));
                                        img.save(&filename).ok();
                                        println!("      Saved {}", filename.display());
                                        break; // Found successful decode, stop trying
                                    }
                                }
                            }
                        }
                    }
                }

                // Try alternative structure: 2-byte rect fields instead of 4-byte
                // Structure might be: version(4) + size(4) + top(2) + left(2) + bottom(2) + right(2) + depth(2) + compression(1)
                // That's 4+4+2+2+2+2+2+1 = 19 bytes header
                println!("    [Scanning with 2-byte rect fields...]");

                for test_offset in [0_usize, 2, 4, 8] {
                    if pattern.data.len() <= test_offset + 19 {
                        continue;
                    }

                    let pos = test_offset;
                    // After version(4) + size(4) = offset 8
                    let top =
                        u16::from_be_bytes([pattern.data[pos + 8], pattern.data[pos + 9]]) as usize;
                    let left = u16::from_be_bytes([pattern.data[pos + 10], pattern.data[pos + 11]])
                        as usize;
                    let bottom =
                        u16::from_be_bytes([pattern.data[pos + 12], pattern.data[pos + 13]])
                            as usize;
                    let right = u16::from_be_bytes([pattern.data[pos + 14], pattern.data[pos + 15]])
                        as usize;
                    let depth =
                        u16::from_be_bytes([pattern.data[pos + 16], pattern.data[pos + 17]]);
                    let compression = pattern.data[pos + 18];

                    let is_match =
                        bottom == pattern.height as usize && right == pattern.width as usize;

                    println!(
                        "      offset {:2} -> rect=({},{},{},{}), depth={:2}, comp={} {}",
                        test_offset,
                        top,
                        left,
                        bottom,
                        right,
                        depth,
                        compression,
                        if is_match { "✓ MATCH!" } else { "" }
                    );

                    // If dimensions match and compression is RLE, try to decode
                    if is_match && compression == 1 && (depth == 8 || depth == 24) {
                        let row_table_start = pos + 19; // 19-byte header
                        let row_count = bottom;
                        let _width = right;
                        let table_size = row_count * 2;

                        if pattern.data.len() > row_table_start + table_size {
                            let mut row_lengths: Vec<usize> = Vec::with_capacity(row_count);
                            let mut valid = true;

                            for i in 0..row_count {
                                let offset = row_table_start + i * 2;
                                let len = i16::from_be_bytes([
                                    pattern.data[offset],
                                    pattern.data[offset + 1],
                                ]);
                                if len <= 0 || len > 10000 {
                                    valid = false;
                                    break;
                                }
                                row_lengths.push(len as usize);
                            }

                            if valid && row_lengths.len() == row_count {
                                let total_compressed: usize = row_lengths.iter().sum();
                                let data_start = row_table_start + table_size;

                                println!(
                                    "        Row table valid! First 3: {:?}, total: {}",
                                    &row_lengths[..3.min(row_lengths.len())],
                                    total_compressed
                                );

                                // Try row-by-row RLE decode
                                let mut decoded: Vec<u8> = Vec::with_capacity(right * bottom);
                                let mut stream_pos = data_start;
                                let mut success = true;

                                for (row_idx, &comp_len) in row_lengths.iter().enumerate() {
                                    if stream_pos + comp_len > pattern.data.len() {
                                        success = false;
                                        println!("        Row {} overflow", row_idx);
                                        break;
                                    }
                                    let row_data = &pattern.data[stream_pos..stream_pos + comp_len];
                                    if let Some(row_decoded) = packbits_decode(row_data, right) {
                                        decoded.extend_from_slice(&row_decoded);
                                    } else {
                                        success = false;
                                        println!("        Row {} decode failed", row_idx);
                                        break;
                                    }
                                    stream_pos += comp_len;
                                }

                                if success && decoded.len() == right * bottom {
                                    println!("    ✓ VMA DECODE SUCCESS at offset {}!", test_offset);
                                    let mut img = GrayImage::new(pattern.width, pattern.height);
                                    for y in 0..pattern.height {
                                        for x in 0..pattern.width {
                                            let i = (y * pattern.width + x) as usize;
                                            img.put_pixel(x, y, Luma([decoded[i]]));
                                        }
                                    }
                                    let filename = output_dir
                                        .join(format!("p{}_vma_offset{}.png", idx, test_offset));
                                    img.save(&filename).expect("Failed to save");
                                    println!("  Saved {}", filename.display());
                                } else {
                                    println!(
                                        "        Decode failed: got {} bytes, need {}",
                                        decoded.len(),
                                        right * bottom
                                    );
                                }
                            }
                        }
                    }
                }
            }

            // Raw (no compression) - using data after potential 2-byte header
            let data_offset = 2.min(pattern.data.len());
            if pattern.data.len() - data_offset >= expected_pixels {
                let mut img = GrayImage::new(pattern.width, pattern.height);
                for y in 0..pattern.height {
                    for x in 0..pattern.width {
                        let i = (y * pattern.width + x) as usize;
                        if data_offset + i < pattern.data.len() {
                            img.put_pixel(x, y, Luma([pattern.data[data_offset + i]]));
                        }
                    }
                }
                let filename = output_dir.join(format!("p{}_gray_offset2.png", idx));
                img.save(&filename).expect("Failed to save");
                println!("  Saved {}", filename.display());
            }
        }

        // Limit to first 6 patterns for manageability
        if idx >= 11 {
            break;
        }
    }

    Ok(())
}

// Version of packbits_decode that returns bytes consumed and stops at exact len
fn packbits_decode_limit(input: &[u8], target_len: usize) -> Option<(Vec<u8>, usize)> {
    let mut output = Vec::with_capacity(target_len);
    let mut i = 0;
    while i < input.len() {
        if output.len() >= target_len {
            break;
        }
        let b = input[i] as i8;
        i += 1;
        if b == -128 {
            // No-op
        } else if b >= 0 {
            // Literal run
            let count = (b as usize) + 1;
            if output.len() + count > target_len {
                // Only verify we have enough input, but strict limit output
                if i + count > input.len() {
                    return None;
                }
                output.extend_from_slice(&input[i..i + count]);
                i += count;
                break;
            }

            if i + count > input.len() {
                // Read truncated (or fail?)
                // Standard packbits should not truncate literals in middle of stream
                return None;
            }
            output.extend_from_slice(&input[i..i + count]);
            i += count;
        } else {
            // Replicate run
            let count = ((-b) as usize) + 1;
            if i >= input.len() {
                return None;
            }
            let val = input[i];
            i += 1;

            // Limit output
            let remaining_needed = target_len - output.len();
            let actual_count = std::cmp::min(count, remaining_needed);

            for _ in 0..actual_count {
                output.push(val);
            }

            if output.len() == target_len {
                break;
            }
        }
    }

    if output.len() < target_len {
        return None;
    }
    Some((output, i))
}
