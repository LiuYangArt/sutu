/// Debug Pattern #8
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

    // Only check patterns 8, 9, 11
    for idx in [8, 9, 11] {
        if idx >= abr.patterns.len() {
            continue;
        }

        let pattern = &abr.patterns[idx];
        println!(
            "Pattern #{}: {} ({}x{})",
            idx,
            pattern.name.trim_end_matches('\0'),
            pattern.width,
            pattern.height
        );
        println!("  Mode: {}", pattern.mode);
        println!("  Data Length: {}", pattern.data.len());

        let pattern_width = pattern.width as usize;
        let pattern_height = pattern.height as usize;

        // Print first 128 bytes
        println!("  First 128 bytes:");
        for row in 0..8 {
            let start = row * 16;
            if start >= pattern.data.len() {
                break;
            }
            print!("    {:04X}: ", start);
            for i in start..(start + 16).min(pattern.data.len()) {
                print!("{:02X} ", pattern.data[i]);
            }
            println!();
        }

        // Search for VMA with relaxed constraints
        println!("\n  Searching for VMA...");
        for test_offset in 0..2000 {
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

            let vma_height = (bottom - top) as usize;
            let vma_width = (right - left) as usize;

            // Check if dimensions match (allow swapped)
            let dims_match = (vma_height == pattern_height && vma_width == pattern_width)
                || (vma_height == pattern_width && vma_width == pattern_height);

            if dims_match && version >= 0 && version <= 10 && depth > 0 && compression <= 1 {
                println!("    Found at offset {}: ver={}, size={}, rect=({},{},{},{}) -> {}x{}, depth={}, comp={}",
                    test_offset, version, size, top, left, bottom, right, vma_width, vma_height, depth, compression);
            }
        }

        println!();
    }

    println!("Done!");
    Ok(())
}
