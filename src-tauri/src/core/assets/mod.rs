//! Shared asset import APIs for desktop and future iPad adapters.

use crate::abr::{AbrFile, AbrParser, BrushPreset};
use crate::core::contracts::{BrushPresetCore, PatternResourceCore};
use crate::core::errors::CoreError;
use crate::pattern::pat::{parse_pat_data, ParsedPattern};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone)]
pub struct ImportAbrCoreResult {
    pub presets: Vec<BrushPresetCore>,
    pub tips: Vec<BrushPresetCore>,
    pub patterns: Vec<PatternResourceCore>,
}

#[derive(Debug, Clone)]
pub struct ImportPatCoreResult {
    pub patterns: Vec<PatternResourceCore>,
}

fn map_brush_preset_to_core(preset: BrushPreset) -> BrushPresetCore {
    BrushPresetCore {
        id: preset.id,
        source_uuid: preset.source_uuid,
        name: preset.name,
        diameter: preset.diameter,
        spacing: preset.spacing,
        hardness: preset.hardness,
        angle: preset.angle,
        roundness: preset.roundness,
        has_texture: preset.has_texture,
        is_computed: preset.is_computed,
        texture_width: preset.texture_width,
        texture_height: preset.texture_height,
        size_pressure: preset.size_pressure,
        opacity_pressure: preset.opacity_pressure,
        base_opacity: preset.base_opacity,
        base_flow: preset.base_flow,
    }
}

fn map_abr_file_to_core(file: AbrFile, source: &str) -> ImportAbrCoreResult {
    let mut presets = Vec::with_capacity(file.brushes.len());
    let mut tips = Vec::with_capacity(file.brushes.len());

    for brush in file.brushes {
        let is_tip_only = brush.is_tip_only;
        let preset: BrushPresetCore = map_brush_preset_to_core(brush.into());
        if is_tip_only {
            tips.push(preset);
        } else {
            presets.push(preset.clone());
            tips.push(preset);
        }
    }

    let patterns = file
        .patterns
        .into_iter()
        .map(|pattern| {
            let mut hasher = Sha256::new();
            hasher.update(&pattern.data);
            let mode = pattern.mode_name().to_string();
            PatternResourceCore {
                id: pattern.id,
                name: pattern.name,
                content_hash: hex::encode(hasher.finalize()),
                width: pattern.width,
                height: pattern.height,
                mode,
                source: source.to_string(),
                group: None,
            }
        })
        .collect();

    ImportAbrCoreResult {
        presets,
        tips,
        patterns,
    }
}

fn map_parsed_pattern_to_core(pattern: ParsedPattern, source: &str) -> PatternResourceCore {
    let mut hasher = Sha256::new();
    hasher.update(&pattern.rgba_data);
    let content_hash = hex::encode(hasher.finalize());
    PatternResourceCore {
        id: if pattern.id.is_empty() {
            content_hash[..16].to_string()
        } else {
            pattern.id
        },
        name: pattern.name,
        content_hash,
        width: pattern.width,
        height: pattern.height,
        mode: pattern.mode.name().to_string(),
        source: source.to_string(),
        group: None,
    }
}

pub fn import_abr_from_bytes(data: &[u8]) -> Result<ImportAbrCoreResult, CoreError> {
    let file = AbrParser::parse(data).map_err(|err| CoreError::AssetParse(err.to_string()))?;
    Ok(map_abr_file_to_core(file, "memory://abr"))
}

pub fn import_abr_from_path(path: &Path) -> Result<ImportAbrCoreResult, CoreError> {
    let data = std::fs::read(path)?;
    let source = path.to_string_lossy().to_string();
    let file = AbrParser::parse(&data).map_err(|err| CoreError::AssetParse(err.to_string()))?;
    Ok(map_abr_file_to_core(file, &source))
}

pub fn import_pat_from_bytes(data: &[u8]) -> Result<ImportPatCoreResult, CoreError> {
    let parsed = parse_pat_data(data).map_err(|err| CoreError::AssetParse(err.to_string()))?;
    let patterns = parsed
        .into_iter()
        .map(|pattern| map_parsed_pattern_to_core(pattern, "memory://pat"))
        .collect();
    Ok(ImportPatCoreResult { patterns })
}

pub fn import_pat_from_path(path: &Path) -> Result<ImportPatCoreResult, CoreError> {
    let data = std::fs::read(path)?;
    let source = path.to_string_lossy().to_string();
    let parsed = parse_pat_data(&data).map_err(|err| CoreError::AssetParse(err.to_string()))?;
    let patterns = parsed
        .into_iter()
        .map(|pattern| map_parsed_pattern_to_core(pattern, &source))
        .collect();
    Ok(ImportPatCoreResult { patterns })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn repo_root() -> std::path::PathBuf {
        let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest
            .parent()
            .expect("workspace root should exist")
            .to_path_buf()
    }

    #[test]
    fn abr_path_and_bytes_match_basic_metadata() {
        let path = repo_root().join("abr/202002.abr");
        let path_result = import_abr_from_path(&path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let bytes_result = import_abr_from_bytes(&bytes).unwrap();

        assert_eq!(path_result.presets.len(), bytes_result.presets.len());
        assert_eq!(path_result.tips.len(), bytes_result.tips.len());
        assert_eq!(path_result.patterns.len(), bytes_result.patterns.len());
    }

    #[test]
    fn pat_path_and_bytes_match_basic_metadata() {
        let path = repo_root().join("abr/test_patterns.pat");
        let path_result = import_pat_from_path(&path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let bytes_result = import_pat_from_bytes(&bytes).unwrap();

        assert_eq!(path_result.patterns.len(), bytes_result.patterns.len());
        if let (Some(a), Some(b)) = (path_result.patterns.first(), bytes_result.patterns.first()) {
            assert_eq!(a.width, b.width);
            assert_eq!(a.height, b.height);
            assert_eq!(a.mode, b.mode);
        }
    }
}
