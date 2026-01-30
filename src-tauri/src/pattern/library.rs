//! Pattern Library management
//!
//! Provides CRUD operations for the pattern library:
//! - Import patterns from .pat files
//! - Store pattern metadata in index
//! - Manage pattern images via pattern_cache

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::pat::{parse_pat_file, ParsedPattern};
use super::types::{ImportResult, PatternMode, PatternResource};
use crate::brush::pattern_cache;

/// Pattern library index (persisted to disk)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PatternIndex {
    /// All patterns indexed by ID
    pub patterns: HashMap<String, PatternResource>,
    /// Pattern groups (group name -> pattern IDs)
    pub groups: HashMap<String, Vec<String>>,
}

/// Global pattern library instance
static LIBRARY: RwLock<Option<PatternLibrary>> = RwLock::new(None);

/// Pattern library manager
#[derive(Debug)]
pub struct PatternLibrary {
    /// Pattern index
    index: PatternIndex,
    /// Library directory path
    library_dir: PathBuf,
    /// Dirty flag (needs save)
    dirty: bool,
}

impl PatternLibrary {
    /// Create a new library at the given path
    pub fn new(library_dir: PathBuf) -> Self {
        Self {
            index: PatternIndex::default(),
            library_dir,
            dirty: false,
        }
    }

    /// Load library from disk
    pub fn load(library_dir: PathBuf) -> Self {
        let index_path = library_dir.join("index.json");
        let index = if index_path.exists() {
            match std::fs::read_to_string(&index_path) {
                Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
                Err(e) => {
                    tracing::warn!("Failed to load pattern index: {}", e);
                    PatternIndex::default()
                }
            }
        } else {
            PatternIndex::default()
        };

        tracing::info!(
            "Loaded pattern library: {} patterns, {} groups",
            index.patterns.len(),
            index.groups.len()
        );

        Self {
            index,
            library_dir,
            dirty: false,
        }
    }

    /// Save library index to disk
    pub fn save(&mut self) -> std::io::Result<()> {
        if !self.dirty {
            return Ok(());
        }

        std::fs::create_dir_all(&self.library_dir)?;
        let index_path = self.library_dir.join("index.json");
        let json = serde_json::to_string_pretty(&self.index)?;
        std::fs::write(&index_path, json)?;
        self.dirty = false;

        tracing::debug!("Saved pattern library index");
        Ok(())
    }

    /// Get all patterns
    pub fn get_all_patterns(&self) -> Vec<PatternResource> {
        self.index.patterns.values().cloned().collect()
    }

    /// Get pattern by ID
    pub fn get_pattern(&self, id: &str) -> Option<&PatternResource> {
        self.index.patterns.get(id)
    }

    /// Get patterns in a group
    pub fn get_group_patterns(&self, group: &str) -> Vec<&PatternResource> {
        self.index
            .groups
            .get(group)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| self.index.patterns.get(id))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Get all group names
    pub fn get_groups(&self) -> Vec<String> {
        self.index.groups.keys().cloned().collect()
    }

    /// Import patterns from a .pat file
    pub fn import_pat_file(&mut self, path: &Path) -> Result<ImportResult, String> {
        let patterns = parse_pat_file(path).map_err(|e| e.to_string())?;

        // Use filename as group name
        let group_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Imported")
            .to_string();

        let source = path.to_string_lossy().to_string();
        let mut imported_count = 0;
        let mut skipped_count = 0;
        let mut pattern_ids = Vec::new();

        for parsed in patterns {
            match self.add_parsed_pattern(parsed, &source, Some(group_name.clone())) {
                Ok(id) => {
                    pattern_ids.push(id);
                    imported_count += 1;
                }
                Err(e) => {
                    if e.contains("duplicate") {
                        skipped_count += 1;
                    } else {
                        tracing::warn!("Failed to add pattern: {}", e);
                    }
                }
            }
        }

        self.dirty = true;
        let _ = self.save();

        Ok(ImportResult {
            imported_count,
            skipped_count,
            pattern_ids,
        })
    }

    /// Add a parsed pattern to the library
    fn add_parsed_pattern(
        &mut self,
        parsed: ParsedPattern,
        source: &str,
        group: Option<String>,
    ) -> Result<String, String> {
        // Calculate content hash
        let mut hasher = Sha256::new();
        hasher.update(&parsed.rgba_data);
        let hash = hasher.finalize();
        let content_hash = hex::encode(hash);

        // Check for duplicate
        for existing in self.index.patterns.values() {
            if existing.content_hash == content_hash {
                return Err(format!("duplicate: {}", existing.id));
            }
        }

        // Generate ID
        let id = if parsed.id.is_empty() {
            content_hash[..16].to_string()
        } else {
            parsed.id.clone()
        };

        // Store image data in cache
        pattern_cache::cache_pattern_rgba(
            id.clone(),
            parsed.rgba_data,
            parsed.width,
            parsed.height,
            parsed.name.clone(),
            parsed.mode.name().to_string(),
        );

        // Create resource
        let resource = PatternResource {
            id: id.clone(),
            name: parsed.name,
            content_hash,
            width: parsed.width,
            height: parsed.height,
            mode: parsed.mode,
            source: source.to_string(),
            group: group.clone(),
        };

        // Add to index
        self.index.patterns.insert(id.clone(), resource);

        // Add to group
        if let Some(group_name) = group {
            self.index
                .groups
                .entry(group_name)
                .or_default()
                .push(id.clone());
        }

        self.dirty = true;
        Ok(id)
    }

    /// Add a pattern from brush (already decoded RGBA data)
    pub fn add_from_brush(
        &mut self,
        brush_id: &str,
        name: String,
        rgba_data: Vec<u8>,
        width: u32,
        height: u32,
        mode: PatternMode,
    ) -> Result<PatternResource, String> {
        // Calculate content hash
        let mut hasher = Sha256::new();
        hasher.update(&rgba_data);
        let hash = hasher.finalize();
        let content_hash = hex::encode(hash);

        // Check for duplicate
        for existing in self.index.patterns.values() {
            if existing.content_hash == content_hash {
                return Err(format!("Pattern already exists: {}", existing.name));
            }
        }

        // Use brush ID as pattern ID
        let id = format!("brush_{}", brush_id);

        // Store image data
        pattern_cache::cache_pattern_rgba(
            id.clone(),
            rgba_data,
            width,
            height,
            name.clone(),
            mode.name().to_string(),
        );

        let resource = PatternResource {
            id: id.clone(),
            name,
            content_hash,
            width,
            height,
            mode,
            source: "user-added".to_string(),
            group: Some("From Brushes".to_string()),
        };

        self.index.patterns.insert(id.clone(), resource.clone());
        self.index
            .groups
            .entry("From Brushes".to_string())
            .or_default()
            .push(id);

        self.dirty = true;
        let _ = self.save();

        Ok(resource)
    }

    /// Delete a pattern
    pub fn delete_pattern(&mut self, id: &str) -> Result<(), String> {
        if self.index.patterns.remove(id).is_none() {
            return Err(format!("Pattern not found: {}", id));
        }

        // Remove from all groups
        for group in self.index.groups.values_mut() {
            group.retain(|pid| pid != id);
        }

        // Clean up empty groups
        self.index.groups.retain(|_, ids| !ids.is_empty());

        self.dirty = true;
        let _ = self.save();

        tracing::info!("Deleted pattern: {}", id);
        Ok(())
    }

    /// Rename a pattern
    pub fn rename_pattern(&mut self, id: &str, new_name: String) -> Result<(), String> {
        let pattern = self
            .index
            .patterns
            .get_mut(id)
            .ok_or_else(|| format!("Pattern not found: {}", id))?;

        pattern.name = new_name;
        self.dirty = true;
        let _ = self.save();

        Ok(())
    }

    /// Move pattern to a different group
    pub fn move_to_group(&mut self, id: &str, new_group: String) -> Result<(), String> {
        // Verify pattern exists
        let pattern = self
            .index
            .patterns
            .get_mut(id)
            .ok_or_else(|| format!("Pattern not found: {}", id))?;

        let old_group = pattern.group.clone();
        pattern.group = Some(new_group.clone());

        // Remove from old group
        if let Some(old_group) = old_group {
            if let Some(group) = self.index.groups.get_mut(&old_group) {
                group.retain(|pid| pid != id);
            }
        }

        // Add to new group
        self.index
            .groups
            .entry(new_group)
            .or_default()
            .push(id.to_string());

        // Clean up empty groups
        self.index.groups.retain(|_, ids| !ids.is_empty());

        self.dirty = true;
        let _ = self.save();

        Ok(())
    }

    /// Rename a group
    pub fn rename_group(&mut self, old_name: &str, new_name: String) -> Result<(), String> {
        // Get patterns in old group
        let pattern_ids = self
            .index
            .groups
            .remove(old_name)
            .ok_or_else(|| format!("Group not found: {}", old_name))?;

        // Update pattern group references
        for id in &pattern_ids {
            if let Some(pattern) = self.index.patterns.get_mut(id) {
                pattern.group = Some(new_name.clone());
            }
        }

        // Add to new group name
        self.index.groups.insert(new_name, pattern_ids);

        self.dirty = true;
        let _ = self.save();

        Ok(())
    }
}

// === Global library operations ===

/// Get the library directory path
fn get_library_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.paintboard")
        .join("patterns")
}

/// Initialize the global pattern library
pub fn init_library() {
    let library_dir = get_library_dir();
    let mut guard = LIBRARY.write();
    *guard = Some(PatternLibrary::load(library_dir));
    tracing::info!("Pattern library initialized");
}

/// Get all patterns from the library
pub fn get_all_patterns() -> Vec<PatternResource> {
    let guard = LIBRARY.read();
    guard
        .as_ref()
        .map(|lib| lib.get_all_patterns())
        .unwrap_or_default()
}

/// Import a .pat file into the library
pub fn import_pat_file(path: &Path) -> Result<ImportResult, String> {
    let mut guard = LIBRARY.write();
    let lib = guard
        .as_mut()
        .ok_or_else(|| "Library not initialized".to_string())?;
    lib.import_pat_file(path)
}

/// Add pattern from brush to library
pub fn add_from_brush(
    brush_id: &str,
    name: String,
    rgba_data: Vec<u8>,
    width: u32,
    height: u32,
    mode: PatternMode,
) -> Result<PatternResource, String> {
    let mut guard = LIBRARY.write();
    let lib = guard
        .as_mut()
        .ok_or_else(|| "Library not initialized".to_string())?;
    lib.add_from_brush(brush_id, name, rgba_data, width, height, mode)
}

/// Delete a pattern
pub fn delete_pattern(id: &str) -> Result<(), String> {
    let mut guard = LIBRARY.write();
    let lib = guard
        .as_mut()
        .ok_or_else(|| "Library not initialized".to_string())?;
    lib.delete_pattern(id)
}

/// Rename a pattern
pub fn rename_pattern(id: &str, new_name: String) -> Result<(), String> {
    let mut guard = LIBRARY.write();
    let lib = guard
        .as_mut()
        .ok_or_else(|| "Library not initialized".to_string())?;
    lib.rename_pattern(id, new_name)
}

/// Move pattern to group
pub fn move_to_group(id: &str, group: String) -> Result<(), String> {
    let mut guard = LIBRARY.write();
    let lib = guard
        .as_mut()
        .ok_or_else(|| "Library not initialized".to_string())?;
    lib.move_to_group(id, group)
}

/// Rename a group
pub fn rename_group(old_name: &str, new_name: String) -> Result<(), String> {
    let mut guard = LIBRARY.write();
    let lib = guard
        .as_mut()
        .ok_or_else(|| "Library not initialized".to_string())?;
    lib.rename_group(old_name, new_name)
}
