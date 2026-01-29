//! Brush texture cache for custom protocol serving
//!
//! This module provides a global cache for brush texture data that can be
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

/// Cached brush texture data
#[derive(Debug, Clone)]
pub struct CachedBrush {
    /// LZ4 compressed Gray8 data (with prepended size)
    pub data: Vec<u8>,
    /// Original image width
    pub width: u32,
    /// Original image height
    pub height: u32,
    /// Brush name for display
    pub name: String,
}

/// Global brush cache (using parking_lot::RwLock which doesn't poison)
static BRUSH_CACHE: RwLock<Option<BrushCache>> = RwLock::new(None);

/// Brush texture cache for serving via custom protocol
#[derive(Debug, Default)]
pub struct BrushCache {
    /// Map of brush_id -> cached texture data
    brushes: HashMap<String, CachedBrush>,
}

impl BrushCache {
    /// Create a new empty cache
    pub fn new() -> Self {
        Self {
            brushes: HashMap::new(),
        }
    }

    /// Insert a compressed brush directly (for internal use)
    pub fn insert_compressed(&mut self, brush_id: String, brush: CachedBrush) {
        self.brushes.insert(brush_id, brush);
    }

    /// Store a brush's Gray8 texture data with LZ4 compression
    pub fn store_brush_gray(
        &mut self,
        brush_id: String,
        data: Vec<u8>,
        width: u32,
        height: u32,
        name: String,
    ) {
        // LZ4 compress with prepended size for easy decompression
        let compressed = compress_prepend_size(&data);
        tracing::debug!(
            "Brush {} Gray8: {} -> {} bytes ({:.1}% of original)",
            brush_id,
            data.len(),
            compressed.len(),
            compressed.len() as f64 / data.len().max(1) as f64 * 100.0
        );

        self.insert_compressed(
            brush_id,
            CachedBrush {
                data: compressed,
                width,
                height,
                name,
            },
        );
    }

    /// Get a brush's cached data
    pub fn get_brush(&self, brush_id: &str) -> Option<&CachedBrush> {
        self.brushes.get(brush_id)
    }

    /// Insert a brush directly (for loading from disk)
    pub fn insert(&mut self, brush_id: String, brush: CachedBrush) {
        self.brushes.insert(brush_id, brush);
    }

    /// Clear all cached data
    pub fn clear(&mut self) {
        self.brushes.clear();
    }

    /// Get number of cached brushes
    pub fn len(&self) -> usize {
        self.brushes.len()
    }

    /// Check if cache is empty
    pub fn is_empty(&self) -> bool {
        self.brushes.is_empty()
    }

    /// Get total compressed size of all cached brushes
    pub fn total_size(&self) -> usize {
        self.brushes.values().map(|b| b.data.len()).sum()
    }
}

// === Disk persistence ===

/// Get the brush cache directory path
fn get_brush_cache_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.paintboard")
        .join("brush_cache")
}

/// Ensure cache directory exists
pub fn ensure_cache_dir() {
    let dir = get_brush_cache_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!("Failed to create brush cache dir {:?}: {}", dir, e);
    } else {
        tracing::debug!("Brush cache dir ready: {:?}", dir);
    }
}

/// Save brush to disk
/// Format: width(4) + height(4) + name_len(4) + name_bytes + compressed_data
fn save_brush_to_disk(brush_id: &str, brush: &CachedBrush) {
    let dir = get_brush_cache_dir();
    let file_path = dir.join(format!("{}.bin", brush_id));

    let result = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;

        let mut file = std::fs::File::create(&file_path)?;
        let name_bytes = brush.name.as_bytes();

        // Write header
        file.write_all(&brush.width.to_le_bytes())?;
        file.write_all(&brush.height.to_le_bytes())?;
        file.write_all(&(name_bytes.len() as u32).to_le_bytes())?;
        file.write_all(name_bytes)?;
        // Write compressed data
        file.write_all(&brush.data)?;

        Ok(())
    })();

    match result {
        Ok(()) => tracing::debug!("Brush {} saved to disk: {:?}", brush_id, file_path),
        Err(e) => tracing::warn!("Failed to save brush {} to disk: {}", brush_id, e),
    }
}

/// Load brush from disk
fn load_brush_from_disk(brush_id: &str) -> Option<CachedBrush> {
    let file_path = get_brush_cache_dir().join(format!("{}.bin", brush_id));

    if !file_path.exists() {
        return None;
    }

    let result = (|| -> std::io::Result<CachedBrush> {
        let mut file = std::fs::File::open(&file_path)?;

        // Read header
        let mut width_buf = [0u8; 4];
        let mut height_buf = [0u8; 4];
        let mut name_len_buf = [0u8; 4];

        file.read_exact(&mut width_buf)?;
        file.read_exact(&mut height_buf)?;
        file.read_exact(&mut name_len_buf)?;

        let width = u32::from_le_bytes(width_buf);
        let height = u32::from_le_bytes(height_buf);
        let name_len = u32::from_le_bytes(name_len_buf) as usize;

        // Read name
        let mut name_bytes = vec![0u8; name_len];
        file.read_exact(&mut name_bytes)?;
        let name = String::from_utf8_lossy(&name_bytes).to_string();

        // Read compressed data
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;

        Ok(CachedBrush {
            data,
            width,
            height,
            name,
        })
    })();

    match result {
        Ok(brush) => {
            tracing::debug!("Brush {} loaded from disk: {:?}", brush_id, file_path);
            Some(brush)
        }
        Err(e) => {
            tracing::warn!("Failed to load brush {} from disk: {}", brush_id, e);
            None
        }
    }
}

// === Global cache operations ===

/// Initialize the global brush cache
pub fn init_brush_cache() {
    ensure_cache_dir();
    let mut cache = BRUSH_CACHE.write();
    *cache = Some(BrushCache::new());
    tracing::debug!("Brush cache initialized");
}

/// Clear the global brush cache
pub fn clear_brush_cache() {
    let mut guard = BRUSH_CACHE.write();
    match guard.as_mut() {
        Some(cache) => {
            tracing::debug!("Clearing {} cached brushes", cache.len());
            cache.clear();
        }
        None => {
            tracing::debug!("Brush cache was None, reinitializing");
            *guard = Some(BrushCache::new());
        }
    }
}

/// Store brush Gray8 data with LZ4 compression in global cache AND disk
pub fn cache_brush_gray(brush_id: String, data: Vec<u8>, width: u32, height: u32, name: String) {
    // LZ4 compress
    let compressed = compress_prepend_size(&data);
    tracing::debug!(
        "Brush {} Gray8: {} -> {} bytes ({:.1}% of original)",
        brush_id,
        data.len(),
        compressed.len(),
        compressed.len() as f64 / data.len().max(1) as f64 * 100.0
    );

    let brush = CachedBrush {
        data: compressed,
        width,
        height,
        name,
    };

    // Save to disk first (persistent)
    save_brush_to_disk(&brush_id, &brush);

    // Then store in memory cache
    let mut guard = BRUSH_CACHE.write();
    if guard.is_none() {
        *guard = Some(BrushCache::new());
    }
    if let Some(cache) = guard.as_mut() {
        cache.insert_compressed(brush_id, brush);
    }
}

/// Get brush data from global cache (with disk fallback)
pub fn get_cached_brush(brush_id: &str) -> Option<CachedBrush> {
    // Try memory cache first
    {
        let guard = BRUSH_CACHE.read();
        if let Some(cache) = guard.as_ref() {
            if let Some(brush) = cache.get_brush(brush_id) {
                return Some(brush.clone());
            }
        }
    }

    // Memory miss - try disk
    tracing::debug!("Brush {} not in memory, trying disk...", brush_id);
    if let Some(brush) = load_brush_from_disk(brush_id) {
        // Store back to memory for faster future access
        let mut guard = BRUSH_CACHE.write();
        if guard.is_none() {
            *guard = Some(BrushCache::new());
        }
        if let Some(cache) = guard.as_mut() {
            cache.insert(brush_id.to_string(), brush.clone());
        }
        return Some(brush);
    }

    None
}

/// Get cache statistics
pub fn get_brush_cache_stats() -> (usize, usize) {
    let guard = BRUSH_CACHE.read();
    guard
        .as_ref()
        .map(|cache| (cache.len(), cache.total_size()))
        .unwrap_or((0, 0))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_brush_cache() {
        let mut cache = BrushCache::new();

        // Store a simple gray brush
        let gray_data = vec![128u8; 64 * 64]; // 64x64 gray image
        cache.store_brush_gray(
            "test-brush".to_string(),
            gray_data,
            64,
            64,
            "Test Brush".to_string(),
        );
        assert_eq!(cache.len(), 1);

        // Retrieve brush
        let brush = cache.get_brush("test-brush").unwrap();
        assert_eq!(brush.width, 64);
        assert_eq!(brush.height, 64);
        assert_eq!(brush.name, "Test Brush");
        // Data should be compressed (smaller than original for uniform data)
        assert!(brush.data.len() < 64 * 64);

        // Clear
        cache.clear();
        assert!(cache.is_empty());
    }
}
