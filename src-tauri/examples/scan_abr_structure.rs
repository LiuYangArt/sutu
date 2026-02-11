#![allow(warnings)]
//! Scan ABR file structure to find ALL `patt` sections and compare with parsed patterns.
//! This script helps diagnose why some patterns are missing.

use std::collections::HashSet;
use std::path::Path;
use sutu_lib::abr::AbrParser;

fn main() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    println!("=== ABR Structure Scanner ===");
    println!("File: {:?}\n", path);

    let data = std::fs::read(&path).expect("Failed to read file");
    println!("File size: {} bytes\n", data.len());

    // 1. Scan for ALL `patt` section markers in raw bytes
    println!("=== Scanning for 'patt' markers ===");
    let patt_positions = find_all_occurrences(&data, b"patt");
    println!(
        "Found {} 'patt' markers at positions:",
        patt_positions.len()
    );
    for (i, pos) in patt_positions.iter().enumerate() {
        // Show context around each marker
        let start = if *pos >= 8 { pos - 8 } else { 0 };
        let end = std::cmp::min(pos + 32, data.len());
        println!(
            "  #{}: offset 0x{:08X} ({}) | Context: {:02X?}",
            i,
            pos,
            pos,
            &data[start..end]
        );
    }

    // 2. Scan for `8BIM` resource markers (standard PSD resource format)
    println!("\n=== Scanning for '8BIM' resource markers ===");
    let bim_positions = find_all_occurrences(&data, b"8BIM");
    println!("Found {} '8BIM' markers", bim_positions.len());

    // 3. Scan for `Patt` (capital P) - different resource type
    println!("\n=== Scanning for 'Patt' (capital) markers ===");
    let patt_cap_positions = find_all_occurrences(&data, b"Patt");
    println!(
        "Found {} 'Patt' markers at positions:",
        patt_cap_positions.len()
    );
    for (i, pos) in patt_cap_positions.iter().enumerate() {
        let start = if *pos >= 8 { pos - 8 } else { 0 };
        let end = std::cmp::min(pos + 32, data.len());
        println!(
            "  #{}: offset 0x{:08X} ({}) | Context: {:02X?}",
            i,
            pos,
            pos,
            &data[start..end]
        );
    }

    // 4. Parse with our parser and see what we get
    println!("\n=== Parsed Patterns via AbrParser ===");
    let abr = AbrParser::parse(&data).expect("Failed to parse ABR");

    println!("Parsed {} patterns:", abr.patterns.len());
    let mut parsed_ids: HashSet<String> = HashSet::new();
    let mut parsed_names: HashSet<String> = HashSet::new();

    for (i, p) in abr.patterns.iter().enumerate() {
        println!(
            "  #{}: ID='{}' Name='{}' Size={}x{} Mode={}",
            i, p.id, p.name, p.width, p.height, p.mode
        );
        parsed_ids.insert(p.id.clone());
        parsed_names.insert(p.name.clone());
    }

    // 5. Check what patterns brushes are referencing
    println!("\n=== Brush Pattern References ===");
    let mut referenced_ids: HashSet<String> = HashSet::new();
    let mut referenced_names: HashSet<String> = HashSet::new();

    for (i, b) in abr.brushes.iter().enumerate() {
        if let Some(ref tex) = b.texture_settings {
            if tex.enabled {
                let id = tex.pattern_id.as_deref().unwrap_or("None");
                let name = tex.pattern_name.as_deref().unwrap_or("None");
                println!(
                    "  Brush #{} '{}': PatternID='{}' PatternName='{}'",
                    i, b.name, id, name
                );

                if let Some(ref pid) = tex.pattern_id {
                    referenced_ids.insert(pid.clone());
                }
                if let Some(ref pname) = tex.pattern_name {
                    referenced_names.insert(pname.clone());
                }
            }
        }
    }

    // 6. Cross-reference
    println!("\n=== Cross Reference ===");
    println!("Referenced Pattern IDs that are NOT in parsed patterns:");
    for id in &referenced_ids {
        if !parsed_ids.contains(id) {
            println!("  MISSING ID: {}", id);
        }
    }

    println!("\nReferenced Pattern Names that are NOT in parsed patterns:");
    for name in &referenced_names {
        if !parsed_names.contains(name) {
            println!("  MISSING NAME: {}", name);
        }
    }

    // 7. Search for specific pattern names in raw bytes
    println!("\n=== Searching for specific pattern names in raw bytes ===");
    let search_names = ["Pattern 1", "metal2", "Metal", "pattern"];
    for name in search_names {
        let positions = find_all_occurrences(&data, name.as_bytes());
        if !positions.is_empty() {
            println!(
                "  '{}' found at {} positions: {:?}",
                name,
                positions.len(),
                positions.iter().take(5).collect::<Vec<_>>()
            );
        } else {
            println!("  '{}' NOT found", name);
        }
    }
}

fn find_all_occurrences(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    let mut positions = Vec::new();
    let mut start = 0;
    while let Some(pos) = haystack[start..]
        .windows(needle.len())
        .position(|w| w == needle)
    {
        positions.push(start + pos);
        start = start + pos + 1;
    }
    positions
}
