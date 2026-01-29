/// Analyze Pattern #8 structure
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

    for idx in [8, 11, 12] {
        let pattern = &abr.patterns[idx];

        println!(
            "\n=== Pattern #{}: {} ({}x{}, mode={}) ===",
            idx,
            pattern.name.trim_end_matches('\0'),
            pattern.width,
            pattern.height,
            pattern.mode
        );
        println!("Data length: {}", pattern.data.len());

        let w = pattern.width as usize;
        let h = pattern.height as usize;
        let n_channels = if pattern.mode == 3 { 3 } else { 1 };
        let expected_raw = w * h * n_channels;

        println!(
            "Expected raw size: {} ({}x{}x{})",
            expected_raw, w, h, n_channels
        );

        // Print first 256 bytes with annotations
        println!("\nFirst 256 bytes:");
        for row in 0..16 {
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

        // Check if data starts at offset 0 as raw/RLE
        println!("\nAnalyzing potential formats:");

        // Check for "mode/channel count" header like Bubbles
        if pattern.data.len() > 5 {
            let first_byte = pattern.data[0];
            let next_4_bytes = u32::from_be_bytes([
                pattern.data[1],
                pattern.data[2],
                pattern.data[3],
                pattern.data[4],
            ]);
            println!("  [0] = {} (n_channels?)", first_byte);
            println!("  [1-4] = {} (size field?)", next_4_bytes);
        }

        // Search for width/height values
        println!("\n  Looking for {}x{} or {}x{} in data:", w, h, h, w);
        for i in 0..100.min(pattern.data.len().saturating_sub(4)) {
            // 2-byte BE
            if i + 2 <= pattern.data.len() {
                let v = u16::from_be_bytes([pattern.data[i], pattern.data[i + 1]]);
                if v == w as u16 {
                    println!("    Found width {} at offset {} (2-byte BE)", v, i);
                }
                if v == h as u16 {
                    println!("    Found height {} at offset {} (2-byte BE)", v, i);
                }
            }
            // 4-byte BE
            if i + 4 <= pattern.data.len() {
                let v = u32::from_be_bytes([
                    pattern.data[i],
                    pattern.data[i + 1],
                    pattern.data[i + 2],
                    pattern.data[i + 3],
                ]);
                if v == w as u32 {
                    println!("    Found width {} at offset {} (4-byte BE)", v, i);
                }
                if v == h as u32 {
                    println!("    Found height {} at offset {} (4-byte BE)", v, i);
                }
            }
        }
    }

    println!("\nDone!");
    Ok(())
}
