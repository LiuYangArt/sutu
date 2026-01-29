/// Debug panicking patterns - step by step
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

    let idx = 8; // sparthtex01
    let pattern = &abr.patterns[idx];

    println!("Pattern #{}: {}", idx, pattern.name.trim_end_matches('\0'));
    println!("Size: {}x{}", pattern.width, pattern.height);
    println!("Mode: {}", pattern.mode);
    println!("Data length: {}", pattern.data.len());

    println!("Checking bounds...");
    println!("  pattern.data.len() = {}", pattern.data.len());

    if pattern.data.len() < 64 {
        println!("  Data too short!");
        return Ok(());
    }

    println!("Printing first 64 bytes manually...");
    for i in 0..64 {
        if i < pattern.data.len() {
            print!("{:02X} ", pattern.data[i]);
            if (i + 1) % 16 == 0 {
                println!();
            }
        }
    }

    println!("\nDone!");
    Ok(())
}
