//! Pattern types for the Pattern Library

use serde::{Deserialize, Serialize};

/// Color mode for patterns
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PatternMode {
    /// 1-channel grayscale
    Grayscale,
    /// 3-channel RGB
    RGB,
    /// Indexed color (with palette)
    Indexed,
}

impl PatternMode {
    /// Convert from Photoshop mode number
    pub fn from_ps_mode(mode: u32) -> Option<Self> {
        match mode {
            1 => Some(Self::Grayscale),
            2 => Some(Self::Indexed),
            3 => Some(Self::RGB),
            _ => None,
        }
    }

    /// Get display name
    pub fn name(&self) -> &'static str {
        match self {
            Self::Grayscale => "Grayscale",
            Self::RGB => "RGB",
            Self::Indexed => "Indexed",
        }
    }

    /// Get channel count
    pub fn channels(&self) -> usize {
        match self {
            Self::Grayscale | Self::Indexed => 1,
            Self::RGB => 3,
        }
    }
}

/// Pattern resource metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatternResource {
    /// Unique identifier (content hash or UUID)
    pub id: String,

    /// Display name
    pub name: String,

    /// Content hash (SHA-256), used for deduplication
    pub content_hash: String,

    /// Image width in pixels
    pub width: u32,

    /// Image height in pixels
    pub height: u32,

    /// Color mode
    pub mode: PatternMode,

    /// Source (ABR file path, .pat path, or "user-added")
    pub source: String,

    /// Group name (optional)
    pub group: Option<String>,
}

/// Import result for pattern files
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    /// Number of patterns imported
    pub imported_count: usize,

    /// Number of patterns skipped (duplicates)
    pub skipped_count: usize,

    /// Imported pattern IDs
    pub pattern_ids: Vec<String>,
}

/// Result for adding a brush-attached pattern into library
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddPatternFromBrushResult {
    /// True if a new pattern is added; false if an existing duplicate is reused
    pub added: bool,
    /// The resolved pattern in the library (new or existing)
    pub pattern: PatternResource,
}
