#![allow(warnings)]
use paintboard_lib::abr::AbrParser;
use std::collections::HashMap;
use std::path::PathBuf;

fn main() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let abr_path = PathBuf::from(manifest_dir)
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    println!("Loading ABR from: {:?}", abr_path);

    let data = std::fs::read(&abr_path).expect("Failed to read ABR file");
    let file = AbrParser::parse(&data).expect("Failed to parse ABR file");

    println!("Parsed {} brushes", file.brushes.len());

    // 1. Verify count
    assert_eq!(
        file.brushes.len(),
        79,
        "Expected 79 brushes, got {}",
        file.brushes.len()
    );

    // 2. Verify specific brushes order (match desc list order)
    let expected_order: Vec<(&str, bool)> = vec![
        ("喷枪 纹理4", false),           // 0, sampled
        ("喷枪 杂点4", false),           // 1, sampled
        ("Soft Round 500 1", true),      // 2, computed
        ("Hard Round 100 不透明", true), // 3, computed
    ];

    for (i, (expected_name, expected_computed)) in expected_order.iter().enumerate() {
        let brush = &file.brushes[i];
        println!(
            "Brush[{}]: '{}' (computed: {})",
            i, brush.name, brush.is_computed
        );

        assert_eq!(
            brush.name.trim(),
            *expected_name,
            "Name mismatch at index {}",
            i
        );
        assert_eq!(
            brush.is_computed, *expected_computed,
            "Computed flag mismatch at index {}",
            i
        );

        if *expected_computed {
            assert!(
                brush.tip_image.is_some(),
                "Computed brush should have generated tip image"
            );
            let img = brush.tip_image.as_ref().unwrap();
            println!("  -> Generated tip size: {}x{}", img.width, img.height);
            assert!(
                img.width > 0 && img.height > 0,
                "Generated tip should not be empty"
            );
        }
    }

    println!("VERIFICATION SUCCESS: All checks passed!");
}
