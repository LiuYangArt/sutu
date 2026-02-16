use crate::benchmark::BackendBenchmark;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrushPresetCore {
    pub id: String,
    pub source_uuid: Option<String>,
    pub name: String,
    pub diameter: f32,
    pub spacing: f32,
    pub hardness: f32,
    pub angle: f32,
    pub roundness: f32,
    pub has_texture: bool,
    pub is_computed: bool,
    pub texture_width: Option<u32>,
    pub texture_height: Option<u32>,
    pub size_pressure: bool,
    pub opacity_pressure: bool,
    pub base_opacity: Option<f32>,
    pub base_flow: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternResourceCore {
    pub id: String,
    pub name: String,
    pub content_hash: String,
    pub width: u32,
    pub height: u32,
    pub mode: String,
    pub source: String,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DabParamsCore {
    pub x: f32,
    pub y: f32,
    pub size: f32,
    pub flow: f32,
    pub hardness: f32,
    pub color: String,
    pub dab_opacity: Option<f32>,
    pub roundness: Option<f32>,
    pub angle: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerDataCore {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub layer_type: String,
    pub visible: bool,
    pub locked: bool,
    pub opacity: f32,
    pub blend_mode: String,
    pub is_background: Option<bool>,
    pub offset_x: i32,
    pub offset_y: i32,
    pub layer_png_bytes: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_image_data_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDataCore {
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
    pub layers: Vec<LayerDataCore>,
    pub flattened_png_bytes: Option<Vec<u8>>,
    pub thumbnail_png_bytes: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_flattened_image_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_thumbnail_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub benchmark: Option<BackendBenchmark>,
}
