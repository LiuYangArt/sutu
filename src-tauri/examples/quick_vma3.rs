/// Quick VMA search - with catch
use paintboard_lib::abr::AbrParser;
use std::fs::File;
use std::io::Read;
use std::panic;
use std::path::Path;

fn check_vma(pattern_data: &[u8], w: usize, h: usize) -> Option<(usize, u8)> {
    let max_search = 100.min(pattern_data.len().saturating_sub(31));

    for test_offset in 0..max_search {
        let d = &pattern_data[test_offset..];

        let version = i32::from_be_bytes([d[0], d[1], d[2], d[3]]);
        let top = i32::from_be_bytes([d[12], d[13], d[14], d[15]]);
        let left = i32::from_be_bytes([d[16], d[17], d[18], d[19]]);
        let bottom = i32::from_be_bytes([d[20], d[21], d[22], d[23]]);
        let right = i32::from_be_bytes([d[24], d[25], d[26], d[27]]);
        let depth = i16::from_be_bytes([d[28], d[29]]);
        let compression = d[30];

        if bottom <= top || right <= left {
            continue;
        }

        let vma_h = (bottom - top) as usize;
        let vma_w = (right - left) as usize;

        let dims_match = (vma_h == h && vma_w == w) || (vma_h == w && vma_w == h);

        if dims_match && (0..=10).contains(&version) && depth == 8 && compression <= 1 {
            return Some((test_offset, compression));
        }
    }
    None
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let abr_path = Path::new("f:/CodeProjects/PaintBoard/abr/liuyang_paintbrushes.abr");
    let mut file = File::open(abr_path)?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)?;

    let abr = AbrParser::parse(&data)?;

    println!("Found {} patterns", abr.patterns.len());

    for (idx, pattern) in abr.patterns.iter().enumerate() {
        print!(
            "#{} {} {}x{} mode={} ... ",
            idx,
            pattern.name.trim_end_matches('\0'),
            pattern.width,
            pattern.height,
            pattern.mode
        );
        std::io::Write::flush(&mut std::io::stdout())?;

        let w = pattern.width as usize;
        let h = pattern.height as usize;

        let result = panic::catch_unwind(|| check_vma(&pattern.data, w, h));

        match result {
            Ok(Some((offset, comp))) => println!("VMA@{} comp={}", offset, comp),
            Ok(None) => println!("MISS"),
            Err(_) => println!("PANIC"),
        }
    }

    println!("\nDone!");
    Ok(())
}
