//! ABR data types
//!
//! Type definitions for parsed ABR brush data.

use serde::{Deserialize, Serialize};

/// Parsed ABR file containing brushes
#[derive(Debug, Clone)]
pub struct AbrFile {
    pub version: AbrVersion,
    pub brushes: Vec<AbrBrush>,
}

/// ABR file format version
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbrVersion {
    /// Very old format (Photoshop 4)
    V1,
    /// Old format (Photoshop 5-6)
    V2,
    /// New format (Photoshop 7+)
    V6,
    /// New format variant
    V7,
    /// Latest format (Creative Cloud)
    V10,
}

impl AbrVersion {
    /// Check if this is a "new" format (V6+)
    pub fn is_new_format(&self) -> bool {
        matches!(self, AbrVersion::V6 | AbrVersion::V7 | AbrVersion::V10)
    }
}

/// A single brush from the ABR file
#[derive(Debug, Clone)]
pub struct AbrBrush {
    /// Brush name
    pub name: String,
    /// Unique identifier (for sampled brushes)
    pub uuid: Option<String>,
    /// Brush tip image (grayscale, alpha represents opacity)
    pub tip_image: Option<GrayscaleImage>,
    /// Brush diameter in pixels
    pub diameter: f32,
    /// Spacing as fraction of diameter (0.25 = 25%)
    pub spacing: f32,
    /// Brush angle in degrees
    pub angle: f32,
    /// Roundness (1.0 = circular, 0.0 = flat line)
    pub roundness: f32,
    /// Hardness (1.0 = hard edge, 0.0 = soft)
    pub hardness: Option<f32>,
    /// Dynamic parameters
    pub dynamics: Option<AbrDynamics>,
    /// Whether this is a computed (parametric) brush vs sampled
    pub is_computed: bool,
}

/// Grayscale image data for brush tips
#[derive(Debug, Clone)]
pub struct GrayscaleImage {
    pub width: u32,
    pub height: u32,
    /// Pixel data, 8-bit grayscale (0 = transparent, 255 = opaque)
    pub data: Vec<u8>,
}

impl GrayscaleImage {
    /// Create a new grayscale image
    pub fn new(width: u32, height: u32, data: Vec<u8>) -> Self {
        Self {
            width,
            height,
            data,
        }
    }

    /// Get pixel value at coordinates
    pub fn get_pixel(&self, x: u32, y: u32) -> Option<u8> {
        if x < self.width && y < self.height {
            let idx = (y * self.width + x) as usize;
            self.data.get(idx).copied()
        } else {
            None
        }
    }
}

/// Brush dynamics (pressure/tilt sensitivity)
#[derive(Debug, Clone, Default)]
pub struct AbrDynamics {
    /// Enable tip dynamics (size, angle, roundness)
    pub use_tip_dynamics: bool,
    /// Size control (0=Off, 2=Pressure, 6=Direction, etc.)
    pub size_control: u32,
    /// Size jitter amount
    pub size_jitter: f32,
    /// Minimum size percentage
    pub size_minimum: f32,
    /// Angle control
    pub angle_control: u32,
    /// Angle jitter amount
    pub angle_jitter: f32,
    /// Enable scatter
    pub use_scatter: bool,
    /// Scatter amount
    pub scatter: f32,
    /// Scatter count
    pub scatter_count: u32,
    /// Enable paint dynamics (opacity, flow)
    pub use_paint_dynamics: bool,
    /// Opacity control
    pub opacity_control: u32,
    /// Opacity jitter
    pub opacity_jitter: f32,
}

/// Brush preset for frontend consumption
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrushPreset {
    /// Unique identifier
    pub id: String,
    /// Display name
    pub name: String,
    /// Brush diameter
    pub diameter: f32,
    /// Spacing as percentage (25 = 25%)
    pub spacing: f32,
    /// Hardness (0-100)
    pub hardness: f32,
    /// Angle in degrees
    pub angle: f32,
    /// Roundness (0-100)
    pub roundness: f32,
    /// Whether brush has custom tip texture
    pub has_texture: bool,
    /// Tip texture data (base64 encoded PNG, if any)
    pub texture_data: Option<String>,
    /// Texture dimensions
    pub texture_width: Option<u32>,
    pub texture_height: Option<u32>,
    /// Pressure affects size
    pub size_pressure: bool,
    /// Pressure affects opacity
    pub opacity_pressure: bool,
    /// Pre-computed cursor outline as SVG path data (normalized 0-1 coordinates)
    pub cursor_path: Option<String>,
    /// Cursor bounds for proper scaling
    pub cursor_bounds: Option<CursorBoundsData>,
}

/// Cursor bounds data for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorBoundsData {
    pub width: f32,
    pub height: f32,
}

impl From<AbrBrush> for BrushPreset {
    fn from(brush: AbrBrush) -> Self {
        let dynamics = brush.dynamics.as_ref();

        // Generate cursor outline from texture if available
        let (cursor_path, cursor_bounds) = brush
            .tip_image
            .as_ref()
            .map(|img| {
                let path = super::cursor::extract_cursor_outline(img, 128);
                let bounds = path.as_ref().map(|_| CursorBoundsData {
                    width: img.width as f32,
                    height: img.height as f32,
                });
                (path, bounds)
            })
            .unwrap_or((None, None));

        BrushPreset {
            id: brush
                .uuid
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name: brush.name,
            diameter: brush.diameter,
            spacing: brush.spacing * 100.0,
            hardness: brush.hardness.unwrap_or(100.0),
            angle: brush.angle,
            roundness: brush.roundness * 100.0,
            has_texture: brush.tip_image.is_some(),
            texture_data: brush.tip_image.as_ref().map(encode_texture),
            texture_width: brush.tip_image.as_ref().map(|img| img.width),
            texture_height: brush.tip_image.as_ref().map(|img| img.height),
            size_pressure: dynamics.map(|d| d.size_control == 2).unwrap_or(false),
            opacity_pressure: dynamics.map(|d| d.opacity_control == 2).unwrap_or(false),
            cursor_path,
            cursor_bounds,
        }
    }
}

/// Encode grayscale image to base64 PNG
fn encode_texture(img: &GrayscaleImage) -> String {
    use image::{GrayImage, ImageBuffer};

    let gray_img: GrayImage = ImageBuffer::from_raw(img.width, img.height, img.data.clone())
        .unwrap_or_else(|| ImageBuffer::new(img.width.max(1), img.height.max(1)));

    let mut png_data = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut png_data);

    if let Err(e) = gray_img.write_to(&mut cursor, image::ImageFormat::Png) {
        tracing::warn!("Failed to encode texture: {}", e);
        return String::new();
    }

    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(&png_data)
}

/// Generate a simple UUID v4
mod uuid {
    use std::fmt;

    pub struct Uuid;

    impl Uuid {
        pub fn new_v4() -> UuidV4 {
            UuidV4(rand_u128())
        }
    }

    pub struct UuidV4(u128);

    impl fmt::Display for UuidV4 {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(
                f,
                "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
                (self.0 >> 96) as u32,
                (self.0 >> 80) as u16,
                ((self.0 >> 64) as u16 & 0x0fff) | 0x4000,
                ((self.0 >> 48) as u16 & 0x3fff) | 0x8000,
                (self.0 & 0xffffffffffff) as u64
            )
        }
    }

    fn rand_u128() -> u128 {
        use std::time::{SystemTime, UNIX_EPOCH};
        let t = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let seed = t.as_nanos();
        // Simple hash-like mixing
        seed.wrapping_mul(0x9e3779b97f4a7c15)
            .wrapping_add(0x6a09e667f3bcc908)
    }
}
