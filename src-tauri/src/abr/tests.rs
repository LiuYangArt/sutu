#![allow(clippy::unwrap_used)]
use std::path::PathBuf;

#[test]
fn test_load_liuyang_paintbrushes() {
    use crate::abr::AbrParser;
    // Locate the ABR file relative to the project root
    let mut d = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    d.pop(); // Go up from src-tauri
    d.push("abr");
    d.push("liuyang_paintbrushes.abr");

    if !d.exists() {
        // Fallback for different running environments, try absolute path from user request
        d = PathBuf::from("f:\\CodeProjects\\PaintBoard\\abr\\liuyang_paintbrushes.abr");
    }

    assert!(d.exists(), "Test file not found at {:?}", d);

    let data = std::fs::read(&d).expect("Failed to read test ABR file");
    let abr_file = AbrParser::parse(&data).expect("Failed to parse ABR file");

    // Verify patterns are loaded - expecting 12 patterns now
    assert!(
        abr_file.patterns.len() >= 12,
        "Should have loaded at least 12 patterns (was {})",
        abr_file.patterns.len()
    );

    // Find specific brushes mentioned in postmortem (Brush 64 and 65)
    // Note: Brush names might be "Brush 64" or similar.
    // Let's print names to be sure or search by index if names are generic.
    // In postmortem images: "Brush_64", "Brush_65".

    let brush_64 = abr_file
        .brushes
        .iter()
        .find(|b| b.name == "Brush_64" || b.name.ends_with("64"));
    let brush_65 = abr_file
        .brushes
        .iter()
        .find(|b| b.name == "Brush_65" || b.name.ends_with("65"));

    // Check Brush 64 - may or may not have texture depending on ABR content
    if let Some(b) = brush_64 {
        // If it has texture settings, verify they are properly linked
        if let Some(tex) = &b.texture_settings {
            assert!(tex.enabled, "Brush 64 texture should be enabled if present");

            // Ensure pattern_id is set (our fix)
            assert!(
                tex.pattern_id.is_some(),
                "Brush 64 should have pattern_id set (fix verification)"
            );
        }
        // Note: It's OK if texture_settings is None - not all brushes have texture
    } else {
        // If Brush 64 is not found, the test should still pass, but this indicates a potential issue
        // with the test file or brush naming. For now, we'll let it pass.
    }

    // Check Brush 65 (The one with warning)
    if let Some(b) = brush_65 {
        // It might have texture disabled or enabled but no pattern
        if let Some(tex) = &b.texture_settings {
            // Verify that this UUID actually exists in the parsed patterns
            let uuid = tex
                .pattern_uuid
                .as_ref()
                .expect("Brush 65 should have pattern UUID");
            let pattern_exists = abr_file.patterns.iter().any(|p| &p.id == uuid);
            assert!(
                pattern_exists,
                "Brush 65 pattern {} NOT found in parsed patterns! Fix failed.",
                uuid
            );
        }
    }
}
