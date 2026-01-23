//! File format types for ORA and TIFF support

use serde::{Deserialize, Serialize};

/// Layer data for IPC transfer between frontend and backend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerData {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub layer_type: String, // "raster" | "group" | "adjustment"
    pub visible: bool,
    pub locked: bool,
    pub opacity: f32, // 0.0 - 1.0
    #[serde(rename = "blendMode")]
    pub blend_mode: String,
    #[serde(rename = "isBackground")]
    pub is_background: Option<bool>,
    /// Base64-encoded PNG data for layer pixels
    #[serde(rename = "imageData")]
    pub image_data: Option<String>,
    /// Layer position offset X (for ORA compatibility)
    #[serde(rename = "offsetX", default)]
    pub offset_x: i32,
    /// Layer position offset Y (for ORA compatibility)
    #[serde(rename = "offsetY", default)]
    pub offset_y: i32,
}

/// Complete project data for save/load operations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectData {
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
    pub layers: Vec<LayerData>,
    /// Base64-encoded PNG of flattened image (used for TIFF Page 1)
    #[serde(rename = "flattenedImage")]
    pub flattened_image: Option<String>,
    /// Base64-encoded 256x256 thumbnail (used for ORA)
    pub thumbnail: Option<String>,
    /// Backend benchmark data for performance monitoring
    #[serde(skip_serializing_if = "Option::is_none")]
    pub benchmark: Option<crate::benchmark::BackendBenchmark>,
}

/// Supported file formats
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileFormat {
    Ora,
    Tiff,
    Psd,
}

impl FileFormat {
    /// Detect format from file extension
    pub fn from_path(path: &str) -> Option<Self> {
        let path_lower = path.to_lowercase();
        if path_lower.ends_with(".ora") {
            Some(FileFormat::Ora)
        } else if path_lower.ends_with(".tiff") || path_lower.ends_with(".tif") {
            Some(FileFormat::Tiff)
        } else if path_lower.ends_with(".psd") {
            Some(FileFormat::Psd)
        } else {
            None
        }
    }

    /// Get default file extension
    pub fn extension(&self) -> &'static str {
        match self {
            FileFormat::Ora => "ora",
            FileFormat::Tiff => "tiff",
            FileFormat::Psd => "psd",
        }
    }
}

/// Result of file save/load operations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileOperationResult {
    pub success: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

impl FileOperationResult {
    pub fn success(path: String) -> Self {
        Self {
            success: true,
            path: Some(path),
            error: None,
        }
    }

    pub fn error(message: String) -> Self {
        Self {
            success: false,
            path: None,
            error: Some(message),
        }
    }
}

/// File operation errors
#[derive(Debug, thiserror::Error)]
pub enum FileError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Invalid file format: {0}")]
    InvalidFormat(String),

    #[error("ZIP error: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("XML error: {0}")]
    Xml(String),

    #[error("Image error: {0}")]
    Image(#[from] image::ImageError),

    #[error("Base64 decode error: {0}")]
    Base64(#[from] base64::DecodeError),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("TIFF error: {0}")]
    Tiff(String),

    #[error("PSD error: {0}")]
    Psd(String),
}

impl From<FileError> for String {
    fn from(e: FileError) -> Self {
        e.to_string()
    }
}

impl From<quick_xml::Error> for FileError {
    fn from(e: quick_xml::Error) -> Self {
        FileError::Xml(e.to_string())
    }
}

impl From<quick_xml::DeError> for FileError {
    fn from(e: quick_xml::DeError) -> Self {
        FileError::Xml(e.to_string())
    }
}
