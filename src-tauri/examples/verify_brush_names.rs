#![allow(warnings)]
use paintboard_lib::abr::AbrParser;
use std::path::Path;

fn main() {
    // Setup tracing
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .init();

    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    println!("Reading ABR: {:?}", path);
    if !path.exists() {
        println!("File not found!");
        return;
    }

    let data = std::fs::read(&path).expect("Failed to read file");

    println!("Parsing ABR...");
    match AbrParser::parse(&data) {
        Ok(abr) => {
            println!("Found {} brushes", abr.brushes.len());
            for (i, brush) in abr.brushes.iter().enumerate() {
                if i == 0 || i == 6 {
                    println!(">>> CHECK BRUSH #{} <<<", i);
                    println!("Name: '{}'", brush.name);
                    println!("UUID: '{:?}'", brush.uuid);
                }
                if i > 6 {
                    break;
                }
            }
        }
        Err(e) => {
            println!("Failed to parse: {}", e);
        }
    }
}
