//! ABR data types
//!
//! Type definitions for parsed ABR brush data.

use serde::{Deserialize, Serialize};

use super::patt::PatternResource;

/// Parsed ABR file containing brushes and patterns
#[derive(Debug, Clone)]
pub struct AbrFile {
    pub version: AbrVersion,
    pub brushes: Vec<AbrBrush>,
    /// Pattern resources (textures) from patt section
    pub patterns: Vec<PatternResource>,
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
    /// Modern format (>=6) but not explicitly enumerated above.
    /// Keeps original major version for diagnostics (e.g. 9 => V6Plus(9)).
    V6Plus(u16),
}

impl AbrVersion {
    /// Check if this is a "new" format (V6+)
    pub fn is_new_format(&self) -> bool {
        matches!(
            self,
            AbrVersion::V6 | AbrVersion::V7 | AbrVersion::V10 | AbrVersion::V6Plus(_)
        )
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
    /// Hardness in percent (0-100)
    pub hardness: Option<f32>,
    /// Dynamic parameters
    pub dynamics: Option<AbrDynamics>,
    /// Whether this is a computed (parametric) brush vs sampled
    pub is_computed: bool,
    /// True if this brush is not a real preset entry, but imported only as a tip resource
    /// (e.g. referenced by Dual Brush but missing from the desc brush list).
    pub is_tip_only: bool,
    /// Texture settings (parsed from descriptor)
    pub texture_settings: Option<TextureSettings>,
    /// Dual brush settings (parsed from descriptor)
    pub dual_brush_settings: Option<DualBrushSettings>,

    // Photoshop-compatible advanced dynamics (from descriptor)
    pub shape_dynamics_enabled: Option<bool>,
    pub shape_dynamics: Option<ShapeDynamicsSettings>,
    pub scatter_enabled: Option<bool>,
    pub scatter: Option<ScatterSettings>,
    pub color_dynamics_enabled: Option<bool>,
    pub color_dynamics: Option<ColorDynamicsSettings>,
    pub transfer_enabled: Option<bool>,
    pub transfer: Option<TransferSettings>,
    /// Wet Edges panel enabled state (Photoshop-compatible)
    pub wet_edge_enabled: Option<bool>,
    /// Build-up panel enabled state (Photoshop-compatible)
    pub buildup_enabled: Option<bool>,
    /// Noise panel enabled state (Photoshop-compatible)
    pub noise_enabled: Option<bool>,

    /// Base opacity (0..1) if specified in ABR
    pub base_opacity: Option<f32>,
    /// Base flow (0..1) if specified in ABR
    pub base_flow: Option<f32>,
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

/// Control source for dynamic brush parameters (Photoshop-compatible)
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ControlSource {
    /// No control, use base value only
    #[default]
    Off,
    /// Fade over stroke distance
    Fade,
    /// Pen pressure (0-1)
    PenPressure,
    /// Pen tilt magnitude
    PenTilt,
    /// Pen barrel rotation
    Rotation,
    /// Stroke direction (Angle only)
    Direction,
    /// Initial direction at stroke start (Angle only)
    Initial,
}

/// Shape Dynamics settings (Photoshop Shape Dynamics panel compatible)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeDynamicsSettings {
    // Size Jitter
    pub size_jitter: f32, // 0-100 (%)
    pub size_control: ControlSource,
    pub minimum_diameter: f32, // 0-100 (%)

    // Angle Jitter
    pub angle_jitter: f32, // 0-360 (deg)
    pub angle_control: ControlSource,

    // Roundness Jitter
    pub roundness_jitter: f32, // 0-100 (%)
    pub roundness_control: ControlSource,
    pub minimum_roundness: f32, // 0-100 (%)

    // Flip Jitter
    pub flip_x_jitter: bool,
    pub flip_y_jitter: bool,
}

impl Default for ShapeDynamicsSettings {
    fn default() -> Self {
        Self {
            size_jitter: 0.0,
            size_control: ControlSource::Off,
            minimum_diameter: 0.0,
            angle_jitter: 0.0,
            angle_control: ControlSource::Off,
            roundness_jitter: 0.0,
            roundness_control: ControlSource::Off,
            minimum_roundness: 25.0,
            flip_x_jitter: false,
            flip_y_jitter: false,
        }
    }
}

/// Scatter settings (Photoshop Scattering panel compatible)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScatterSettings {
    pub scatter: f32, // 0-1000 (% of diameter)
    pub scatter_control: ControlSource,
    pub both_axes: bool,
    pub count: u32, // 1-16
    pub count_control: ControlSource,
    pub count_jitter: f32, // 0-100 (%)
}

impl Default for ScatterSettings {
    fn default() -> Self {
        Self {
            scatter: 0.0,
            scatter_control: ControlSource::Off,
            both_axes: false,
            count: 1,
            count_control: ControlSource::Off,
            count_jitter: 0.0,
        }
    }
}

/// Color Dynamics settings (Photoshop Color Dynamics panel compatible)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorDynamicsSettings {
    pub foreground_background_jitter: f32, // 0-100 (%)
    pub foreground_background_control: ControlSource,
    pub apply_per_tip: bool,
    pub hue_jitter: f32,        // 0-100 (%)
    pub saturation_jitter: f32, // 0-100 (%)
    pub brightness_jitter: f32, // 0-100 (%)
    pub purity: f32,            // -100..100
}

impl Default for ColorDynamicsSettings {
    fn default() -> Self {
        Self {
            foreground_background_jitter: 0.0,
            foreground_background_control: ControlSource::Off,
            apply_per_tip: true,
            hue_jitter: 0.0,
            saturation_jitter: 0.0,
            brightness_jitter: 0.0,
            purity: 0.0,
        }
    }
}

/// Transfer settings (Photoshop Transfer panel compatible)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSettings {
    pub opacity_jitter: f32, // 0-100 (%)
    pub opacity_control: ControlSource,
    pub minimum_opacity: f32, // 0-100 (%)
    pub flow_jitter: f32,     // 0-100 (%)
    pub flow_control: ControlSource,
    pub minimum_flow: f32, // 0-100 (%)
}

impl Default for TransferSettings {
    fn default() -> Self {
        Self {
            opacity_jitter: 0.0,
            opacity_control: ControlSource::Off,
            minimum_opacity: 0.0,
            flow_jitter: 0.0,
            flow_control: ControlSource::Off,
            minimum_flow: 0.0,
        }
    }
}

/// Texture blend mode (Photoshop-compatible)
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextureBlendMode {
    #[default]
    Multiply,
    Subtract,
    Darken,
    Overlay,
    ColorDodge,
    ColorBurn,
    LinearBurn,
    HardMix,
    LinearHeight,
    Height,
}

/// Dual Brush blend mode (Photoshop Dual Brush panel compatible)
/// Only 8 modes are available in PS Dual Brush: Multiply, Darken, Overlay,
/// Color Dodge, Color Burn, Linear Burn, Hard Mix, Linear Height
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DualBlendMode {
    #[default]
    Multiply, // Mltp - 正片叠底
    Darken,       // Drkn - 变暗
    Overlay,      // Ovrl - 叠加
    ColorDodge,   // CDdg - 颜色减淡
    ColorBurn,    // CBrn - 颜色加深
    LinearBurn,   // LBrn - 线性加深
    HardMix,      // HrdM - 实色混合
    LinearHeight, // LnrH - 线性高度
}

/// Dual Brush settings (Photoshop Dual Brush panel compatible)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DualBrushSettings {
    /// Is dual brush enabled
    pub enabled: bool,

    /// Secondary brush UUID (references samp section brush)
    pub brush_id: Option<String>,

    /// Secondary brush name (for UI display)
    pub brush_name: Option<String>,

    /// Blend mode for dual brush (how secondary affects primary)
    pub mode: DualBlendMode,

    /// Flip secondary brush horizontally
    pub flip: bool,

    /// Size override for secondary brush (pixels)
    pub size: f32,

    /// Roundness (0-100, Photoshop-compatible)
    pub roundness: f32,

    /// Dual size ratio relative to the preset's saved main size (dual_size / main_size)
    pub size_ratio: f32,

    /// Spacing for secondary brush (% of diameter, 0.0-1.0)
    pub spacing: f32,

    /// Scatter amount (% displacement)
    pub scatter: f32,

    /// Apply scatter on both X and Y axes
    pub both_axes: bool,

    /// Number of secondary dabs per primary dab
    pub count: u32,
}

impl Default for DualBrushSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            brush_id: None,
            brush_name: None,
            mode: DualBlendMode::Multiply,
            flip: false,
            size: 25.0,
            roundness: 100.0,
            size_ratio: 1.0,
            spacing: 0.25,
            scatter: 0.0,
            both_axes: false,
            count: 1,
        }
    }
}

/// Texture settings for brush (Photoshop Texture panel compatible)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureSettings {
    /// Is texture feature enabled
    pub enabled: bool,
    /// Pattern ID (references a pattern in the library)
    pub pattern_id: Option<String>,
    /// Pattern Name (fallback for matching when ID mismatch occurs)
    pub pattern_name: Option<String>,
    /// Raw pattern UUID from ABR descriptor (internal use for linking)
    #[serde(skip)]
    pub pattern_uuid: Option<String>,
    /// Scale percentage (10-200)
    pub scale: f32,
    /// Brightness adjustment (-150 to +150)
    pub brightness: i32,
    /// Contrast adjustment (-50 to +50)
    pub contrast: i32,
    /// Apply texture to each dab tip (vs continuous)
    pub texture_each_tip: bool,
    /// Blend mode for texture application
    pub mode: TextureBlendMode,
    /// Depth/strength (0-100%)
    pub depth: f32,
    /// Minimum depth when using control (0-100%)
    pub minimum_depth: f32,
    /// Depth jitter amount (0-100%)
    pub depth_jitter: f32,
    /// Invert texture values
    pub invert: bool,
    /// Depth control source (0=Off, 2=Pressure, etc.)
    pub depth_control: u32,
}

impl Default for TextureSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            pattern_id: None,
            pattern_name: None,
            pattern_uuid: None,
            scale: 100.0,
            brightness: 0,
            contrast: 0,
            texture_each_tip: false,
            mode: TextureBlendMode::Multiply,
            depth: 100.0,
            minimum_depth: 0.0,
            depth_jitter: 0.0,
            invert: false,
            depth_control: 0,
        }
    }
}

/// Brush preset for frontend consumption (lightweight metadata only)
///
/// Note: Texture data is NOT included here. Instead, textures are cached
/// in BrushCache and served via the `project://brush/{id}` protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrushPreset {
    /// Unique identifier
    pub id: String,
    /// Original ABR sampled UUID (if any). Used for linking Dual Brush secondary tips.
    pub source_uuid: Option<String>,
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
    /// Whether brush is a computed (procedural) tip
    pub is_computed: bool,
    /// Texture dimensions (for pre-allocation, texture data via protocol)
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
    /// Pre-computed cursor outline LOD0 (detail-first path)
    pub cursor_path_lod0: Option<String>,
    /// Pre-computed cursor outline LOD1 (balanced path)
    pub cursor_path_lod1: Option<String>,
    /// Pre-computed cursor outline LOD2 (budget-first path)
    pub cursor_path_lod2: Option<String>,
    /// Cursor complexity metadata for LOD0
    pub cursor_complexity_lod0: Option<CursorComplexityData>,
    /// Cursor complexity metadata for LOD1
    pub cursor_complexity_lod1: Option<CursorComplexityData>,
    /// Cursor complexity metadata for LOD2
    pub cursor_complexity_lod2: Option<CursorComplexityData>,
    /// Texture settings (from ABR Texture panel data)
    pub texture_settings: Option<TextureSettings>,
    /// Dual brush settings (from ABR Dual Brush panel data)
    pub dual_brush_settings: Option<DualBrushSettings>,

    /// Shape Dynamics (Photoshop-compatible)
    pub shape_dynamics_enabled: Option<bool>,
    pub shape_dynamics: Option<ShapeDynamicsSettings>,
    /// Scattering (Photoshop-compatible)
    pub scatter_enabled: Option<bool>,
    pub scatter: Option<ScatterSettings>,
    /// Color Dynamics (Photoshop-compatible)
    pub color_dynamics_enabled: Option<bool>,
    pub color_dynamics: Option<ColorDynamicsSettings>,
    /// Transfer (Photoshop-compatible)
    pub transfer_enabled: Option<bool>,
    pub transfer: Option<TransferSettings>,
    /// Wet Edges panel enabled state (Photoshop-compatible)
    pub wet_edge_enabled: Option<bool>,
    /// Build-up panel enabled state (Photoshop-compatible)
    pub buildup_enabled: Option<bool>,
    /// Noise panel enabled state (Photoshop-compatible)
    pub noise_enabled: Option<bool>,

    /// Base opacity (0..1)
    pub base_opacity: Option<f32>,
    /// Base flow (0..1)
    pub base_flow: Option<f32>,
}

/// Cursor bounds data for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorBoundsData {
    pub width: f32,
    pub height: f32,
}

/// Cursor complexity metadata for runtime LOD selection
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorComplexityData {
    pub path_len: u32,
    pub segment_count: u32,
    pub contour_count: u32,
}

impl BrushPreset {
    pub fn from_abr_with_cursor_lod(
        brush: AbrBrush,
        lod_limits: super::cursor::CursorLodPathLenLimits,
    ) -> Self {
        let dynamics = brush.dynamics.as_ref();
        let source_uuid = brush.uuid.clone();

        // Generate cursor outline LODs from texture if available
        let (
            cursor_path,
            cursor_bounds,
            cursor_path_lod0,
            cursor_path_lod1,
            cursor_path_lod2,
            cursor_complexity_lod0,
            cursor_complexity_lod1,
            cursor_complexity_lod2,
        ) = if brush.is_computed {
            (None, None, None, None, None, None, None, None)
        } else {
            brush
                .tip_image
                .as_ref()
                .map(|img| {
                    let lod = super::cursor::generate_cursor_lods(img, lod_limits);
                    let legacy = lod
                        .path_lod2
                        .clone()
                        .or_else(|| lod.path_lod1.clone())
                        .or_else(|| lod.path_lod0.clone());
                    let bounds = if legacy.is_some() {
                        lod.bounds.map(|b| CursorBoundsData {
                            width: b.width,
                            height: b.height,
                        })
                    } else {
                        None
                    };

                    (
                        legacy,
                        bounds,
                        lod.path_lod0,
                        lod.path_lod1,
                        lod.path_lod2,
                        lod.complexity_lod0,
                        lod.complexity_lod1,
                        lod.complexity_lod2,
                    )
                })
                .unwrap_or((None, None, None, None, None, None, None, None))
        };

        let has_texture = brush.tip_image.is_some() && !brush.is_computed;

        BrushPreset {
            id: brush
                .uuid
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            source_uuid,
            name: brush.name,
            diameter: brush.diameter,
            spacing: brush.spacing * 100.0,
            hardness: brush.hardness.unwrap_or(100.0),
            angle: brush.angle,
            roundness: brush.roundness * 100.0,
            has_texture,
            is_computed: brush.is_computed,
            // Note: texture_data removed - textures served via project://brush/{id}
            texture_width: if has_texture {
                brush.tip_image.as_ref().map(|img| img.width)
            } else {
                None
            },
            texture_height: if has_texture {
                brush.tip_image.as_ref().map(|img| img.height)
            } else {
                None
            },
            size_pressure: dynamics.map(|d| d.size_control == 2).unwrap_or(false),
            opacity_pressure: dynamics.map(|d| d.opacity_control == 2).unwrap_or(false),
            cursor_path,
            cursor_bounds,
            cursor_path_lod0,
            cursor_path_lod1,
            cursor_path_lod2,
            cursor_complexity_lod0,
            cursor_complexity_lod1,
            cursor_complexity_lod2,
            texture_settings: brush.texture_settings,
            dual_brush_settings: brush.dual_brush_settings,
            shape_dynamics_enabled: brush.shape_dynamics_enabled,
            shape_dynamics: brush.shape_dynamics,
            scatter_enabled: brush.scatter_enabled,
            scatter: brush.scatter,
            color_dynamics_enabled: brush.color_dynamics_enabled,
            color_dynamics: brush.color_dynamics,
            transfer_enabled: brush.transfer_enabled,
            transfer: brush.transfer,
            wet_edge_enabled: brush.wet_edge_enabled,
            buildup_enabled: brush.buildup_enabled,
            noise_enabled: brush.noise_enabled,
            base_opacity: brush.base_opacity,
            base_flow: brush.base_flow,
        }
    }
}

impl From<AbrBrush> for BrushPreset {
    fn from(brush: AbrBrush) -> Self {
        BrushPreset::from_abr_with_cursor_lod(
            brush,
            super::cursor::CursorLodPathLenLimits::default(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computed_brush_is_not_texture() {
        let brush = AbrBrush {
            name: "Computed".to_string(),
            uuid: Some("computed-1".to_string()),
            tip_image: Some(GrayscaleImage::new(2, 2, vec![0, 255, 255, 0])),
            diameter: 20.0,
            spacing: 0.25,
            angle: 0.0,
            roundness: 1.0,
            hardness: Some(1.0),
            dynamics: None,
            is_computed: true,
            is_tip_only: false,
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
        };

        let preset: BrushPreset = brush.into();
        assert!(!preset.has_texture);
        assert!(preset.is_computed);
        assert!(preset.texture_width.is_none());
        assert!(preset.texture_height.is_none());
    }

    #[test]
    fn sampled_brush_keeps_texture() {
        let brush = AbrBrush {
            name: "Sampled".to_string(),
            uuid: Some("sampled-1".to_string()),
            tip_image: Some(GrayscaleImage::new(2, 2, vec![0, 255, 255, 0])),
            diameter: 20.0,
            spacing: 0.25,
            angle: 0.0,
            roundness: 1.0,
            hardness: Some(1.0),
            dynamics: None,
            is_computed: false,
            is_tip_only: false,
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
        };

        let preset: BrushPreset = brush.into();
        assert!(preset.has_texture);
        assert!(!preset.is_computed);
        assert_eq!(preset.texture_width, Some(2));
        assert_eq!(preset.texture_height, Some(2));
    }

    #[test]
    fn preset_keeps_wet_noise_buildup_flags() {
        let brush = AbrBrush {
            name: "Flags".to_string(),
            uuid: Some("flags-1".to_string()),
            tip_image: None,
            diameter: 20.0,
            spacing: 0.25,
            angle: 0.0,
            roundness: 1.0,
            hardness: Some(1.0),
            dynamics: None,
            is_computed: false,
            is_tip_only: false,
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
            wet_edge_enabled: Some(true),
            buildup_enabled: Some(false),
            noise_enabled: Some(true),
            base_opacity: None,
            base_flow: None,
        };

        let preset: BrushPreset = brush.into();
        assert_eq!(preset.wet_edge_enabled, Some(true));
        assert_eq!(preset.buildup_enabled, Some(false));
        assert_eq!(preset.noise_enabled, Some(true));
    }
}

// Note: encode_texture function removed - no longer needed
// Textures are now cached as raw Gray8 data and served via LZ4 compression

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
