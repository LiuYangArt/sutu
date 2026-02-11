//! ABR (Adobe Brush) file parser
//!
//! This module provides functionality to parse Photoshop ABR brush files,
//! extracting brush presets including tip textures and parameters.
//!
//! # Supported Versions
//!
//! - V1/V2: Old format (Photoshop 5-6)
//! - V6+: Modern format (Photoshop 7+ and later)
//!
//! # Example
//!
//! ```ignore
//! use sutu_lib::abr::AbrParser;
//!
//! let data = std::fs::read("brush.abr")?;
//! let abr_file = AbrParser::parse(&data)?;
//!
//! for brush in abr_file.brushes {
//!     println!("Brush: {} ({}x{})",
//!         brush.name,
//!         brush.tip_image.as_ref().map(|i| i.width).unwrap_or(0),
//!         brush.tip_image.as_ref().map(|i| i.height).unwrap_or(0)
//!     );
//! }
//! ```

pub mod cursor;
pub mod defaults;
pub mod descriptor;
pub mod error;
mod parser;
pub mod patt;
mod samp;
mod types;

pub use cursor::{extract_cursor_outline, generate_cursor_data, CursorBounds};
pub use defaults::AbrDefaults;
pub use error::AbrError;
pub use parser::AbrParser;
pub use patt::PatternResource;
pub use samp::normalize_brush_texture;
pub use types::{
    AbrBrush, AbrDynamics, AbrFile, AbrVersion, BrushPreset, ColorDynamicsSettings, ControlSource,
    CursorBoundsData, GrayscaleImage, ScatterSettings, ShapeDynamicsSettings, TextureBlendMode,
    TextureSettings, TransferSettings,
};

#[cfg(test)]
mod tests;
