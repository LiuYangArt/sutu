//! File format support module
//!
//! Provides save/load functionality for:
//! - OpenRaster (.ora) - Primary project format with full layer support
//! - TIFF (.tiff) - Compatibility format with embedded layer data (disabled)
//! - PSD (.psd) - Adobe Photoshop format for interoperability

pub mod layer_cache;
pub mod ora;
pub mod psd;
pub mod tiff;
pub mod types;

pub use layer_cache::{
    cache_layer_png, cache_layer_webp, cache_thumbnail, clear_cache, get_cached_layer,
    get_cached_thumbnail, init_cache,
};
pub use types::*;
