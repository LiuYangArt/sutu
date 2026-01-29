/// Ultra-safe VMA search
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

    let idx = 8;
    let pattern = &abr.patterns[idx];

    println!(
        "#{} {} {}x{}",
        idx,
        pattern.name.trim_end_matches('\0'),
        pattern.width,
        pattern.height
    );
    println!("Data len: {}", pattern.data.len());

    // Try to call get() instead of slice indexing
    for test_offset in 0..40 {
        println!("  Testing offset {}", test_offset);

        // Use get() for safe access
        let bytes: Option<Vec<u8>> = (0..31)
            .map(|i| pattern.data.get(test_offset + i).copied())
            .collect();

        let Some(d) = bytes else {
            println!("    -> Out of bounds at offset {}", test_offset);
            break;
        };

        println!("    -> Got 31 bytes");

        // Parse bytes
        let version = i32::from_be_bytes([d[0], d[1], d[2], d[3]]);
        let top = i32::from_be_bytes([d[12], d[13], d[14], d[15]]);
        let left = i32::from_be_bytes([d[16], d[17], d[18], d[19]]);
        let bottom = i32::from_be_bytes([d[20], d[21], d[22], d[23]]);
        let right = i32::from_be_bytes([d[24], d[25], d[26], d[27]]);

        if test_offset < 5 {
            println!(
                "    ver={} rect=({},{},{},{})",
                version, top, left, bottom, right
            );
        }
    }

    println!("Done!");
    Ok(())
}
