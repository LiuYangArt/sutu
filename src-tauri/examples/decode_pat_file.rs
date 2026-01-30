#![allow(clippy::unwrap_used)]
#![allow(unused_assignments)]
#![allow(unused_variables)]

use byteorder::{BigEndian, ReadBytesExt};
use image::{GrayImage, Luma, Rgba, RgbaImage};
use std::error::Error;
use std::fs::File;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::Path;

fn main() -> Result<(), Box<dyn Error>> {
    let pat_path = Path::new("f:/CodeProjects/PaintBoard/abr/test_patterns.pat");
    let mut file = File::open(pat_path)?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)?;

    println!("Decoding .pat file: {:?}", pat_path);
    println!("Total size: {} bytes", data.len());

    let mut cursor = Cursor::new(&data);

    // Header check
    let mut signature = [0u8; 4];
    cursor.read_exact(&mut signature)?;
    if &signature != b"8BPT" {
        return Err(format!("Invalid signature: {:?}", signature).into());
    }

    let version = cursor.read_u16::<BigEndian>()?;
    if version != 1 {
        return Err(format!("Unsupported version: {}", version).into());
    }

    let count = cursor.read_u32::<BigEndian>()?;
    println!("Header: Sig=8BPT, Ver={}, Count={}", version, count);

    // Start parsing patterns
    // Patterns in .pat seem to be concatenated directly?
    // Based on hex: 38 42 50 54 00 01 00 00 00 0D ...
    // Note: 00 01 is version (2 bytes).
    // 00 00 00 0D is count? (4 bytes).
    // Wait, hex was: 00 01 00 00 00 0D
    // If version is 2 bytes, next 2 bytes 00 00? Then 00 0D?
    // Let's re-examine hex:
    // 00: 38 42 50 54 (Sig)
    // 04: 00 01 (Ver)
    // 06: 00 00 (Padding?)
    // 08: 00 0D (Count? 13)
    // 0A: 00 00 (Padding?)
    // 0C: Start of patterns?

    // Let's adjust cursor to skip what looks like header.
    // I'll try to read patterns starting at offset 12 maybe?
    // Or maybe handle the bytes carefully.

    // Let's try to parse a pattern at current cursor (offset 10)
    // Actually let's just loop and try to find valid pattern starts if standard parsing fails.

    // The previous hex dump showed:
    // ... 00 0D 00 00 00 01 00 00 00 03 ...
    // Offset 8: 00 0D
    // Offset 10: 00 00
    // Offset 12: 00 01 00 00 (Size=65536? or Version?)

    // If I assume standard pattern structure:
    // Length (4), Version (4), Mode (4), W (2), H (2), Name...

    // If offset 12 is start:
    // Length = 00 01 00 00 = 65536.
    // Version = 00 03 06 00 ... (Invalid version 197120?)

    // Maybe Size is NOT included in .pat file patterns?
    // Or headers are different.

    // Let's look at `ciel_07.jpg` at offset ~28.
    // 00 0C 00 63 ... (Length 12, "ciel...")

    // Backtrack from Name:
    // Name starts at 28.
    // Before name: H (2), W (2), Mode (4), Version (4), Length (4). Total 16 bytes.
    // 28 - 16 = 12.
    // So at offset 12, we expect Length (4).
    // Offset 12 bytes: 00 01 00 00.
    // Offset 16 bytes: 00 03 06 00 (Version?) => 198144?
    // Offset 20 bytes: 08 00 00 00 (Mode?)

    // This doesn't match "Version 1" expected by patt.rs.
    // Maybe .pat file patterns have different header?
    // Image Mode 3 is RGB.
    // 00 03 (2 bytes?)
    // 06 00 (2 bytes?)
    // 08 00 ...

    // Let's try to infer structure from the data around "ciel".
    // "ciel" name len is 12 (0xC).
    // Preceded by W, H.
    // If W, H are 2 bytes each.
    // The pattern size is usually large.

    // Let's rely on finding "8BIM" or VMA inside? No, VMA is inside image data.

    let output_dir = Path::new("f:/CodeProjects/PaintBoard/debug_output/pat_file");
    if !output_dir.exists() {
        std::fs::create_dir_all(output_dir)?;
    }

    // Header 10 bytes: Sig(4), Ver(2), Count(4)??
    // 00: 38 42 50 54 (8BPT)
    // 04: 00 01 (Ver 2B)
    // 06: 00 00 00 0D (Count 4B)
    // Total 10 bytes. Next is Pattern at 10.

    cursor.set_position(10);

    let output_dir = Path::new("f:/CodeProjects/PaintBoard/debug_output/pat_decoded");
    if !output_dir.exists() {
        std::fs::create_dir_all(output_dir)?;
    }

    for i in 0..count {
        println!("\n=== Pattern {}/{} ===", i + 1, count);

        // Scan for Pattern Header (Version = 1)
        // Heuristic: Ver=1, Mode < 20, Height > 0, Width > 0.
        let scan_limit = cursor.position() + 100000; // 100KB scan limit
        let mut header_found = false;

        while cursor.position() < scan_limit {
            let attempt_pos = cursor.position();
            if let Ok(ver) = cursor.read_u32::<BigEndian>() {
                if ver == 1 {
                    if let Ok(mode) = cursor.read_u32::<BigEndian>() {
                        if mode < 50 {
                            if let Ok(h) = cursor.read_u16::<BigEndian>() {
                                if h > 0 {
                                    if let Ok(w) = cursor.read_u16::<BigEndian>() {
                                        if w > 0 {
                                            // Likely found
                                            header_found = true;
                                            cursor.seek(SeekFrom::Start(attempt_pos))?;
                                            println!("  Synced Pattern Header at {}", attempt_pos);
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // Rewind to attempt_pos + 1
            cursor.seek(SeekFrom::Start(attempt_pos + 1))?;
        }

        if !header_found {
            println!("  ERROR: Could not find next pattern header.");
            break;
        }

        let start_pos = cursor.position();

        let version = cursor.read_u32::<BigEndian>()?;
        let mode = cursor.read_u32::<BigEndian>()?;
        let height = cursor.read_u16::<BigEndian>()?;
        let width = cursor.read_u16::<BigEndian>()?;
        let name_len = cursor.read_u32::<BigEndian>()?;

        println!(
            "  Debug: Pos={}, Ver={}, Mode={}, H={}, W={}, NameLen={}",
            start_pos, version, mode, height, width, name_len
        );

        let name = if name_len > 0 && name_len < 1000 {
            let mut name_bytes = vec![0u16; name_len as usize];
            for j in 0..name_len {
                name_bytes[j as usize] = cursor.read_u16::<BigEndian>()?;
            }
            if let Some(last) = name_bytes.last() {
                if *last == 0 {
                    name_bytes.pop();
                }
            }
            String::from_utf16(&name_bytes).unwrap_or_else(|_| "invalid_utf16".to_string())
        } else {
            String::new()
        };

        // ID
        // Try u8 length?
        let id_len = cursor.read_u8()?;
        println!("  Debug: IDLen={} (u8)", id_len);

        let mut id_bytes = vec![0u8; id_len as usize];
        cursor.read_exact(&mut id_bytes)?;
        let id = String::from_utf8(id_bytes).unwrap_or_else(|_| "invalid_utf8".to_string());

        let after_header_pos = cursor.position();
        println!(
            "  Info: Name='{}', ID='{}', Pos={}",
            name, id, after_header_pos
        );

        // Check for padding/alignment after ID?
        // Let's dump 4 bytes to check alignment
        let mut align_chk = [0u8; 4];
        if cursor.read(&mut align_chk).is_ok() {
            println!(
                "  Post-ID bytes: {:02X} {:02X} {:02X} {:02X}",
                align_chk[0], align_chk[1], align_chk[2], align_chk[3]
            );
            // Rewind
            cursor.seek(SeekFrom::Current(-4))?;
        }

        // Color Table (Indexed)
        if mode == 2 {
            println!("  Indexed Mode: Skipping 768 bytes color table + 4 bytes padding?");
            // Usually color table is 256 * 3 = 768 bytes.
            // Often followed by 4 bytes (maybe transparency index?)
            // Just scan for VMA to be safe.
        }

        // Pattern Data (VMA)
        let mut vma_found = false;
        let mut channels = Vec::new();
        // Use read H/W if valid, otherwise VMA will override
        let mut actual_width = width as u32;
        let mut actual_height = height as u32;

        // Helper to scan for VMA
        let scan_start = cursor.position();
        let max_scan = 2000;
        let mut buffer = vec![0u8; max_scan];
        let read_len = cursor.read(&mut buffer)?;
        cursor.seek(SeekFrom::Start(scan_start))?;

        let mut vma_offset_rel = 0;

        // Heuristic: VMA usually starts immediately if no color table
        // Or after color table.
        // VMA: Ver(4), Size(4), Top(4), Left(4), Bottom(4), Right(4), Depth(2), Comp(1) ...

        for offset in 0..read_len.saturating_sub(32) {
            let d = &buffer[offset..];
            let v = i32::from_be_bytes([d[0], d[1], d[2], d[3]]);
            let s = u32::from_be_bytes([d[4], d[5], d[6], d[7]]);
            let top = i32::from_be_bytes([d[12], d[13], d[14], d[15]]);
            let left = i32::from_be_bytes([d[16], d[17], d[18], d[19]]);
            let bottom = i32::from_be_bytes([d[20], d[21], d[22], d[23]]);
            let right = i32::from_be_bytes([d[24], d[25], d[26], d[27]]);

            // Safe subtraction
            let h_diff = bottom.wrapping_sub(top);
            let w_diff = right.wrapping_sub(left);

            // Check
            if (0..=10).contains(&v)
                && s > 0
                && s < 100_000_000
                && h_diff > 0
                && w_diff > 0
                && h_diff < 10000
                && w_diff < 10000
                && d[30] <= 1
            {
                // Check depth (28-29) == 8 *usually*
                let depth = i16::from_be_bytes([d[28], d[29]]);
                if depth == 8 {
                    vma_offset_rel = offset as u64;
                    actual_width = w_diff as u32;
                    actual_height = h_diff as u32;
                    vma_found = true;
                    println!(
                        "  Found VMA at +{}: {}x{}, Comp={}",
                        offset, actual_width, actual_height, d[30]
                    );
                    break;
                }
            }
        }

        if !vma_found {
            println!("  ERROR: VMA not found.");
            break;
        }

        cursor.seek(SeekFrom::Current(vma_offset_rel as i64))?;

        // Determine channel count
        // Mode 3 (RGB) = 3 channels
        // Mode 1 (Gray) = 1 channel
        // Mode 2 (Indexed) = 1 channel?
        // But safe to just try reading channels until invalid VMA.
        // BUT pat files might pack channels tightly.
        // ABR patt.rs handled n_channels loop.

        let n = if mode == 3 { 3 } else { 1 };

        for ch in 0..n {
            let start_vma = cursor.position();
            let mut header = [0u8; 32];
            if cursor.read_exact(&mut header).is_err() {
                break;
            }

            let s = u32::from_be_bytes([header[4], header[5], header[6], header[7]]) as usize;
            let compression = header[30];
            let target_len = (actual_width as usize) * (actual_height as usize);

            // Decode
            let mut channel_pixels: Vec<u8> = vec![0u8; target_len]; // Default black

            if compression == 0 {
                let data_bytes_len = s.saturating_sub(23);
                if data_bytes_len > 0 {
                    cursor.seek(SeekFrom::Start(start_vma + 31))?;
                    if data_bytes_len == target_len {
                        cursor.read_exact(&mut channel_pixels)?;
                    } else {
                        // Read what we can
                        let mut raw = vec![0u8; data_bytes_len];
                        cursor.read_exact(&mut raw)?;
                        if raw.len() <= target_len {
                            channel_pixels[..raw.len()].copy_from_slice(&raw);
                        }
                    }
                }
            } else {
                // RLE
                cursor.seek(SeekFrom::Start(start_vma + 31))?;
                // Row Table
                let mut row_table = vec![0u8; (actual_height as usize) * 2];
                cursor.read_exact(&mut row_table)?;

                let mut row_lengths = Vec::with_capacity(actual_height as usize);
                for r in 0..(actual_height as usize) {
                    row_lengths.push(u16::from_be_bytes([row_table[r*2], row_table[r*2+1]]) as usize);
                }

                let mut decoded = Vec::with_capacity(target_len);

                for &rlen in &row_lengths {
                    let mut rdata = vec![0u8; rlen];
                    cursor.read_exact(&mut rdata)?;

                    // PackBits
                    let mut i = 0;
                    while i < rdata.len() {
                        let b = rdata[i] as i8;
                        i += 1;
                        if b >= 0 {
                            let count = (b as usize) + 1;
                            let end = (i + count).min(rdata.len());
                            decoded.extend_from_slice(&rdata[i..end]);
                            i += count;
                        } else if b != -128 {
                            let count = ((-b) as usize) + 1;
                            if i < rdata.len() {
                                let val = rdata[i];
                                i += 1;
                                for _ in 0..count {
                                    decoded.push(val);
                                }
                            }
                        }
                    }
                }

                // Fit to target
                if decoded.len() >= target_len {
                    channel_pixels = decoded[..target_len].to_vec();
                } else {
                    channel_pixels[..decoded.len()].copy_from_slice(&decoded);
                }
            }

            channels.push(channel_pixels);

            // Next channel
            // If we rely on PAT file structure, maybe channels appear sequentially.
            // VMA size field tells us exactly where next VMA starts.
            let next_pos = start_vma as u64 + 8 + s as u64;
            cursor.seek(SeekFrom::Start(next_pos))?;
        }

        println!("  Decoded {} channels", channels.len());

        // Valid image generation
        if channels.len() >= 3 {
            let safe_name = name
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '_')
                .collect::<String>();
            let fname = output_dir.join(format!("pat{}_{}.png", i, safe_name));
            let mut img = RgbaImage::new(actual_width, actual_height);

            let len = channels[0]
                .len()
                .min(channels[1].len())
                .min(channels[2].len());
            for y in 0..actual_height {
                for x in 0..actual_width {
                    let idx = (y * actual_width + x) as usize;
                    if idx < len {
                        img.put_pixel(
                            x,
                            y,
                            Rgba([channels[0][idx], channels[1][idx], channels[2][idx], 255]),
                        );
                    }
                }
            }
            img.save(&fname)?;
            println!("  -> Saved {}", fname.display());
        } else if channels.len() >= 1 {
            let safe_name = name
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '_')
                .collect::<String>();
            let fname = output_dir.join(format!("pat{}_{}.png", i, safe_name));
            let mut img = GrayImage::new(actual_width, actual_height);

            for y in 0..actual_height {
                for x in 0..actual_width {
                    let idx = (y * actual_width + x) as usize;
                    if idx < channels[0].len() {
                        img.put_pixel(x, y, Luma([channels[0][idx]]));
                    }
                }
            }
            img.save(&fname)?;
            println!("  -> Saved {}", fname.display());
        }
    }

    Ok(())
}
