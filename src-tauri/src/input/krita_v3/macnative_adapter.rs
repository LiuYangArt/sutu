use super::coordinate_mapper_mac::CoordinateMapperMac;
use super::phase_machine_mac::PhaseMachineMac;
use super::timebase_mac::MonotonicTimebaseMac;
use super::types::{
    clamp_pressure_0_1, clamp_tilt_deg, normalize_rotation_deg, InputPhaseV3, InputSourceV3,
    NativeTabletEventV3,
};
use crate::input::backend::TabletV3Diagnostics;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacNativeEventKind {
    TabletPoint,
    MouseDown,
    MouseDragged,
    MouseUp,
}

#[derive(Debug, Clone, Copy)]
pub struct MacNativeRawSample {
    pub pointer_id: u32,
    pub kind: MacNativeEventKind,
    pub in_proximity: bool,
    pub x_window_px: f32,
    pub y_window_px: f32,
    pub pressure_0_1: f32,
    pub tilt_x_deg: f32,
    pub tilt_y_deg: f32,
    pub rotation_deg: f32,
    pub host_time_us: u64,
    pub device_time_us: Option<u64>,
}

#[derive(Debug)]
pub struct MacNativeAdapterV3 {
    device_id: String,
    mapper: CoordinateMapperMac,
    phase_machine: PhaseMachineMac,
    timebase: MonotonicTimebaseMac,
    diagnostics: TabletV3Diagnostics,
    last_pointer_id: u32,
}

impl MacNativeAdapterV3 {
    pub fn new(device_id: String, viewport_width_px: f32, viewport_height_px: f32) -> Self {
        Self {
            device_id,
            mapper: CoordinateMapperMac::new(viewport_width_px, viewport_height_px),
            phase_machine: PhaseMachineMac::new(),
            timebase: MonotonicTimebaseMac::new(),
            diagnostics: TabletV3Diagnostics::default(),
            last_pointer_id: 0,
        }
    }

    pub fn reset(&mut self) {
        self.phase_machine.reset();
        self.timebase.reset();
        self.diagnostics = TabletV3Diagnostics::default();
        self.last_pointer_id = 0;
    }

    pub fn update_viewport_size(&mut self, viewport_width_px: f32, viewport_height_px: f32) {
        self.mapper
            .update_viewport_size(viewport_width_px, viewport_height_px);
    }

    pub fn diagnostics_snapshot(&self) -> TabletV3Diagnostics {
        self.diagnostics.clone()
    }

    fn resolve_pointer_id(&mut self, raw_pointer_id: u32) -> u32 {
        if raw_pointer_id > 0 {
            self.last_pointer_id = raw_pointer_id;
            return raw_pointer_id;
        }
        if self.last_pointer_id > 0 {
            return self.last_pointer_id;
        }
        1
    }

    pub fn process_raw_sample(&mut self, raw: MacNativeRawSample) -> Option<NativeTabletEventV3> {
        let pointer_id = self.resolve_pointer_id(raw.pointer_id);
        let (explicit_down, explicit_up, in_contact) = match raw.kind {
            MacNativeEventKind::MouseDown => (true, false, true),
            MacNativeEventKind::MouseDragged => (false, false, true),
            MacNativeEventKind::MouseUp => (false, true, false),
            MacNativeEventKind::TabletPoint => (false, false, raw.pressure_0_1 > 0.0),
        };

        let phase_output = self.phase_machine.resolve(
            pointer_id,
            in_contact,
            raw.in_proximity,
            explicit_down,
            explicit_up,
        )?;

        if phase_output.transition_error {
            self.diagnostics.phase_transition_error_count = self
                .diagnostics
                .phase_transition_error_count
                .saturating_add(1);
        }

        let mapped = self
            .mapper
            .map_window_point_to_client(raw.x_window_px, raw.y_window_px);
        if mapped.out_of_view {
            self.diagnostics.coord_out_of_view_count =
                self.diagnostics.coord_out_of_view_count.saturating_add(1);
        }

        let (host_time_us, corrected_host_time) = self
            .timebase
            .normalize_host_time_us(pointer_id, raw.host_time_us.max(1));
        if corrected_host_time {
            self.diagnostics.host_time_non_monotonic_count = self
                .diagnostics
                .host_time_non_monotonic_count
                .saturating_add(1);
        }

        let device_time_us =
            self.timebase
                .normalize_device_time_us(pointer_id, raw.device_time_us, host_time_us);

        let pressure_raw = if phase_output.phase == InputPhaseV3::Up {
            0.0
        } else {
            raw.pressure_0_1
        };
        let pressure_0_1 = clamp_pressure_0_1(pressure_raw);
        self.diagnostics.pressure_total_count =
            self.diagnostics.pressure_total_count.saturating_add(1);
        if !pressure_raw.is_finite() || (pressure_raw - pressure_0_1).abs() > f32::EPSILON {
            self.diagnostics.pressure_clamp_count =
                self.diagnostics.pressure_clamp_count.saturating_add(1);
        }

        Some(NativeTabletEventV3 {
            seq: 0,
            stroke_id: phase_output.stroke_id,
            pointer_id,
            device_id: self.device_id.clone(),
            source: InputSourceV3::MacNative,
            phase: phase_output.phase,
            x_px: mapped.x_px,
            y_px: mapped.y_px,
            pressure_0_1,
            tilt_x_deg: clamp_tilt_deg(raw.tilt_x_deg),
            tilt_y_deg: clamp_tilt_deg(raw.tilt_y_deg),
            rotation_deg: normalize_rotation_deg(raw.rotation_deg),
            host_time_us,
            device_time_us,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_raw(kind: MacNativeEventKind, pressure: f32, host_time_us: u64) -> MacNativeRawSample {
        MacNativeRawSample {
            pointer_id: 7,
            kind,
            in_proximity: true,
            x_window_px: 120.0,
            y_window_px: 80.0,
            pressure_0_1: pressure,
            tilt_x_deg: 0.0,
            tilt_y_deg: 0.0,
            rotation_deg: 0.0,
            host_time_us,
            device_time_us: Some(host_time_us),
        }
    }

    #[test]
    fn emits_down_move_up_with_single_stroke() {
        let mut adapter = MacNativeAdapterV3::new("macnative".to_string(), 400.0, 300.0);
        let down = adapter
            .process_raw_sample(make_raw(MacNativeEventKind::MouseDown, 0.2, 100))
            .expect("down");
        let mv = adapter
            .process_raw_sample(make_raw(MacNativeEventKind::MouseDragged, 0.4, 120))
            .expect("move");
        let up = adapter
            .process_raw_sample(make_raw(MacNativeEventKind::MouseUp, 0.0, 140))
            .expect("up");

        assert_eq!(down.phase, InputPhaseV3::Down);
        assert_eq!(mv.phase, InputPhaseV3::Move);
        assert_eq!(up.phase, InputPhaseV3::Up);
        assert_eq!(down.stroke_id, mv.stroke_id);
        assert_eq!(mv.stroke_id, up.stroke_id);
    }

    #[test]
    fn counts_pressure_clamp_and_out_of_view() {
        let mut adapter = MacNativeAdapterV3::new("macnative".to_string(), 100.0, 100.0);
        let mut raw = make_raw(MacNativeEventKind::MouseDown, 2.0, 100);
        raw.x_window_px = -20.0;
        raw.y_window_px = 500.0;
        let _ = adapter.process_raw_sample(raw).expect("sample");

        let diagnostics = adapter.diagnostics_snapshot();
        assert_eq!(diagnostics.pressure_total_count, 1);
        assert_eq!(diagnostics.pressure_clamp_count, 1);
        assert_eq!(diagnostics.coord_out_of_view_count, 1);
    }

    #[test]
    fn tracks_non_monotonic_host_time_corrections() {
        let mut adapter = MacNativeAdapterV3::new("macnative".to_string(), 400.0, 300.0);
        let _ = adapter.process_raw_sample(make_raw(MacNativeEventKind::MouseDown, 0.2, 200));
        let _ = adapter.process_raw_sample(make_raw(MacNativeEventKind::MouseDragged, 0.3, 180));
        let diagnostics = adapter.diagnostics_snapshot();
        assert_eq!(diagnostics.host_time_non_monotonic_count, 1);
    }
}
