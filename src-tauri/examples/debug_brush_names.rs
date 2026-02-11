//! Debug script to analyze brush UUID matching issues
#![allow(warnings)]

use std::collections::HashMap;
use sutu_lib::abr::{AbrBrush, AbrParser};

fn main() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    println!("Analyzing: {:?}", path);

    let data = std::fs::read(&path).expect("Failed to read file");
    let abr = AbrParser::parse(&data).expect("Failed to parse ABR");

    println!("\n=== BRUSHES FROM SAMP SECTION ===");
    println!("Total brushes: {}", abr.brushes.len());

    // Count brushes with generic names
    let generic_count = abr
        .brushes
        .iter()
        .filter(|b| b.name.starts_with("Brush_"))
        .count();
    let named_count = abr.brushes.len() - generic_count;

    println!("Named brushes: {}", named_count);
    println!("Generic (Brush_N) brushes: {}", generic_count);

    println!("\n=== BRUSH DETAILS ===");
    for (i, brush) in abr.brushes.iter().enumerate() {
        let uuid_short = brush
            .uuid
            .as_ref()
            .map(|u| {
                if u.len() > 20 {
                    format!("{}...", &u[..20])
                } else {
                    u.clone()
                }
            })
            .unwrap_or_else(|| "NONE".to_string());

        let has_texture = brush.texture_settings.as_ref().map_or(false, |t| t.enabled);

        println!(
            "#{:3} | Name: {:30} | UUID: {:25} | HasTex: {}",
            i,
            if brush.name.len() > 30 {
                format!("{}...", &brush.name[..27])
            } else {
                brush.name.clone()
            },
            uuid_short,
            has_texture
        );
    }

    // Show which brushes have generic names
    println!("\n=== BRUSHES WITH GENERIC NAMES (need investigation) ===");
    for (i, brush) in abr.brushes.iter().enumerate() {
        if brush.name.starts_with("Brush_") {
            println!("#{}: {} -> UUID: {:?}", i, brush.name, brush.uuid);
        }
    }
}
