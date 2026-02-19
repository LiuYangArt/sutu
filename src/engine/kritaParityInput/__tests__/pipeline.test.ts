import { describe, expect, it } from 'vitest';
import { createDefaultGlobalPressureLut } from '../core/globalPressureCurve';
import { KritaPressurePipeline } from '../pipeline/kritaPressurePipeline';

describe('KritaPressurePipeline', () => {
  it('keeps first speed at zero and emits points after segment sampling', () => {
    const pipeline = new KritaPressurePipeline({
      pressure_enabled: true,
      global_pressure_lut: createDefaultGlobalPressureLut(),
      use_device_time_for_speed: false,
      max_allowed_speed_px_per_ms: 30,
      speed_smoothing_samples: 3,
      spacing_px: 1,
      max_interval_us: 16_000,
      timed_spacing_enabled: true,
    });

    const first = pipeline.processSample({
      x_px: 10,
      y_px: 10,
      pressure_01: 0.2,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 1_000,
      device_time_us: 0,
      source: 'pointerevent',
      phase: 'down',
    });
    expect(first.paint_infos.length).toBe(0);
    expect(first.current_info.drawing_speed_01).toBe(0);

    const second = pipeline.processSample({
      x_px: 100,
      y_px: 10,
      pressure_01: 0.7,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 17_000,
      device_time_us: 0,
      source: 'pointerevent',
      phase: 'move',
    });
    expect(second.paint_infos.length).toBeGreaterThan(0);
    expect(second.current_info.pressure_01).toBeGreaterThan(0);
  });

  it('does not emit stationary move dabs when timed spacing is disabled', () => {
    const pipeline = new KritaPressurePipeline({
      pressure_enabled: true,
      global_pressure_lut: createDefaultGlobalPressureLut(),
      use_device_time_for_speed: false,
      max_allowed_speed_px_per_ms: 30,
      speed_smoothing_samples: 3,
      spacing_px: 10_000,
      max_interval_us: 4_000,
      timed_spacing_enabled: false,
    });

    pipeline.processSample({
      x_px: 20,
      y_px: 20,
      pressure_01: 0.6,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 1_000,
      device_time_us: 1_000,
      source: 'pointerevent',
      phase: 'down',
    });

    const move = pipeline.processSample({
      x_px: 20,
      y_px: 20,
      pressure_01: 0.6,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 21_000,
      device_time_us: 21_000,
      source: 'pointerevent',
      phase: 'move',
    });

    expect(move.paint_infos.length).toBe(0);

    const up = pipeline.processSample({
      x_px: 20,
      y_px: 20,
      pressure_01: 0,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 22_000,
      device_time_us: 22_000,
      source: 'pointerevent',
      phase: 'up',
    });
    expect(up.paint_infos.length).toBeGreaterThan(0);
    expect(up.paint_infos[up.paint_infos.length - 1]?.pressure_01).toBe(0);
  });

  it('consumes pointerup tail in processSample and avoids duplicate finalize dab', () => {
    const pipeline = new KritaPressurePipeline({
      pressure_enabled: true,
      global_pressure_lut: createDefaultGlobalPressureLut(),
      use_device_time_for_speed: false,
      max_allowed_speed_px_per_ms: 30,
      speed_smoothing_samples: 3,
      spacing_px: 2,
      max_interval_us: 16_000,
      timed_spacing_enabled: true,
    });

    pipeline.processSample({
      x_px: 10,
      y_px: 10,
      pressure_01: 0.4,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 1_000,
      device_time_us: 0,
      source: 'pointerevent',
      phase: 'down',
    });
    const up = pipeline.processSample({
      x_px: 20,
      y_px: 20,
      pressure_01: 0,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 20_000,
      device_time_us: 0,
      source: 'pointerevent',
      phase: 'up',
    });
    expect(up.paint_infos.length).toBeGreaterThan(0);
    expect(up.paint_infos[up.paint_infos.length - 1]?.pressure_01).toBe(0);

    const finalize = pipeline.finalize();
    expect(finalize.length).toBe(0);
  });
});
