import { describe, expect, it } from 'vitest';
import { createDefaultGlobalPressureLut } from '../core/globalPressureCurve';
import { KritaPressurePipeline } from '../pipeline/kritaPressurePipeline';

describe('KritaPressurePipeline', () => {
  it('keeps first speed at zero and emits points', () => {
    const pipeline = new KritaPressurePipeline({
      pressure_enabled: true,
      global_pressure_lut: createDefaultGlobalPressureLut(),
      use_device_time_for_speed: false,
      max_allowed_speed_px_per_ms: 30,
      speed_smoothing_samples: 3,
      spacing_px: 1,
      max_interval_us: 16_000,
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
    expect(first.paint_infos.length).toBeGreaterThan(0);
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
});
