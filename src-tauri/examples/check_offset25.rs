/// Check VMA at offset 25 for all patterns
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
            "\nPattern #{}: {} ({}x{}, mode={})",
            idx,
            pattern.name.trim_end_matches('\0'),
            pattern.width,
            pattern.height,
            pattern.mode
        );

        let w = pattern.width as usize;
        let h = pattern.height as usize;

        // Check VMA-like structure at offset 25
        for test_offset in [25, 27, 29] {
            if test_offset + 55 > pattern.data.len() {
                continue;
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

            println!(
                "  Offset {}: ver={}, size={}, rect=({},{},{},{}) depth={}, comp={}",
                test_offset, version, size, top, left, bottom, right, depth, compression
            );

            // Try 2-byte rect interpretation
            let top2 = i16::from_be_bytes([d[12], d[13]]);
            let left2 = i16::from_be_bytes([d[14], d[15]]);
            let bottom2 = i16::from_be_bytes([d[16], d[17]]);
            let right2 = i16::from_be_bytes([d[18], d[19]]);
            let depth2 = i16::from_be_bytes([d[20], d[21]]);
            let comp2 = d[22];

            println!(
                "    2-byte rect: ({},{},{},{}) -> {}x{}, depth={}, comp={}",
                top2,
                left2,
                bottom2,
                right2,
                (right2 - left2).abs(),
                (bottom2 - top2).abs(),
                depth2,
                comp2
            );
        }
    }

    println!("\nDone!");
    Ok(())
}
