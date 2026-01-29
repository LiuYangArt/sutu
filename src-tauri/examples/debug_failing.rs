/// Debug failing patterns
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

    println!("DEBUGGING FAILING PATTERNS");
    println!("==========================\n");

    // Check patterns that failed
    for idx in [5, 6, 8, 9, 11] {
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

        let width = pattern.width as usize;
        let height = pattern.height as usize;

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

        // Search for VMA-like header with relaxed constraints
        println!("\n  Searching for VMA header (relaxed):");
        for test_offset in 0..1000 {
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

            // Relaxed check
            if version >= 0
                && version <= 10
                && size > 0
                && size < 20000000
                && top >= 0
                && left >= 0
                && bottom > top
                && right > left
                && (bottom - top) as usize == height
                && (right - left) as usize == width
                && compression <= 1
            {
                println!(
                    "    Found at offset {}: ver={}, size={}, depth={}, comp={}",
                    test_offset, version, size, depth, compression
                );
                break;
            }
        }

        println!();
    }

    println!("Done!");
    Ok(())
}
