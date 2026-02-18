use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
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
#[serde(rename_all = "snake_case")]
pub struct PaintInfoV1 {
    pub x_px: f32,
    pub y_px: f32,
    pub pressure_01: f32,
    pub drawing_speed_01: f32,
    pub time_us: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DabRequestV1 {
    pub x_px: f32,
    pub y_px: f32,
    pub size_px: f32,
    pub flow_01: f32,
    pub opacity_01: f32,
    pub time_us: u64,
}

pub type GateMetricMapV1 = BTreeMap<String, serde_json::Value>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GateEnvV1 {
    pub krita_version: String,
    pub tablet: String,
    pub os: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GateRunMetaV1 {
    pub run_id: String,
    pub created_at: String,
    pub source_of_truth_version: Vec<String>,
    pub env: GateEnvV1,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GateCaseResultV1 {
    pub case_id: String,
    pub case_name: String,
    pub sample_count: u32,
    pub dab_count: u32,
    pub stage_metrics: GateMetricMapV1,
    pub final_metrics: GateMetricMapV1,
    pub fast_windows_metrics: GateMetricMapV1,
    pub stage_gate: String,
    pub final_gate: String,
    pub fast_gate: String,
    pub overall: String,
    pub blocking_failures: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GatePresetResultV1 {
    pub preset_id: String,
    pub preset_name: String,
    pub case_results: BTreeMap<String, String>,
    pub sensor_map_mae: f32,
    pub sensor_map_p95: f32,
    pub combiner_output_mae: f32,
    pub combiner_output_p95: f32,
    pub stage_gate: String,
    pub final_gate: String,
    pub fast_gate: String,
    pub overall: String,
    pub blocking_failures: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GateSummaryV1 {
    pub overall: String,
    pub stage_gate: String,
    pub final_gate: String,
    pub fast_gate: String,
    pub blocking_failures_count: u32,
    pub case_passed: u32,
    pub case_total: u32,
    pub preset_passed: u32,
    pub preset_total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GateArtifactV1 {
    pub run_meta: GateRunMetaV1,
    pub input_hash: String,
    pub baseline_version: String,
    pub threshold_version: String,
    pub stage_metrics: GateMetricMapV1,
    pub final_metrics: GateMetricMapV1,
    pub fast_windows_metrics: GateMetricMapV1,
    pub semantic_checks: BTreeMap<String, String>,
    pub stage_gate: String,
    pub final_gate: String,
    pub fast_gate: String,
    pub overall: String,
    pub blocking_failures: Vec<String>,
    pub case_results: Vec<GateCaseResultV1>,
    pub preset_results: Vec<GatePresetResultV1>,
    pub summary: GateSummaryV1,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn raw_input_contract_uses_snake_case_fields() {
        let sample = RawInputSampleV1 {
            x_px: 10.0,
            y_px: 20.0,
            pressure_01: 0.5,
            tilt_x_deg: 1.0,
            tilt_y_deg: 2.0,
            rotation_deg: 0.0,
            device_time_us: 1000,
            host_time_us: 1000,
            source: "wintab".to_string(),
            phase: "down".to_string(),
            seq: Some(1),
        };
        let value = serde_json::to_value(&sample).expect("serialize RawInputSampleV1");
        assert!(value.get("x_px").is_some());
        assert!(value.get("xPx").is_none());
    }

    #[test]
    fn gate_artifact_roundtrip_json() {
        let mut metrics = GateMetricMapV1::new();
        metrics.insert("pressure_curve_mae".to_string(), json!(0.001));
        let artifact = GateArtifactV1 {
            run_meta: GateRunMetaV1 {
                run_id: "kp_test".to_string(),
                created_at: "2026-02-18T00:00:00Z".to_string(),
                source_of_truth_version: vec![
                    "docs/research/2026-02-18-krita-wacom-pressure-full-chain.md".to_string(),
                ],
                env: GateEnvV1 {
                    krita_version: "5.2".to_string(),
                    tablet: "Wacom".to_string(),
                    os: "Windows 11".to_string(),
                },
            },
            input_hash: "hash".to_string(),
            baseline_version: "krita-5.2-default-wintab".to_string(),
            threshold_version: "krita-pressure-thresholds.v1".to_string(),
            stage_metrics: metrics.clone(),
            final_metrics: metrics.clone(),
            fast_windows_metrics: metrics.clone(),
            semantic_checks: BTreeMap::from([(
                "no_start_distance_gate".to_string(),
                "pass".to_string(),
            )]),
            stage_gate: "pass".to_string(),
            final_gate: "pass".to_string(),
            fast_gate: "pass".to_string(),
            overall: "pass".to_string(),
            blocking_failures: vec![],
            case_results: vec![],
            preset_results: vec![],
            summary: GateSummaryV1 {
                overall: "pass".to_string(),
                stage_gate: "pass".to_string(),
                final_gate: "pass".to_string(),
                fast_gate: "pass".to_string(),
                blocking_failures_count: 0,
                case_passed: 0,
                case_total: 0,
                preset_passed: 0,
                preset_total: 0,
            },
        };

        let serialized = serde_json::to_string(&artifact).expect("serialize GateArtifactV1");
        let parsed: GateArtifactV1 =
            serde_json::from_str(&serialized).expect("deserialize GateArtifactV1");
        assert_eq!(parsed.input_hash, "hash");
        assert_eq!(parsed.stage_gate, "pass");
    }
}
