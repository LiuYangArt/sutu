/// Debug panicking patterns
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

    // Check pattern 8 which panics
    for idx in [8, 11, 12] {
        let pattern = &abr.patterns[idx];
        println!(
            "\n=== Pattern #{}: {} ===",
            idx,
            pattern.name.trim_end_matches('\0')
        );
        println!("Size: {}x{}", pattern.width, pattern.height);
        println!("Mode: {}", pattern.mode);
        println!("Data length: {}", pattern.data.len());

        // Check data bounds
        println!("Data available: {}", pattern.data.len());
        println!("Expected for VMA check: 31 bytes");

        if pattern.data.len() < 31 {
            println!("ERROR: Data too short!");
            continue;
        }

        let w = pattern.width as usize;
        let h = pattern.height as usize;

        // Print first 64 bytes
        println!("First 64 bytes:");
        for row in 0..4 {
            let start = row * 16;
            print!("  {:04X}: ", start);
            for i in start..(start + 16).min(pattern.data.len()) {
                print!("{:02X} ", pattern.data[i]);
            }
            println!();
        }

        // Manual check at offset 0..50
        println!("\nSearching for dimensions match:");
        for test_offset in 0..50.min(pattern.data.len().saturating_sub(31)) {
            let d = &pattern.data[test_offset..];

            // Bounds check
            if d.len() < 31 {
                println!("  Offset {}: not enough data", test_offset);
                break;
            }

            let top = i32::from_be_bytes([d[12], d[13], d[14], d[15]]);
            let left = i32::from_be_bytes([d[16], d[17], d[18], d[19]]);
            let bottom = i32::from_be_bytes([d[20], d[21], d[22], d[23]]);
            let right = i32::from_be_bytes([d[24], d[25], d[26], d[27]]);

            if bottom > top && right > left {
                let vma_h = (bottom - top) as usize;
                let vma_w = (right - left) as usize;

                if (vma_h == h && vma_w == w) || (vma_h == w && vma_w == h) {
                    let version = i32::from_be_bytes([d[0], d[1], d[2], d[3]]);
                    let depth = i16::from_be_bytes([d[28], d[29]]);
                    let comp = d[30];
                    println!(
                        "  Offset {}: rect=({},{},{},{}) -> {}x{}, ver={}, depth={}, comp={}",
                        test_offset, top, left, bottom, right, vma_w, vma_h, version, depth, comp
                    );
                }
            }
        }
    }

    println!("\nDone!");
    Ok(())
}
