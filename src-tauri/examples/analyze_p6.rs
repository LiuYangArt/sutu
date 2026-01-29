/// Deep analysis of Pattern #6 structure
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
    let pattern = &abr.patterns[6]; // Pattern 1 (1996x1804)

    println!("DEEP ANALYSIS: Pattern #6");
    println!("==========================");
    println!("Name: {}", pattern.name.trim_end_matches('\0'));
    println!("Size: {}x{}", pattern.width, pattern.height);
    println!("Mode: {} (Grayscale)", pattern.mode);
    println!("Data Length: {}\n", pattern.data.len());

    let width = pattern.width as usize; // 1996
    let height = pattern.height as usize; // 1804

    // Print first 256 bytes with detailed analysis
    println!("First 256 bytes:");
    for row in 0..16 {
        let start = row * 16;
        print!("  {:04X}: ", start);
        for i in start..(start + 16).min(pattern.data.len()) {
            print!("{:02X} ", pattern.data[i]);
        }
        println!();
    }

    // Analysis of the header
    println!("\nHeader analysis:");
    let d = &pattern.data;

    // Byte 0: 03 = n_channels? (but mode=1 is grayscale, so should be 1)
    println!("  [0] = {} (n_channels or format version?)", d[0]);

    // Bytes 1-4: seems to be size
    let size_at_1 = u32::from_be_bytes([d[1], d[2], d[3], d[4]]);
    println!("  [1-4] = {} (total size?)", size_at_1);

    // Look for height and width values in the data
    println!(
        "\nSearching for {}x{} ({}x{} in hex: 0x{:X}, 0x{:X}):",
        height, width, height, width, height, width
    );

    // Search for BE 4-byte patterns
    for i in 0..100 {
        if i + 4 > d.len() {
            break;
        }

        let val = u32::from_be_bytes([d[i], d[i + 1], d[i + 2], d[i + 3]]);
        if val == height as u32 || val == width as u32 {
            println!("  Found {}  at offset {} (4-byte BE)", val, i);
        }

        // Also check 2-byte
        if i + 2 <= d.len() {
            let val2 = u16::from_be_bytes([d[i], d[i + 1]]);
            if val2 == height as u16 || val2 == width as u16 {
                println!("  Found {} at offset {} (2-byte BE)", val2, i);
            }
        }
    }

    // Based on the hex dump, offset 12-19 seems interesting
    // 0x0C: CC 00 00 07 0C 00 00 00
    println!("\nBytes 12-27 interpreted:");
    println!(
        "  [12-13] = {} (u16 BE)",
        u16::from_be_bytes([d[12], d[13]])
    );
    println!(
        "  [14-15] = {} (u16 BE)",
        u16::from_be_bytes([d[14], d[15]])
    );
    println!(
        "  [12-15] = {} (u32 BE)",
        u32::from_be_bytes([d[12], d[13], d[14], d[15]])
    );
    println!(
        "  [16-17] = {} (u16 BE)",
        u16::from_be_bytes([d[16], d[17]])
    );
    println!(
        "  [18-19] = {} (u16 BE)",
        u16::from_be_bytes([d[18], d[19]])
    );
    println!(
        "  [16-19] = {} (u32 BE)",
        u32::from_be_bytes([d[16], d[17], d[18], d[19]])
    );

    // The structure might be different for RLE compressed patterns
    // Let's check byte 56 (after 2 possible VMA headers of 28 bytes each)
    if d.len() > 60 {
        println!("\nBytes around offset 56:");
        for i in 50..70.min(d.len()) {
            print!("{:02X} ", d[i]);
        }
        println!();
    }

    // The VMA for large patterns might use 2-byte rect fields
    println!("\nTrying 2-byte rect interpretation at various offsets:");
    for test_offset in [5, 21, 25, 27, 29] {
        if test_offset + 27 > d.len() {
            continue;
        }

        let dd = &d[test_offset..];

        // Try structure: ver(4) + size(4) + dummy(4) + top(2) + left(2) + bottom(2) + right(2) + depth(2) + comp(1)
        // = 4 + 4 + 4 + 2 + 2 + 2 + 2 + 2 + 1 = 23 bytes
        let version = i32::from_be_bytes([dd[0], dd[1], dd[2], dd[3]]);
        let size = u32::from_be_bytes([dd[4], dd[5], dd[6], dd[7]]);
        let dummy = i32::from_be_bytes([dd[8], dd[9], dd[10], dd[11]]);
        let top = i16::from_be_bytes([dd[12], dd[13]]);
        let left = i16::from_be_bytes([dd[14], dd[15]]);
        let bottom = i16::from_be_bytes([dd[16], dd[17]]);
        let right = i16::from_be_bytes([dd[18], dd[19]]);
        let depth = i16::from_be_bytes([dd[20], dd[21]]);
        let compression = dd[22];

        let h = (bottom - top) as usize;
        let w = (right - left) as usize;

        println!(
            "  Offset {}: ver={}, size={}, dummy={}, rect=({},{},{},{})->{}x{}, depth={}, comp={}",
            test_offset, version, size, dummy, top, left, bottom, right, w, h, depth, compression
        );

        if (w == width && h == height) || (w == height && h == width) {
            println!("    ^ MATCH!");
        }
    }

    println!("\nDone!");
    Ok(())
}
