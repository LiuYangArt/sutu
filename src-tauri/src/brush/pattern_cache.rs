//! Pattern texture cache for custom protocol serving
//!
//! This module provides a global cache for pattern texture data that can be
//! served via the `project://` custom protocol, eliminating Base64 overhead
//! and enabling direct binary transfer with LZ4 compression.
//!
//! ## Two-level caching strategy
//! 1. **Memory cache**: Fast access for current session
//! 2. **Disk cache**: Persistent storage across sessions

use lz4_flex::compress_prepend_size;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;

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
}

impl PatternCache {
    /// Create a new empty cache
    pub fn new() -> Self {
        Self {
            patterns: HashMap::new(),
        }
    }

    /// Insert a compressed pattern directly
    pub fn insert_compressed(&mut self, pattern_id: String, pattern: CachedPattern) {
        self.patterns.insert(pattern_id, pattern);
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
        tracing::debug!(
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

    /// Insert a pattern directly (for loading from disk)
    pub fn insert(&mut self, pattern_id: String, pattern: CachedPattern) {
        self.patterns.insert(pattern_id, pattern);
    }

    /// Clear all cached data
    pub fn clear(&mut self) {
        self.patterns.clear();
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
}

// === Disk persistence ===

/// Get the pattern cache directory path
fn get_pattern_cache_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.paintboard")
        .join("pattern_cache")
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
fn save_pattern_to_disk(pattern_id: &str, pattern: &CachedPattern) {
    let dir = get_pattern_cache_dir();
    let file_path = dir.join(format!("{}.bin", pattern_id));

    let result = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;

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
        Ok(()) => tracing::debug!("Pattern {} saved to disk: {:?}", pattern_id, file_path),
        Err(e) => tracing::warn!("Failed to save pattern {} to disk: {}", pattern_id, e),
    }
}

/// Load pattern from disk
fn load_pattern_from_disk(pattern_id: &str) -> Option<CachedPattern> {
    let file_path = get_pattern_cache_dir().join(format!("{}.bin", pattern_id));

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
            tracing::debug!("Pattern {} loaded from disk: {:?}", pattern_id, file_path);
            Some(pattern)
        }
        Err(e) => {
            tracing::warn!("Failed to load pattern {} from disk: {}", pattern_id, e);
            None
        }
    }
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
    tracing::debug!(
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

    // Then store in memory cache
    let mut guard = PATTERN_CACHE.write();
    if guard.is_none() {
        *guard = Some(PatternCache::new());
    }
    if let Some(cache) = guard.as_mut() {
        cache.insert_compressed(pattern_id, pattern);
    }
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
    tracing::debug!("Pattern {} not in memory, trying disk...", pattern_id);
    if let Some(pattern) = load_pattern_from_disk(pattern_id) {
        // Store back to memory for faster future access
        let mut guard = PATTERN_CACHE.write();
        if guard.is_none() {
            *guard = Some(PatternCache::new());
        }
        if let Some(cache) = guard.as_mut() {
            cache.insert(pattern_id.to_string(), pattern.clone());
        }
        return Some(pattern);
    }

    None
}

/// Get cache statistics
pub fn get_pattern_cache_stats() -> (usize, usize) {
    let guard = PATTERN_CACHE.read();
    guard
        .as_ref()
        .map(|cache| (cache.len(), cache.total_size()))
        .unwrap_or((0, 0))
}
