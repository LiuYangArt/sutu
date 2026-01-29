/// Quick test to find VMA in all patterns
use paintboard_lib::abr::AbrParser;
use std::fs::File;
use std::io::Read;
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Disable logging
    std::env::set_var("RUST_LOG", "error");

    let abr_path = Path::new("f:/CodeProjects/PaintBoard/abr/liuyang_paintbrushes.abr");
    let mut file = File::open(abr_path)?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)?;

    let abr = AbrParser::parse(&data)?;

    eprintln!("Checking {} patterns...\n", abr.patterns.len());

    for (idx, pattern) in abr.patterns.iter().enumerate() {
        eprint!(
            "#{}: {} {}x{} mode={} data_len={} ... ",
            idx,
            pattern.name.trim_end_matches('\0'),
            pattern.width,
            pattern.height,
            pattern.mode,
            pattern.data.len()
        );

        let w = pattern.width as usize;
        let h = pattern.height as usize;

        let mut found = false;
        for test_offset in 0..500 {
            if test_offset + 31 > pattern.data.len() {
                break;
            }

            let d = &pattern.data[test_offset..];

            let version = i32::from_be_bytes([d[0], d[1], d[2], d[3]]);
            let top = i32::from_be_bytes([d[12], d[13], d[14], d[15]]);
            let left = i32::from_be_bytes([d[16], d[17], d[18], d[19]]);
            let bottom = i32::from_be_bytes([d[20], d[21], d[22], d[23]]);
            let right = i32::from_be_bytes([d[24], d[25], d[26], d[27]]);
            let depth = i16::from_be_bytes([d[28], d[29]]);
            let compression = d[30];

            let vma_h = (bottom - top) as isize;
            let vma_w = (right - left) as isize;

            let dims_match = vma_h > 0
                && vma_w > 0
                && ((vma_h == h as isize && vma_w == w as isize)
                    || (vma_h == w as isize && vma_w == h as isize));

            if dims_match && version >= 0 && version <= 10 && depth == 8 && compression <= 1 {
                eprintln!(
                    "VMA at {} (depth={}, comp={})",
                    test_offset, depth, compression
                );
                found = true;
                break;
            }
        }

        if !found {
            eprintln!("MISS");
        }
    }

    eprintln!("\nDone!");
    Ok(())
}
