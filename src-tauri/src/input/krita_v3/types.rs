use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputSourceV3 {
    WinTab,
    PointerEvent,
    MacNative,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputPhaseV3 {
    Hover,
    Down,
    Move,
    Up,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeTabletEventV3 {
    pub seq: u64,
    pub stroke_id: u64,
    pub pointer_id: u32,
    pub device_id: String,
    pub source: InputSourceV3,
    pub phase: InputPhaseV3,
    pub x_px: f32,
    pub y_px: f32,
    pub pressure_0_1: f32,
    pub tilt_x_deg: f32,
    pub tilt_y_deg: f32,
    pub rotation_deg: f32,
    pub host_time_us: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_time_us: Option<u64>,
}

pub fn clamp_pressure_0_1(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 1.0)
}

pub fn clamp_tilt_deg(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(-90.0, 90.0)
}

pub fn normalize_rotation_deg(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    value.rem_euclid(360.0)
}
