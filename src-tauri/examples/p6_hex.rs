/// Deep hex analysis of Pattern #6
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
    let pattern = &abr.patterns[6];

    println!(
        "Pattern #6: {} ({}x{})",
        pattern.name.trim_end_matches('\0'),
        pattern.width,
        pattern.height
    );
    println!(
        "Mode: {}, Data Length: {}\n",
        pattern.mode,
        pattern.data.len()
    );

    let d = &pattern.data;

    // Print first 512 bytes
    println!("First 512 bytes:");
    for row in 0..32 {
        let start = row * 16;
        if start >= d.len() {
            break;
        }
        print!("  {:04X}: ", start);
        for i in start..(start + 16).min(d.len()) {
            print!("{:02X} ", d[i]);
        }
        print!(" |");
        for i in start..(start + 16).min(d.len()) {
            let c = d[i];
            if c >= 32 && c < 127 {
                print!("{}", c as char);
            } else {
                print!(".");
            }
        }
        println!("|");
    }

    // Check if this is JPEG embedded
    if d.len() > 3 && d[0] == 0xFF && d[1] == 0xD8 {
        println!("\nThis looks like JPEG data!");
    }

    // Parse the apparent structure
    println!("\nStructure analysis:");

    println!("  [0] = {} (mode/type)", d[0]);

    let total_size = u32::from_be_bytes([d[1], d[2], d[3], d[4]]);
    println!("  [1-4] = {} (total size)", total_size);

    println!(
        "  [5-8] = {:02X} {:02X} {:02X} {:02X}",
        d[5], d[6], d[7], d[8]
    );
    println!(
        "  [9-12] = {:02X} {:02X} {:02X} {:02X}",
        d[9], d[10], d[11], d[12]
    );

    // offset 13-14 has height
    let height_at_13 = u16::from_be_bytes([d[13], d[14]]);
    println!("  [13-14] = {} (height BE)", height_at_13);

    // offset 17-18 has width
    let width_at_17 = u16::from_be_bytes([d[17], d[18]]);
    println!("  [17-18] = {} (width? BE)", width_at_17);

    // Let's check every 2-byte and 4-byte value in first 64 bytes
    println!("\nAll 2-byte BE values in first 64 bytes:");
    for i in 0..62 {
        let val = u16::from_be_bytes([d[i], d[i + 1]]);
        if val > 0 && val < 10000 {
            print!("@{}: {} ", i, val);
        }
    }
    println!();

    // Check structure based on Bubbles which works
    // Bubbles offset 25 has VMA: version=1, size=6423, rect=(0,0,80,80), depth=8, comp=0
    // The key fields at offset 25:
    // [25-28]: version (should be 1)
    // [29-32]: size
    // [33-36]: dummy
    // [37-40]: top
    // [41-44]: left
    // [45-48]: bottom
    // [49-52]: right
    // [53-54]: depth
    // [55]: compression

    println!("\nChecking if offset 25 structure:");
    if d.len() > 56 {
        let version = i32::from_be_bytes([d[25], d[26], d[27], d[28]]);
        let size = u32::from_be_bytes([d[29], d[30], d[31], d[32]]);
        let top = i32::from_be_bytes([d[37], d[38], d[39], d[40]]);
        let left = i32::from_be_bytes([d[41], d[42], d[43], d[44]]);
        let bottom = i32::from_be_bytes([d[45], d[46], d[47], d[48]]);
        let right = i32::from_be_bytes([d[49], d[50], d[51], d[52]]);
        let depth = i16::from_be_bytes([d[53], d[54]]);
        let comp = d[55];

        println!(
            "  version={}, size={}, rect=({},{},{},{}) -> {}x{}, depth={}, comp={}",
            version,
            size,
            top,
            left,
            bottom,
            right,
            (right - left) as usize,
            (bottom - top) as usize,
            depth,
            comp
        );
    }

    println!("\nDone!");
    Ok(())
}
