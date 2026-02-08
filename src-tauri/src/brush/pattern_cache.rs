//! Pattern texture cache for custom protocol serving
//!
//! This module provides a global cache for pattern texture data that can be
//! served via the `project://` custom protocol, eliminating Base64 overhead
//! and enabling direct binary transfer with LZ4 compression.
//!
//! ## Two-level caching strategy
//! 1. **Memory cache**: Fast access for current session
//! 2. **Disk cache**: Persistent storage across sessions

use lz4_flex::{compress_prepend_size, decompress_size_prepended};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Cached pattern texture data
#[derive(Debug, Clone)]
pub struct CachedPattern {
    /// LZ4 compressed RGBA data (with prepended size)
    pub data: Vec<u8>,
    /// Original image width
    pub width: u32,
    /// Original image height
    pub height: u32,
    /// Pattern name for display
    pub name: String,
    /// Pattern mode (e.g. "RGB", "Grayscale")
    pub mode: String,
}

/// Global pattern cache
static PATTERN_CACHE: RwLock<Option<PatternCache>> = RwLock::new(None);

/// Pattern texture cache for serving via custom protocol
#[derive(Debug, Default)]
pub struct PatternCache {
    /// Map of pattern_id -> cached texture data
    patterns: HashMap<String, CachedPattern>,
    /// Map of pattern_id -> (thumb_size -> cached thumbnail)
    thumbs: HashMap<String, HashMap<u32, CachedPattern>>,
}

impl PatternCache {
    /// Create a new empty cache
    pub fn new() -> Self {
        Self {
            patterns: HashMap::new(),
            thumbs: HashMap::new(),
        }
    }

    /// Insert a compressed pattern directly
    pub fn insert_compressed(&mut self, pattern_id: String, pattern: CachedPattern) {
        self.patterns.insert(pattern_id, pattern);
    }

    /// Insert a compressed thumbnail directly
    pub fn insert_thumb_compressed(&mut self, pattern_id: String, size: u32, thumb: CachedPattern) {
        self.thumbs
            .entry(pattern_id)
            .or_default()
            .insert(size, thumb);
    }

    /// Store a pattern's RGBA texture data with LZ4 compression
    pub fn store_pattern_rgba(
        &mut self,
        pattern_id: String,
        data: Vec<u8>,
        width: u32,
        height: u32,
        name: String,
        mode: String,
    ) {
        // LZ4 compress
        let compressed = compress_prepend_size(&data);
        tracing::trace!(
            "Pattern {} ({}): {} -> {} bytes ({:.1}% of original)",
            pattern_id,
            mode,
            data.len(),
            compressed.len(),
            compressed.len() as f64 / data.len().max(1) as f64 * 100.0
        );

        self.insert_compressed(
            pattern_id,
            CachedPattern {
                data: compressed,
                width,
                height,
                name,
                mode,
            },
        );
    }

    /// Get a pattern's cached data
    pub fn get_pattern(&self, pattern_id: &str) -> Option<&CachedPattern> {
        self.patterns.get(pattern_id)
    }

    /// Get a pattern thumbnail's cached data
    pub fn get_thumb(&self, pattern_id: &str, size: u32) -> Option<&CachedPattern> {
        self.thumbs.get(pattern_id).and_then(|m| m.get(&size))
    }

    /// Insert a pattern directly (for loading from disk)
    pub fn insert(&mut self, pattern_id: String, pattern: CachedPattern) {
        self.patterns.insert(pattern_id, pattern);
    }

    /// Insert a thumbnail directly (for loading from disk)
    pub fn insert_thumb(&mut self, pattern_id: String, size: u32, thumb: CachedPattern) {
        self.thumbs
            .entry(pattern_id)
            .or_default()
            .insert(size, thumb);
    }

    /// Clear all cached data
    pub fn clear(&mut self) {
        self.patterns.clear();
        self.thumbs.clear();
    }

    /// Get number of cached patterns
    pub fn len(&self) -> usize {
        self.patterns.len()
    }

    /// Check if cache is empty
    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }

    /// Get total compressed size
    pub fn total_size(&self) -> usize {
        self.patterns.values().map(|p| p.data.len()).sum()
    }

    /// Remove a full pattern + all thumbnails
    pub fn remove_pattern_and_thumbs(&mut self, pattern_id: &str) {
        self.patterns.remove(pattern_id);
        self.thumbs.remove(pattern_id);
    }
}

// === Disk persistence ===

const THUMB_SIZES: [u32; 3] = [32, 48, 80];

fn normalize_thumb_size(size: u32) -> u32 {
    let clamped = size.clamp(16, 256);
    let mut best = THUMB_SIZES[0];
    let mut best_diff = best.abs_diff(clamped);
    for &s in &THUMB_SIZES[1..] {
        let diff = s.abs_diff(clamped);
        if diff < best_diff || (diff == best_diff && s > best) {
            best = s;
            best_diff = diff;
        }
    }
    best
}

fn render_square_thumbnail_rgba(src_rgba: &[u8], src_w: u32, src_h: u32, size: u32) -> Vec<u8> {
    let size_usize = size as usize;
    let mut out = vec![0u8; size_usize * size_usize * 4];

    if src_w == 0 || src_h == 0 || size == 0 {
        return out;
    }

    let scale_w = size as f64 / src_w as f64;
    let scale_h = size as f64 / src_h as f64;
    let scale = scale_w.min(scale_h);

    let new_w = ((src_w as f64) * scale).round().max(1.0) as u32;
    let new_h = ((src_h as f64) * scale).round().max(1.0) as u32;

    let off_x = (size - new_w) / 2;
    let off_y = (size - new_h) / 2;

    for y in 0..new_h {
        let src_y = (y as u64 * src_h as u64 / new_h as u64) as u32;
        for x in 0..new_w {
            let src_x = (x as u64 * src_w as u64 / new_w as u64) as u32;

            let src_i = ((src_y as usize) * (src_w as usize) + (src_x as usize)) * 4;
            let dst_x = x + off_x;
            let dst_y = y + off_y;
            let dst_i = ((dst_y as usize) * size_usize + (dst_x as usize)) * 4;

            if src_i + 3 < src_rgba.len() && dst_i + 3 < out.len() {
                out[dst_i..dst_i + 4].copy_from_slice(&src_rgba[src_i..src_i + 4]);
            }
        }
    }

    out
}

/// Get the pattern cache directory path
fn get_pattern_cache_dir() -> PathBuf {
    std::env::var("PAINTBOARD_TEST_DATA_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.paintboard")
        .join("pattern_cache")
}

fn get_pattern_cache_thumb_dir(size: u32) -> PathBuf {
    get_pattern_cache_dir().join(format!("thumb_{}", size))
}

/// Ensure cache directory exists
pub fn ensure_cache_dir() {
    let dir = get_pattern_cache_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!("Failed to create pattern cache dir {:?}: {}", dir, e);
    } else {
        tracing::debug!("Pattern cache dir ready: {:?}", dir);
    }
}

/// Save pattern to disk
/// Format:
/// - width (4 bytes)
/// - height (4 bytes)
/// - name_len (4 bytes)
/// - name_bytes (variable)
/// - mode_len (4 bytes)
/// - mode_bytes (variable)
/// - compressed_data (rest)
fn save_pattern_to_disk_in_dir(dir: &Path, pattern_id: &str, pattern: &CachedPattern) {
    let file_path = dir.join(format!("{}.bin", pattern_id));

    let result = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;

        let mut file = std::fs::File::create(&file_path)?;
        let name_bytes = pattern.name.as_bytes();
        let mode_bytes = pattern.mode.as_bytes();

        // Write header
        file.write_all(&pattern.width.to_le_bytes())?;
        file.write_all(&pattern.height.to_le_bytes())?;

        file.write_all(&(name_bytes.len() as u32).to_le_bytes())?;
        file.write_all(name_bytes)?;

        file.write_all(&(mode_bytes.len() as u32).to_le_bytes())?;
        file.write_all(mode_bytes)?;

        // Write compressed data
        file.write_all(&pattern.data)?;

        Ok(())
    })();

    match result {
        Ok(()) => tracing::trace!("Pattern {} saved to disk: {:?}", pattern_id, file_path),
        Err(e) => tracing::warn!("Failed to save pattern {} to disk: {}", pattern_id, e),
    }
}

/// Load pattern from disk
fn load_pattern_from_disk_in_dir(dir: &Path, pattern_id: &str) -> Option<CachedPattern> {
    let file_path = dir.join(format!("{}.bin", pattern_id));

    if !file_path.exists() {
        return None;
    }

    let result = (|| -> std::io::Result<CachedPattern> {
        let mut file = std::fs::File::open(&file_path)?;

        // Read fixed header
        let mut width_buf = [0u8; 4];
        let mut height_buf = [0u8; 4];
        let mut len_buf = [0u8; 4];

        file.read_exact(&mut width_buf)?;
        file.read_exact(&mut height_buf)?;

        let width = u32::from_le_bytes(width_buf);
        let height = u32::from_le_bytes(height_buf);

        // Read Name
        file.read_exact(&mut len_buf)?;
        let name_len = u32::from_le_bytes(len_buf) as usize;
        let mut name_bytes = vec![0u8; name_len];
        file.read_exact(&mut name_bytes)?;
        let name = String::from_utf8_lossy(&name_bytes).to_string();

        // Read Mode
        file.read_exact(&mut len_buf)?;
        let mode_len = u32::from_le_bytes(len_buf) as usize;
        let mut mode_bytes = vec![0u8; mode_len];
        file.read_exact(&mut mode_bytes)?;
        let mode = String::from_utf8_lossy(&mode_bytes).to_string();

        // Read compressed data
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;

        Ok(CachedPattern {
            data,
            width,
            height,
            name,
            mode,
        })
    })();

    match result {
        Ok(pattern) => {
            tracing::trace!("Pattern {} loaded from disk: {:?}", pattern_id, file_path);
            Some(pattern)
        }
        Err(e) => {
            tracing::warn!("Failed to load pattern {} from disk: {}", pattern_id, e);
            None
        }
    }
}

fn save_pattern_to_disk(pattern_id: &str, pattern: &CachedPattern) {
    let dir = get_pattern_cache_dir();
    save_pattern_to_disk_in_dir(&dir, pattern_id, pattern);
}

fn load_pattern_from_disk(pattern_id: &str) -> Option<CachedPattern> {
    let dir = get_pattern_cache_dir();
    load_pattern_from_disk_in_dir(&dir, pattern_id)
}

fn save_thumb_to_disk(pattern_id: &str, size: u32, thumb: &CachedPattern) {
    let dir = get_pattern_cache_thumb_dir(size);
    save_pattern_to_disk_in_dir(&dir, pattern_id, thumb);
}

fn load_thumb_from_disk(pattern_id: &str, size: u32) -> Option<CachedPattern> {
    let dir = get_pattern_cache_thumb_dir(size);
    load_pattern_from_disk_in_dir(&dir, pattern_id)
}

// === Global cache operations ===

/// Initialize the global pattern cache
pub fn init_pattern_cache() {
    ensure_cache_dir();
    let mut cache = PATTERN_CACHE.write();
    *cache = Some(PatternCache::new());
    tracing::debug!("Pattern cache initialized");
}

/// Clear the global pattern cache
pub fn clear_pattern_cache() {
    let mut guard = PATTERN_CACHE.write();
    match guard.as_mut() {
        Some(cache) => {
            tracing::debug!("Clearing {} cached patterns", cache.len());
            cache.clear();
        }
        None => {
            tracing::debug!("Pattern cache was None, reinitializing");
            *guard = Some(PatternCache::new());
        }
    }
}

/// Store pattern RGBA data with LZ4 compression in global cache AND disk
pub fn cache_pattern_rgba(
    pattern_id: String,
    data: Vec<u8>,
    width: u32,
    height: u32,
    name: String,
    mode: String,
) {
    // LZ4 compress
    let compressed = compress_prepend_size(&data);
    tracing::trace!(
        "Pattern {} ({}): {} -> {} bytes ({:.1}% of original)",
        pattern_id,
        mode,
        data.len(),
        compressed.len(),
        compressed.len() as f64 / data.len().max(1) as f64 * 100.0
    );

    let pattern = CachedPattern {
        data: compressed,
        width,
        height,
        name,
        mode,
    };

    // Save to disk first (persistent)
    save_pattern_to_disk(&pattern_id, &pattern);

    // Generate and save thumbnails (persistent)
    let mut thumbs = Vec::new();
    for &thumb_size in &THUMB_SIZES {
        let thumb_rgba = render_square_thumbnail_rgba(&data, width, height, thumb_size);
        let thumb = CachedPattern {
            data: compress_prepend_size(&thumb_rgba),
            width: thumb_size,
            height: thumb_size,
            name: String::new(),
            mode: String::new(),
        };
        save_thumb_to_disk(&pattern_id, thumb_size, &thumb);
        thumbs.push((thumb_size, thumb));
    }

    // Store in memory cache
    let mut guard = PATTERN_CACHE.write();
    let cache = guard.get_or_insert_with(PatternCache::new);
    for (thumb_size, thumb) in thumbs {
        cache.insert_thumb_compressed(pattern_id.clone(), thumb_size, thumb);
    }
    cache.insert_compressed(pattern_id, pattern);
}

/// Get pattern data from global cache (with disk fallback)
pub fn get_cached_pattern(pattern_id: &str) -> Option<CachedPattern> {
    // Try memory cache first
    {
        let guard = PATTERN_CACHE.read();
        if let Some(cache) = guard.as_ref() {
            if let Some(pattern) = cache.get_pattern(pattern_id) {
                return Some(pattern.clone());
            }
        }
    }

    // Memory miss - try disk
    tracing::trace!("Pattern {} not in memory, trying disk...", pattern_id);
    if let Some(pattern) = load_pattern_from_disk(pattern_id) {
        // Store back to memory for faster future access
        let mut guard = PATTERN_CACHE.write();
        let cache = guard.get_or_insert_with(PatternCache::new);
        cache.insert(pattern_id.to_string(), pattern.clone());
        return Some(pattern);
    }

    None
}

/// Get a square thumbnail (size will be normalized to a supported bucket)
pub fn get_cached_pattern_thumb(pattern_id: &str, requested_size: u32) -> Option<CachedPattern> {
    let size = normalize_thumb_size(requested_size);

    // Try memory cache first
    {
        let guard = PATTERN_CACHE.read();
        if let Some(cache) = guard.as_ref() {
            if let Some(thumb) = cache.get_thumb(pattern_id, size) {
                return Some(thumb.clone());
            }
        }
    }

    // Try disk thumbnail
    if let Some(thumb) = load_thumb_from_disk(pattern_id, size) {
        let mut guard = PATTERN_CACHE.write();
        let cache = guard.get_or_insert_with(PatternCache::new);
        cache.insert_thumb(pattern_id.to_string(), size, thumb.clone());
        return Some(thumb);
    }

    // Thumb missing: fall back to full pattern (disk/memory), generate, persist, return
    let full = get_cached_pattern(pattern_id)?;
    let rgba = match decompress_size_prepended(&full.data) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                "Failed to decompress pattern {} for thumb: {}",
                pattern_id,
                e
            );
            return None;
        }
    };

    let thumb_rgba = render_square_thumbnail_rgba(&rgba, full.width, full.height, size);
    let thumb = CachedPattern {
        data: compress_prepend_size(&thumb_rgba),
        width: size,
        height: size,
        name: String::new(),
        mode: String::new(),
    };

    save_thumb_to_disk(pattern_id, size, &thumb);

    let mut guard = PATTERN_CACHE.write();
    let cache = guard.get_or_insert_with(PatternCache::new);
    cache.insert_thumb(pattern_id.to_string(), size, thumb.clone());

    Some(thumb)
}

/// Delete cached files and in-memory entries for a pattern (full + thumbnails)
pub fn delete_cached_pattern(pattern_id: &str) {
    // Remove from memory first
    {
        let mut guard = PATTERN_CACHE.write();
        if let Some(cache) = guard.as_mut() {
            cache.remove_pattern_and_thumbs(pattern_id);
        }
    }

    // Remove disk files (best-effort)
    let full_path = get_pattern_cache_dir().join(format!("{}.bin", pattern_id));
    let _ = std::fs::remove_file(&full_path);
    for &size in &THUMB_SIZES {
        let p = get_pattern_cache_thumb_dir(size).join(format!("{}.bin", pattern_id));
        let _ = std::fs::remove_file(&p);
    }
}

/// Get cache statistics
pub fn get_pattern_cache_stats() -> (usize, usize) {
    let guard = PATTERN_CACHE.read();
    guard
        .as_ref()
        .map(|cache| (cache.len(), cache.total_size()))
        .unwrap_or((0, 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn thumbnail_renderer_aspect_fit_and_padding() {
        // 2x1 source: [Red, Green]
        let src_w = 2;
        let src_h = 1;
        let src = vec![
            255, 0, 0, 255, // red
            0, 255, 0, 255, // green
        ];

        let out = render_square_thumbnail_rgba(&src, src_w, src_h, 4);
        assert_eq!(out.len(), 4 * 4 * 4);

        // Top row should be transparent due to vertical padding (new_h=2, off_y=1)
        assert_eq!(&out[0..4], &[0, 0, 0, 0]);

        // Row 1, col 0..1 should sample red; col 2..3 should sample green
        let row1 = 1usize;
        let px = |x: usize, y: usize| {
            let i = (y * 4 + x) * 4;
            [out[i], out[i + 1], out[i + 2], out[i + 3]]
        };
        assert_eq!(px(0, row1), [255, 0, 0, 255]);
        assert_eq!(px(1, row1), [255, 0, 0, 255]);
        assert_eq!(px(2, row1), [0, 255, 0, 255]);
        assert_eq!(px(3, row1), [0, 255, 0, 255]);
    }

    #[test]
    fn thumb_disk_fallback_and_memory_hit() {
        let _guard = TEST_LOCK.lock().expect("failed to lock test mutex");

        let uniq = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before UNIX_EPOCH")
            .as_nanos();
        let base = std::env::temp_dir().join(format!("paintboard_pattern_cache_test_{}", uniq));
        std::fs::create_dir_all(&base).expect("failed to create test dir");
        std::env::set_var("PAINTBOARD_TEST_DATA_DIR", &base);

        init_pattern_cache();

        let pattern_id = "p1".to_string();
        let rgba = vec![
            255, 0, 0, 255, 0, 255, 0, 255, // row 0
            0, 0, 255, 255, 255, 255, 255, 255, // row 1
        ];
        cache_pattern_rgba(pattern_id.clone(), rgba, 2, 2, "n".into(), "RGB".into());

        // Remove thumb file to force fallback generation on first request
        let size = normalize_thumb_size(80);
        let thumb_path = get_pattern_cache_thumb_dir(size).join(format!("{}.bin", pattern_id));
        let _ = std::fs::remove_file(&thumb_path);

        clear_pattern_cache(); // clear memory to ensure we won't hit in-memory thumb

        let t1 = get_cached_pattern_thumb(&pattern_id, 80).expect("thumb should be generated");
        assert_eq!(t1.width, size);
        assert!(
            thumb_path.exists(),
            "thumb file should be re-created on disk"
        );

        // Delete thumb file again; second request should hit memory and NOT recreate file.
        std::fs::remove_file(&thumb_path).expect("failed to remove thumb file");
        let _t2 = get_cached_pattern_thumb(&pattern_id, 80).expect("thumb should hit memory");
        assert!(
            !thumb_path.exists(),
            "memory hit should not re-write thumb file"
        );

        std::env::remove_var("PAINTBOARD_TEST_DATA_DIR");
        let _ = std::fs::remove_dir_all(&base);
    }
}
