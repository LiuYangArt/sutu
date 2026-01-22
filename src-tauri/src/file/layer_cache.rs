//! Layer image cache for custom protocol serving
//!
//! This module provides a global cache for layer image data that can be
//! served via the `project://` custom protocol, eliminating Base64 overhead
//! and enabling browser-native image decoding.

use parking_lot::RwLock;
use std::collections::HashMap;

/// Cached layer image data
#[derive(Debug, Clone)]
pub struct CachedLayer {
    /// Raw image bytes (PNG or WebP format)
    pub data: Vec<u8>,
    /// MIME type for Content-Type header
    pub mime_type: &'static str,
}

/// Global layer cache (using parking_lot::RwLock which doesn't poison)
static LAYER_CACHE: RwLock<Option<LayerCache>> = RwLock::new(None);

/// Layer image cache for serving via custom protocol
#[derive(Debug, Default)]
pub struct LayerCache {
    /// Map of layer_id -> cached image data
    layers: HashMap<String, CachedLayer>,
    /// Project thumbnail
    thumbnail: Option<CachedLayer>,
}

impl LayerCache {
    /// Create a new empty cache
    pub fn new() -> Self {
        Self {
            layers: HashMap::new(),
            thumbnail: None,
        }
    }

    /// Store a layer's image data (PNG format)
    pub fn store_layer_png(&mut self, layer_id: String, data: Vec<u8>) {
        self.layers.insert(
            layer_id,
            CachedLayer {
                data,
                mime_type: "image/png",
            },
        );
    }

    /// Store a layer's image data (WebP format)
    pub fn store_layer_webp(&mut self, layer_id: String, data: Vec<u8>) {
        self.layers.insert(
            layer_id,
            CachedLayer {
                data,
                mime_type: "image/webp",
            },
        );
    }

    /// Store thumbnail
    pub fn store_thumbnail(&mut self, data: Vec<u8>, mime_type: &'static str) {
        self.thumbnail = Some(CachedLayer { data, mime_type });
    }

    /// Get a layer's cached data
    pub fn get_layer(&self, layer_id: &str) -> Option<&CachedLayer> {
        self.layers.get(layer_id)
    }

    /// Get thumbnail
    pub fn get_thumbnail(&self) -> Option<&CachedLayer> {
        self.thumbnail.as_ref()
    }

    /// Clear all cached data
    pub fn clear(&mut self) {
        self.layers.clear();
        self.thumbnail = None;
    }

    /// Get number of cached layers
    pub fn len(&self) -> usize {
        self.layers.len()
    }

    /// Check if cache is empty
    pub fn is_empty(&self) -> bool {
        self.layers.is_empty()
    }
}

// === Global cache operations ===

/// Initialize the global layer cache
pub fn init_cache() {
    let mut cache = LAYER_CACHE.write();
    *cache = Some(LayerCache::new());
    tracing::debug!("Layer cache initialized");
}

/// Clear the global cache (and reinitialize if needed)
pub fn clear_cache() {
    let mut guard = LAYER_CACHE.write();
    match guard.as_mut() {
        Some(cache) => {
            tracing::debug!("Clearing {} cached layers", cache.len());
            cache.clear();
        }
        None => {
            tracing::debug!("Cache was None, reinitializing");
            *guard = Some(LayerCache::new());
        }
    }
}

/// Store layer PNG data in global cache
pub fn cache_layer_png(layer_id: String, data: Vec<u8>) {
    let mut guard = LAYER_CACHE.write();
    if guard.is_none() {
        *guard = Some(LayerCache::new());
    }
    if let Some(cache) = guard.as_mut() {
        cache.store_layer_png(layer_id, data);
    }
}

/// Store layer WebP data in global cache
pub fn cache_layer_webp(layer_id: String, data: Vec<u8>) {
    let mut guard = LAYER_CACHE.write();
    if guard.is_none() {
        *guard = Some(LayerCache::new());
    }
    if let Some(cache) = guard.as_mut() {
        cache.store_layer_webp(layer_id, data);
    }
}

/// Store thumbnail in global cache
pub fn cache_thumbnail(data: Vec<u8>, mime_type: &'static str) {
    let mut guard = LAYER_CACHE.write();
    if guard.is_none() {
        *guard = Some(LayerCache::new());
    }
    if let Some(cache) = guard.as_mut() {
        cache.store_thumbnail(data, mime_type);
    }
}

/// Get layer data from global cache
pub fn get_cached_layer(layer_id: &str) -> Option<CachedLayer> {
    let guard = LAYER_CACHE.read();
    guard
        .as_ref()
        .and_then(|cache| cache.get_layer(layer_id).cloned())
}

/// Get thumbnail from global cache
pub fn get_cached_thumbnail() -> Option<CachedLayer> {
    let guard = LAYER_CACHE.read();
    guard
        .as_ref()
        .and_then(|cache| cache.get_thumbnail().cloned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_layer_cache() {
        let mut cache = LayerCache::new();

        // Store PNG layer
        cache.store_layer_png("layer1".to_string(), vec![0x89, 0x50, 0x4E, 0x47]);
        assert_eq!(cache.len(), 1);

        // Retrieve layer
        let layer = cache.get_layer("layer1").unwrap();
        assert_eq!(layer.mime_type, "image/png");
        assert_eq!(layer.data, vec![0x89, 0x50, 0x4E, 0x47]);

        // Store WebP layer
        cache.store_layer_webp("layer2".to_string(), vec![0x52, 0x49, 0x46, 0x46]);
        let layer2 = cache.get_layer("layer2").unwrap();
        assert_eq!(layer2.mime_type, "image/webp");

        // Clear
        cache.clear();
        assert!(cache.is_empty());
    }
}
