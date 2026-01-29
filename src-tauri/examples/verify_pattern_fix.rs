#![allow(clippy::unwrap_used)]
use paintboard_lib::abr::AbrParser;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn main() {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "paintboard_lib=debug,verify_pattern_fix=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    let data = std::fs::read(&path).expect("Failed to read file");

    match AbrParser::parse(&data) {
        Ok(abr) => {
            println!("Successfully parsed ABR file.");
            println!("Brushes: {}", abr.brushes.len());
            println!("Patterns: {}", abr.patterns.len());

            println!("\n=== Checking Texture Associations ===");
            for (i, brush) in abr.brushes.iter().enumerate() {
                if let Some(tex) = &brush.texture_settings {
                    println!("Brush #{} '{}':", i, brush.name);
                    println!("  Enabled: {}", tex.enabled);
                    println!("  Pattern Name: {:?}", tex.pattern_name);
                    println!("  Pattern ID (linked): {:?}", tex.pattern_id);
                    // pattern_uuid is mostly internal, but we can verify pattern_id matches a pattern

                    if let Some(pid) = &tex.pattern_id {
                        if let Some(p) = abr.patterns.iter().find(|p| &p.id == pid) {
                            println!("  -> Linked to Pattern: '{}' (ID: {})", p.name, p.id);
                        } else {
                            println!("  -> [ERROR] Linked Pattern ID not found in library!");
                        }
                    } else if tex.enabled {
                        println!("  -> [WARNING] Texture enabled but NO Pattern ID linked!");
                    }
                }
            }
        }
        Err(e) => {
            eprintln!("Failed to parse: {}", e);
        }
    }
}
