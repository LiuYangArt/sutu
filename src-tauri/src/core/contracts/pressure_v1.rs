use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawInputSampleV1 {
    pub x_px: f32,
    pub y_px: f32,
    pub pressure_01: f32,
    pub tilt_x_deg: f32,
    pub tilt_y_deg: f32,
    pub rotation_deg: f32,
    pub device_time_us: u64,
    pub host_time_us: u64,
    pub source: String,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaintInfoV1 {
    pub x_px: f32,
    pub y_px: f32,
    pub pressure_01: f32,
    pub drawing_speed_01: f32,
    pub time_us: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DabRequestV1 {
    pub x_px: f32,
    pub y_px: f32,
    pub size_px: f32,
    pub flow_01: f32,
    pub opacity_01: f32,
    pub time_us: u64,
}
