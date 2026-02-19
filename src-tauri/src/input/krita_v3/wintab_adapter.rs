#[cfg(target_os = "windows")]
use wintab_lite::Packet;

use super::coordinate_mapper::CoordinateMapper;
use super::phase_machine::PhaseMachine;
use super::timebase::MonotonicTimebase;
use super::types::{
    clamp_pressure_0_1, clamp_tilt_deg, normalize_rotation_deg, InputPhaseV3, InputSourceV3,
    NativeTabletEventV3,
};

const WINTAB_ANGLE_TENTHS_PER_DEGREE: f32 = 10.0;
const WINTAB_PROXIMITY_STATUS_BIT: u32 = 0x01;
const WINTAB_CONTACT_BUTTON_MASK: u32 = 0x01;

fn orientation_to_tilt_degrees(azimuth_tenths: i32, altitude_tenths: i32) -> (f32, f32) {
    let azimuth_rad = (azimuth_tenths as f32 / WINTAB_ANGLE_TENTHS_PER_DEGREE).to_radians();
    let altitude_rad = (altitude_tenths as f32 / WINTAB_ANGLE_TENTHS_PER_DEGREE).to_radians();

    let axis_xy = altitude_rad.cos();
    let axis_z = altitude_rad.sin();
    let axis_x = azimuth_rad.cos() * axis_xy;
    let axis_y = azimuth_rad.sin() * axis_xy;

    let tilt_x = axis_x.atan2(axis_z).to_degrees();
    let tilt_y = axis_y.atan2(axis_z).to_degrees();
    (clamp_tilt_deg(tilt_x), clamp_tilt_deg(tilt_y))
}

#[derive(Debug)]
pub struct WinTabAdapter {
    pointer_id: u32,
    device_id: String,
    pressure_max: f32,
    mapper: CoordinateMapper,
    phase_machine: PhaseMachine,
    timebase: MonotonicTimebase,
}

impl WinTabAdapter {
    pub fn new(
        pointer_id: u32,
        device_id: String,
        pressure_max: f32,
        mapper: CoordinateMapper,
    ) -> Self {
        Self {
            pointer_id,
            device_id,
            pressure_max: pressure_max.max(1.0),
            mapper,
            phase_machine: PhaseMachine::new(),
            timebase: MonotonicTimebase::new(),
        }
    }

    #[cfg(target_os = "windows")]
    pub fn convert_packet(
        &mut self,
        packet: &Packet,
        host_time_us: u64,
    ) -> Option<NativeTabletEventV3> {
        let proximity_bit = packet.pkStatus.bits() & WINTAB_PROXIMITY_STATUS_BIT != 0;
        let contact_bit = packet.pkButtons.0 & WINTAB_CONTACT_BUTTON_MASK != 0;
        let normalized_pressure =
            clamp_pressure_0_1(packet.pkNormalPressure as f32 / self.pressure_max);
        let in_contact = contact_bit || normalized_pressure > 0.0;

        let phase = self
            .phase_machine
            .resolve(self.pointer_id, in_contact, proximity_bit)?;

        let (x_px, y_px) = self.mapper.map_output_xy(packet.pkXYZ.x, packet.pkXYZ.y);
        let (tilt_x_deg, tilt_y_deg) = orientation_to_tilt_degrees(
            packet.pkOrientation.orAzimuth,
            packet.pkOrientation.orAltitude,
        );
        let host_time_us = self
            .timebase
            .normalize_host_time_us(self.pointer_id, host_time_us.max(1));

        let pressure_0_1 = if phase.phase == InputPhaseV3::Up {
            0.0
        } else {
            normalized_pressure
        };

        Some(NativeTabletEventV3 {
            seq: 0,
            stroke_id: phase.stroke_id,
            pointer_id: self.pointer_id,
            device_id: self.device_id.clone(),
            source: InputSourceV3::WinTab,
            phase: phase.phase,
            x_px,
            y_px,
            pressure_0_1,
            tilt_x_deg,
            tilt_y_deg,
            rotation_deg: normalize_rotation_deg(
                packet.pkOrientation.orTwist as f32 / WINTAB_ANGLE_TENTHS_PER_DEGREE,
            ),
            host_time_us,
            device_time_us: Some((packet.pkTime as u64).saturating_mul(1000)),
        })
    }

    #[cfg(not(target_os = "windows"))]
    pub fn convert_packet(
        &mut self,
        _packet: &(),
        _host_time_us: u64,
    ) -> Option<NativeTabletEventV3> {
        None
    }

    pub fn corrected_host_time_samples(&self) -> u64 {
        self.timebase.corrected_samples()
    }
}
