//! Brush library persistence and management.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::abr::BrushPreset;
use crate::app_meta::APP_CONFIG_DIR_NAME;
use crate::brush::{clone_cached_brush, delete_cached_brush};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrushTipResource {
    #[serde(flatten)]
    pub tip: BrushPreset,
    pub source: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrushLibraryPreset {
    #[serde(flatten)]
    pub preset: BrushPreset,
    pub tip_id: Option<String>,
    pub group: Option<String>,
    pub source: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrushLibraryPresetPayload {
    pub preset: BrushPreset,
    pub tip_id: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrushLibraryGroup {
    pub name: String,
    pub preset_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrushLibrarySnapshot {
    pub presets: Vec<BrushLibraryPreset>,
    pub tips: Vec<BrushTipResource>,
    pub groups: Vec<BrushLibraryGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrushLibraryImportResult {
    pub imported_preset_count: usize,
    pub skipped_preset_count: usize,
    pub imported_tip_count: usize,
    pub skipped_tip_count: usize,
    pub snapshot: BrushLibrarySnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BrushLibraryIndex {
    presets: HashMap<String, BrushLibraryPreset>,
    tips: HashMap<String, BrushTipResource>,
    groups: HashMap<String, Vec<String>>,
}

static LIBRARY: RwLock<Option<BrushLibrary>> = RwLock::new(None);

#[derive(Debug)]
pub struct BrushLibrary {
    index: BrushLibraryIndex,
    library_dir: PathBuf,
    dirty: bool,
}

impl BrushLibrary {
    pub fn new(library_dir: PathBuf) -> Self {
        Self {
            index: BrushLibraryIndex::default(),
            library_dir,
            dirty: false,
        }
    }

    pub fn load(library_dir: PathBuf) -> Self {
        let index_path = library_dir.join("index.json");
        let index = if index_path.exists() {
            match std::fs::read_to_string(&index_path) {
                Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
                Err(err) => {
                    tracing::warn!("Failed to load brush library index: {}", err);
                    BrushLibraryIndex::default()
                }
            }
        } else {
            BrushLibraryIndex::default()
        };

        tracing::info!(
            "Loaded brush library: {} presets, {} tips, {} groups",
            index.presets.len(),
            index.tips.len(),
            index.groups.len()
        );

        Self {
            index,
            library_dir,
            dirty: false,
        }
    }

    pub fn save(&mut self) -> std::io::Result<()> {
        if !self.dirty {
            return Ok(());
        }

        std::fs::create_dir_all(&self.library_dir)?;
        let index_path = self.library_dir.join("index.json");
        let json = serde_json::to_string_pretty(&self.index)?;
        std::fs::write(&index_path, json)?;
        self.dirty = false;
        Ok(())
    }

    pub fn snapshot(&self) -> BrushLibrarySnapshot {
        let mut presets: Vec<_> = self.index.presets.values().cloned().collect();
        presets.sort_by(|a, b| {
            a.group
                .as_deref()
                .unwrap_or("")
                .cmp(b.group.as_deref().unwrap_or(""))
                .then_with(|| a.preset.name.cmp(&b.preset.name))
        });

        let mut tips: Vec<_> = self.index.tips.values().cloned().collect();
        tips.sort_by(|a, b| a.tip.name.cmp(&b.tip.name));

        let mut groups: Vec<_> = self
            .index
            .groups
            .iter()
            .map(|(name, ids)| BrushLibraryGroup {
                name: name.clone(),
                preset_ids: ids.clone(),
            })
            .collect();
        groups.sort_by(|a, b| a.name.cmp(&b.name));

        BrushLibrarySnapshot {
            presets,
            tips,
            groups,
        }
    }

    pub fn import_from_abr(
        &mut self,
        source_path: &str,
        presets: Vec<BrushPreset>,
        tips: Vec<BrushPreset>,
    ) -> Result<BrushLibraryImportResult, String> {
        let source = source_path.to_string();
        let group_name = Path::new(source_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("Imported")
            .to_string();

        let mut imported_tip_count = 0usize;
        let mut skipped_tip_count = 0usize;
        let mut imported_preset_count = 0usize;
        let mut skipped_preset_count = 0usize;

        let mut tip_aliases: HashMap<String, String> = HashMap::new();

        for mut tip in tips {
            let incoming_tip_id = tip.id.clone();
            let source_uuid = sanitize_optional_id(tip.source_uuid.as_deref());
            let content_hash = hash_tip(&tip);

            let existing_tip_id = source_uuid
                .as_deref()
                .and_then(|uuid| self.find_tip_id_by_source_uuid(uuid))
                .or_else(|| self.find_tip_id_by_content_hash(&content_hash));

            let resolved_tip_id = if let Some(existing_id) = existing_tip_id {
                skipped_tip_count += 1;
                existing_id
            } else {
                let unique_tip_id = self.ensure_unique_tip_id(&incoming_tip_id);
                if unique_tip_id != incoming_tip_id {
                    let _ = clone_cached_brush(&incoming_tip_id, &unique_tip_id);
                }
                tip.id = unique_tip_id.clone();

                let resource = BrushTipResource {
                    tip,
                    source: source.clone(),
                    content_hash,
                };
                self.index.tips.insert(unique_tip_id.clone(), resource);
                imported_tip_count += 1;
                self.dirty = true;
                unique_tip_id
            };

            tip_aliases.insert(incoming_tip_id, resolved_tip_id.clone());
            if let Some(uuid) = source_uuid {
                tip_aliases.insert(uuid, resolved_tip_id.clone());
            }
        }

        for mut preset in presets {
            let primary_tip_id = self.resolve_primary_tip_id(&preset, &tip_aliases);
            let mapped_dual = preset
                .dual_brush_settings
                .as_ref()
                .and_then(|dual| dual.brush_id.as_ref())
                .and_then(|id| tip_aliases.get(id).cloned())
                .or_else(|| {
                    preset
                        .dual_brush_settings
                        .as_ref()
                        .and_then(|dual| dual.brush_id.clone())
                        .and_then(|id| self.resolve_tip_candidate(&id))
                });

            if let Some(dual) = preset.dual_brush_settings.as_mut() {
                dual.brush_id = mapped_dual;
            }

            let source_uuid = sanitize_optional_id(preset.source_uuid.as_deref());
            let content_hash = hash_preset(&preset, primary_tip_id.as_deref());
            let duplicate_preset_id = source_uuid
                .as_deref()
                .and_then(|uuid| self.find_preset_id_by_source_uuid(uuid))
                .or_else(|| self.find_preset_id_by_content_hash(&content_hash));

            if duplicate_preset_id.is_some() {
                skipped_preset_count += 1;
                continue;
            }

            let incoming_id = preset.id.clone();
            let unique_id = self.ensure_unique_preset_id(&incoming_id);
            preset.id = unique_id.clone();

            let entry = BrushLibraryPreset {
                preset,
                tip_id: primary_tip_id,
                group: Some(group_name.clone()),
                source: source.clone(),
                content_hash,
            };

            self.index.presets.insert(unique_id.clone(), entry);
            self.index
                .groups
                .entry(group_name.clone())
                .or_default()
                .push(unique_id);

            imported_preset_count += 1;
            self.dirty = true;
        }

        self.cleanup_groups();
        self.save().map_err(|e| e.to_string())?;

        Ok(BrushLibraryImportResult {
            imported_preset_count,
            skipped_preset_count,
            imported_tip_count,
            skipped_tip_count,
            snapshot: self.snapshot(),
        })
    }

    pub fn rename_preset(&mut self, id: &str, new_name: String) -> Result<(), String> {
        let name = new_name.trim().to_string();
        if name.is_empty() {
            return Err("Preset name cannot be empty".to_string());
        }

        let entry = self
            .index
            .presets
            .get_mut(id)
            .ok_or_else(|| format!("Preset not found: {}", id))?;
        entry.preset.name = name;
        self.dirty = true;
        self.save().map_err(|e| e.to_string())
    }

    pub fn delete_preset(&mut self, id: &str) -> Result<(), String> {
        let removed = self
            .index
            .presets
            .remove(id)
            .ok_or_else(|| format!("Preset not found: {}", id))?;

        self.remove_preset_from_groups(id);

        let mut candidate_tip_ids: HashSet<String> = HashSet::new();
        if let Some(tip_id) = removed.tip_id {
            candidate_tip_ids.insert(tip_id);
        }
        if let Some(dual) = removed.preset.dual_brush_settings {
            if let Some(dual_tip_id) = dual.brush_id {
                candidate_tip_ids.insert(dual_tip_id);
            }
        }

        for tip_id in candidate_tip_ids {
            if !self.is_tip_referenced(&tip_id) {
                self.index.tips.remove(&tip_id);
                delete_cached_brush(&tip_id);
            }
        }

        self.cleanup_groups();
        self.dirty = true;
        self.save().map_err(|e| e.to_string())
    }

    pub fn move_preset_to_group(&mut self, id: &str, group: String) -> Result<(), String> {
        let group_name = group.trim().to_string();
        if group_name.is_empty() {
            return Err("Group name cannot be empty".to_string());
        }

        let entry = self
            .index
            .presets
            .get_mut(id)
            .ok_or_else(|| format!("Preset not found: {}", id))?;

        entry.group = Some(group_name.clone());

        self.remove_preset_from_groups(id);
        self.index
            .groups
            .entry(group_name)
            .or_default()
            .push(id.to_string());

        self.cleanup_groups();
        self.dirty = true;
        self.save().map_err(|e| e.to_string())
    }

    pub fn rename_group(&mut self, old_name: &str, new_name: String) -> Result<(), String> {
        let normalized_old = old_name.trim();
        let normalized_new = new_name.trim();
        if normalized_old.is_empty() || normalized_new.is_empty() {
            return Err("Group name cannot be empty".to_string());
        }

        let preset_ids = self
            .index
            .groups
            .remove(normalized_old)
            .ok_or_else(|| format!("Group not found: {}", normalized_old))?;

        for preset_id in &preset_ids {
            if let Some(preset) = self.index.presets.get_mut(preset_id) {
                preset.group = Some(normalized_new.to_string());
            }
        }

        self.index
            .groups
            .entry(normalized_new.to_string())
            .or_default()
            .extend(preset_ids);

        self.cleanup_groups();
        self.dirty = true;
        self.save().map_err(|e| e.to_string())
    }

    pub fn delete_group(&mut self, group_name: &str) -> Result<(), String> {
        let normalized = group_name.trim();
        if normalized.is_empty() {
            return Err("Group name cannot be empty".to_string());
        }

        let preset_ids = self
            .index
            .groups
            .remove(normalized)
            .ok_or_else(|| format!("Group not found: {}", normalized))?;

        let mut candidate_tip_ids: HashSet<String> = HashSet::new();
        for preset_id in preset_ids {
            if let Some(removed) = self.index.presets.remove(&preset_id) {
                if let Some(tip_id) = removed.tip_id {
                    candidate_tip_ids.insert(tip_id);
                }

                if let Some(dual) = removed.preset.dual_brush_settings {
                    if let Some(dual_tip_id) = dual.brush_id {
                        candidate_tip_ids.insert(dual_tip_id);
                    }
                }
            }
        }

        for tip_id in candidate_tip_ids {
            if !self.is_tip_referenced(&tip_id) {
                self.index.tips.remove(&tip_id);
                delete_cached_brush(&tip_id);
            }
        }

        self.cleanup_groups();
        self.dirty = true;
        self.save().map_err(|e| e.to_string())
    }

    pub fn save_preset(
        &mut self,
        payload: BrushLibraryPresetPayload,
    ) -> Result<BrushLibraryPreset, String> {
        let preset_id = payload.preset.id.clone();
        let existing = self
            .index
            .presets
            .get(&preset_id)
            .cloned()
            .ok_or_else(|| format!("Preset not found: {}", preset_id))?;

        let name = payload.preset.name.trim().to_string();
        if name.is_empty() {
            return Err("Preset name cannot be empty".to_string());
        }

        let mut preset = payload.preset;
        preset.id = preset_id.clone();
        preset.name = name;

        let tip_id = self.resolve_payload_tip_id(payload.tip_id.as_deref());
        self.remap_dual_brush_tip(&mut preset);

        let group = payload.group.or(existing.group.clone());
        let content_hash = hash_preset(&preset, tip_id.as_deref());

        let updated = BrushLibraryPreset {
            preset,
            tip_id,
            group: group.clone(),
            source: existing.source,
            content_hash,
        };

        self.index
            .presets
            .insert(preset_id.clone(), updated.clone());
        self.remove_preset_from_groups(&preset_id);
        if let Some(group_name) = group {
            self.index
                .groups
                .entry(group_name)
                .or_default()
                .push(preset_id);
        }

        self.cleanup_groups();
        self.dirty = true;
        self.save().map_err(|e| e.to_string())?;

        Ok(updated)
    }

    pub fn save_preset_as(
        &mut self,
        payload: BrushLibraryPresetPayload,
        new_name: String,
        target_group: Option<String>,
    ) -> Result<BrushLibraryPreset, String> {
        let name = new_name.trim().to_string();
        if name.is_empty() {
            return Err("Preset name cannot be empty".to_string());
        }

        let mut preset = payload.preset;
        let base_id = if preset.id.trim().is_empty() {
            unique_id_token()
        } else {
            preset.id.clone()
        };

        let new_id = self.ensure_unique_preset_id(&format!("{}-copy", base_id));
        preset.id = new_id.clone();
        preset.name = name;

        let tip_id = self.resolve_payload_tip_id(payload.tip_id.as_deref());
        self.remap_dual_brush_tip(&mut preset);

        let group = target_group.or(payload.group).and_then(|g| {
            let trimmed = g.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });

        let content_hash = hash_preset(&preset, tip_id.as_deref());

        let created = BrushLibraryPreset {
            preset,
            tip_id,
            group: group.clone(),
            source: "user-saved".to_string(),
            content_hash,
        };

        self.index.presets.insert(new_id.clone(), created.clone());
        if let Some(group_name) = group {
            self.index
                .groups
                .entry(group_name)
                .or_default()
                .push(new_id);
        }

        self.cleanup_groups();
        self.dirty = true;
        self.save().map_err(|e| e.to_string())?;

        Ok(created)
    }

    fn resolve_primary_tip_id(
        &self,
        preset: &BrushPreset,
        tip_aliases: &HashMap<String, String>,
    ) -> Option<String> {
        if !preset.has_texture {
            return None;
        }

        tip_aliases
            .get(&preset.id)
            .cloned()
            .or_else(|| {
                preset
                    .source_uuid
                    .as_deref()
                    .and_then(|uuid| tip_aliases.get(uuid))
                    .cloned()
            })
            .or_else(|| self.resolve_tip_candidate(&preset.id))
            .or_else(|| {
                preset
                    .source_uuid
                    .as_deref()
                    .and_then(|uuid| self.find_tip_id_by_source_uuid(uuid))
            })
    }

    fn resolve_tip_candidate(&self, candidate: &str) -> Option<String> {
        if self.index.tips.contains_key(candidate) {
            return Some(candidate.to_string());
        }

        self.find_tip_id_by_source_uuid(candidate)
    }

    fn resolve_payload_tip_id(&self, tip_id: Option<&str>) -> Option<String> {
        tip_id.and_then(|candidate| self.resolve_tip_candidate(candidate))
    }

    fn remap_dual_brush_tip(&self, preset: &mut BrushPreset) {
        if let Some(dual) = preset.dual_brush_settings.as_mut() {
            dual.brush_id = dual
                .brush_id
                .as_deref()
                .and_then(|candidate| self.resolve_tip_candidate(candidate));
        }
    }

    fn ensure_unique_tip_id(&self, preferred: &str) -> String {
        ensure_unique_id(preferred, |id| self.index.tips.contains_key(id))
    }

    fn ensure_unique_preset_id(&self, preferred: &str) -> String {
        ensure_unique_id(preferred, |id| self.index.presets.contains_key(id))
    }

    fn find_tip_id_by_source_uuid(&self, source_uuid: &str) -> Option<String> {
        self.index
            .tips
            .values()
            .find(|tip| tip.tip.source_uuid.as_deref() == Some(source_uuid))
            .map(|tip| tip.tip.id.clone())
    }

    fn find_tip_id_by_content_hash(&self, content_hash: &str) -> Option<String> {
        self.index
            .tips
            .values()
            .find(|tip| tip.content_hash == content_hash)
            .map(|tip| tip.tip.id.clone())
    }

    fn find_preset_id_by_source_uuid(&self, source_uuid: &str) -> Option<String> {
        self.index
            .presets
            .values()
            .find(|preset| preset.preset.source_uuid.as_deref() == Some(source_uuid))
            .map(|preset| preset.preset.id.clone())
    }

    fn find_preset_id_by_content_hash(&self, content_hash: &str) -> Option<String> {
        self.index
            .presets
            .values()
            .find(|preset| preset.content_hash == content_hash)
            .map(|preset| preset.preset.id.clone())
    }

    fn remove_preset_from_groups(&mut self, preset_id: &str) {
        for preset_ids in self.index.groups.values_mut() {
            preset_ids.retain(|id| id != preset_id);
        }
    }

    fn cleanup_groups(&mut self) {
        self.index.groups.retain(|_, ids| !ids.is_empty());
    }

    fn is_tip_referenced(&self, tip_id: &str) -> bool {
        self.index.presets.values().any(|entry| {
            entry.tip_id.as_deref() == Some(tip_id)
                || entry
                    .preset
                    .dual_brush_settings
                    .as_ref()
                    .and_then(|dual| dual.brush_id.as_deref())
                    == Some(tip_id)
        })
    }
}

fn ensure_unique_id<F>(preferred: &str, exists: F) -> String
where
    F: Fn(&str) -> bool,
{
    let trimmed = preferred.trim();
    let base = if trimmed.is_empty() {
        unique_id_token()
    } else {
        trimmed.to_string()
    };

    if !exists(&base) {
        return base;
    }

    let mut suffix: usize = 1;
    loop {
        let candidate = format!("{}-{}", base, suffix);
        if !exists(&candidate) {
            return candidate;
        }
        suffix += 1;
    }
}

fn sanitize_optional_id(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
}

fn hash_tip(tip: &BrushPreset) -> String {
    let mut normalized = tip.clone();
    normalized.id.clear();
    normalized.name.clear();

    hash_serde(&("tip", normalized))
}

fn hash_preset(preset: &BrushPreset, tip_id: Option<&str>) -> String {
    let mut normalized = preset.clone();
    normalized.id.clear();
    normalized.name.clear();

    hash_serde(&("preset", normalized, tip_id))
}

fn hash_serde<T: Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn unique_id_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{:x}{:x}", now.as_secs(), now.subsec_nanos())
}

fn get_library_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_CONFIG_DIR_NAME)
        .join("brushes")
}

pub fn init_library() {
    let library_dir = get_library_dir();
    let mut guard = LIBRARY.write();
    *guard = Some(BrushLibrary::load(library_dir));
    tracing::info!("Brush library initialized");
}

pub fn get_library_snapshot() -> BrushLibrarySnapshot {
    with_library_read(BrushLibrary::snapshot).unwrap_or(BrushLibrarySnapshot {
        presets: Vec::new(),
        tips: Vec::new(),
        groups: Vec::new(),
    })
}

pub fn import_from_abr(
    source_path: &str,
    presets: Vec<BrushPreset>,
    tips: Vec<BrushPreset>,
) -> Result<BrushLibraryImportResult, String> {
    with_library_write(|library| library.import_from_abr(source_path, presets, tips))
}

pub fn rename_preset(id: &str, new_name: String) -> Result<(), String> {
    with_library_write(|library| library.rename_preset(id, new_name))
}

pub fn delete_preset(id: &str) -> Result<(), String> {
    with_library_write(|library| library.delete_preset(id))
}

pub fn move_preset_to_group(id: &str, group: String) -> Result<(), String> {
    with_library_write(|library| library.move_preset_to_group(id, group))
}

pub fn rename_group(old_name: &str, new_name: String) -> Result<(), String> {
    with_library_write(|library| library.rename_group(old_name, new_name))
}

pub fn delete_group(group_name: &str) -> Result<(), String> {
    with_library_write(|library| library.delete_group(group_name))
}

pub fn save_preset(payload: BrushLibraryPresetPayload) -> Result<BrushLibraryPreset, String> {
    with_library_write(|library| library.save_preset(payload))
}

pub fn save_preset_as(
    payload: BrushLibraryPresetPayload,
    new_name: String,
    target_group: Option<String>,
) -> Result<BrushLibraryPreset, String> {
    with_library_write(|library| library.save_preset_as(payload, new_name, target_group))
}

fn with_library_read<T>(f: impl FnOnce(&BrushLibrary) -> T) -> Option<T> {
    let guard = LIBRARY.read();
    guard.as_ref().map(f)
}

fn with_library_write<T>(
    f: impl FnOnce(&mut BrushLibrary) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = LIBRARY.write();
    let library = guard
        .as_mut()
        .ok_or_else(|| "Brush library not initialized".to_string())?;
    f(library)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn make_preset(
        id: &str,
        name: &str,
        source_uuid: Option<&str>,
        has_texture: bool,
    ) -> BrushPreset {
        BrushPreset {
            id: id.to_string(),
            source_uuid: source_uuid.map(|s| s.to_string()),
            name: name.to_string(),
            diameter: 20.0,
            spacing: 25.0,
            hardness: 100.0,
            angle: 0.0,
            roundness: 100.0,
            has_texture,
            is_computed: false,
            texture_width: if has_texture { Some(32) } else { None },
            texture_height: if has_texture { Some(32) } else { None },
            size_pressure: true,
            opacity_pressure: false,
            cursor_path: None,
            cursor_bounds: None,
            texture_settings: None,
            dual_brush_settings: None,
            shape_dynamics_enabled: None,
            shape_dynamics: None,
            scatter_enabled: None,
            scatter: None,
            color_dynamics_enabled: None,
            color_dynamics: None,
            transfer_enabled: None,
            transfer: None,
            wet_edge_enabled: None,
            buildup_enabled: None,
            noise_enabled: None,
            base_opacity: None,
            base_flow: None,
        }
    }

    fn make_library() -> BrushLibrary {
        let dir = std::env::temp_dir().join(format!(
            "{}_brush_library_test_{}",
            crate::app_meta::APP_STORAGE_PREFIX,
            unique_id_token()
        ));
        BrushLibrary::new(dir)
    }

    #[test]
    fn dedup_import_and_group_by_file_name() {
        let mut library = make_library();

        let tip = make_preset("tip-1", "Tip 1", Some("tip-src"), true);
        let mut preset = make_preset("preset-1", "Preset 1", Some("preset-src"), true);
        preset.id = "tip-1".to_string();

        let first = library
            .import_from_abr(
                "C:/brushes/MySet.abr",
                vec![preset.clone()],
                vec![tip.clone()],
            )
            .unwrap();
        assert_eq!(first.imported_preset_count, 1);
        assert_eq!(first.imported_tip_count, 1);

        let second = library
            .import_from_abr("C:/brushes/MySet.abr", vec![preset], vec![tip])
            .unwrap();
        assert_eq!(second.imported_preset_count, 0);
        assert_eq!(second.skipped_preset_count, 1);
        assert_eq!(second.imported_tip_count, 0);
        assert_eq!(second.skipped_tip_count, 1);

        let group_names: Vec<_> = second
            .snapshot
            .groups
            .iter()
            .map(|g| g.name.clone())
            .collect();
        assert!(group_names.contains(&"MySet".to_string()));
    }

    #[test]
    fn save_as_reuses_tip_id() {
        let mut library = make_library();

        let tip = make_preset("tip-a", "Tip A", Some("tip-a-src"), true);
        let mut preset = make_preset("preset-a", "Preset A", Some("preset-a-src"), true);
        preset.id = "tip-a".to_string();

        let imported = library
            .import_from_abr("C:/brushes/A.abr", vec![preset], vec![tip])
            .unwrap();

        let original = imported.snapshot.presets.first().unwrap().clone();
        let payload = BrushLibraryPresetPayload {
            preset: original.preset.clone(),
            tip_id: original.tip_id.clone(),
            group: original.group.clone(),
        };

        let copied = library
            .save_preset_as(payload, "Preset A Copy".to_string(), None)
            .unwrap();

        assert_eq!(copied.tip_id, original.tip_id);
        assert_ne!(copied.preset.id, original.preset.id);
    }

    #[test]
    fn delete_preset_cleans_unreferenced_tip() {
        let mut library = make_library();

        let tip = make_preset("tip-z", "Tip Z", Some("tip-z-src"), true);
        let mut preset = make_preset("preset-z", "Preset Z", Some("preset-z-src"), true);
        preset.id = "tip-z".to_string();

        let imported = library
            .import_from_abr("C:/brushes/Z.abr", vec![preset], vec![tip])
            .unwrap();
        let preset_id = imported.snapshot.presets[0].preset.id.clone();

        library.delete_preset(&preset_id).unwrap();
        let snapshot = library.snapshot();
        assert!(snapshot.presets.is_empty());
        assert!(snapshot.tips.is_empty());
    }

    #[test]
    fn delete_group_removes_group_presets() {
        let mut library = make_library();

        let tip_a = make_preset("tip-a", "Tip A", Some("tip-a-src"), true);
        let mut preset_a = make_preset("preset-a", "Preset A", Some("preset-a-src"), true);
        preset_a.id = "tip-a".to_string();
        let tip_b = make_preset("tip-b", "Tip B", Some("tip-b-src"), true);
        let mut preset_b = make_preset("preset-b", "Preset B", Some("preset-b-src"), true);
        preset_b.id = "tip-b".to_string();

        let _ = library
            .import_from_abr("C:/brushes/GroupA.abr", vec![preset_a], vec![tip_a])
            .unwrap();
        let _ = library
            .import_from_abr("C:/brushes/GroupB.abr", vec![preset_b], vec![tip_b])
            .unwrap();

        library.delete_group("GroupA").unwrap();
        let snapshot = library.snapshot();

        assert!(snapshot.groups.iter().all(|group| group.name != "GroupA"));
        assert!(snapshot
            .presets
            .iter()
            .all(|preset| preset.group.as_deref() != Some("GroupA")));
        assert!(snapshot
            .presets
            .iter()
            .any(|preset| preset.group.as_deref() == Some("GroupB")));
    }
}
