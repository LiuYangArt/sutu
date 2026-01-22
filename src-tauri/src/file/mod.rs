//! File format support module
//!
//! Provides save/load functionality for:
//! - OpenRaster (.ora) - Primary project format with full layer support
//! - TIFF (.tiff) - Compatibility format with embedded layer data (disabled)
//! - PSD (.psd) - Adobe Photoshop format for interoperability

pub mod ora;
pub mod psd;
pub mod tiff;
pub mod types;

pub use types::*;
