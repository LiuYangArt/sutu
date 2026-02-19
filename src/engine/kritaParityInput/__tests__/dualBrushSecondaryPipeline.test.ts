import { describe, expect, it } from 'vitest';
import { createDefaultGlobalPressureLut } from '../core/globalPressureCurve';
import { DualBrushSecondaryPipeline } from '../pipeline/dualBrushSecondaryPipeline';

function createPipeline(): DualBrushSecondaryPipeline {
  return new DualBrushSecondaryPipeline({
    pressure_enabled: true,
    global_pressure_lut: createDefaultGlobalPressureLut(),
    use_device_time_for_speed: false,
    max_allowed_speed_px_per_ms: 30,
    speed_smoothing_samples: 3,
    spacing_px: 2,
    max_interval_us: 16_000,
    timed_spacing_enabled: true,
  });
}

describe('DualBrushSecondaryPipeline', () => {
  it('emits dabs by spacing on segment movement', () => {
    const pipeline = createPipeline();
    pipeline.processSample({
      x_px: 0,
      y_px: 0,
      pressure_01: 0.4,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 0,
      device_time_us: 0,
      source: 'pointerevent',
      phase: 'down',
    });

    const result = pipeline.processSample({
      x_px: 10,
      y_px: 0,
      pressure_01: 0.5,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 10_000,
      device_time_us: 10_000,
      source: 'pointerevent',
      phase: 'move',
    });

    expect(result.paint_infos.length).toBeGreaterThan(0);
    expect(result.paint_infos[0]?.x).toBeGreaterThan(0);
    expect(result.paint_infos[0]?.timeUs).toBeGreaterThan(0);
  });

  it('emits dabs by max interval when timed spacing is enabled and distance is zero', () => {
    const pipeline = createPipeline();
    pipeline.updateConfig({
      spacing_px: 10_000,
      max_interval_us: 4_000,
      timed_spacing_enabled: true,
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

    const result = pipeline.processSample({
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

    expect(result.paint_infos.length).toBeGreaterThan(0);
  });

  it('does not emit stationary move dabs when timed spacing is disabled', () => {
    const pipeline = createPipeline();
    pipeline.updateConfig({
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

    const result = pipeline.processSample({
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

    expect(result.paint_infos.length).toBe(0);
  });

  it('keeps carry across segments', () => {
    const pipeline = createPipeline();
    pipeline.updateConfig({
      spacing_px: 10,
      max_interval_us: 1_000_000,
    });

    pipeline.processSample({
      x_px: 0,
      y_px: 0,
      pressure_01: 0.5,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 0,
      device_time_us: 0,
      source: 'pointerevent',
      phase: 'down',
    });

    const first = pipeline.processSample({
      x_px: 6,
      y_px: 0,
      pressure_01: 0.5,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 8_000,
      device_time_us: 8_000,
      source: 'pointerevent',
      phase: 'move',
    });
    expect(first.paint_infos.length).toBe(0);

    const second = pipeline.processSample({
      x_px: 12,
      y_px: 0,
      pressure_01: 0.5,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 16_000,
      device_time_us: 16_000,
      source: 'pointerevent',
      phase: 'move',
    });
    expect(second.paint_infos.length).toBeGreaterThan(0);
    const hasCarryHit = second.paint_infos.some((dab) => Math.abs(dab.x - 10) < 0.2);
    expect(hasCarryHit).toBe(true);
  });

  it('consumes pointerup tail and avoids duplicate finalize dab', () => {
    const pipeline = createPipeline();
    pipeline.updateConfig({
      spacing_px: 4,
      max_interval_us: 16_000,
    });

    pipeline.processSample({
      x_px: 0,
      y_px: 0,
      pressure_01: 0.4,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 0,
      device_time_us: 0,
      source: 'pointerevent',
      phase: 'down',
    });
    pipeline.processSample({
      x_px: 6,
      y_px: 0,
      pressure_01: 0.3,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 8_000,
      device_time_us: 8_000,
      source: 'pointerevent',
      phase: 'move',
    });
    const up = pipeline.processSample({
      x_px: 10,
      y_px: 0,
      pressure_01: 0,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 16_000,
      device_time_us: 16_000,
      source: 'pointerevent',
      phase: 'up',
    });
    expect(up.paint_infos.length).toBeGreaterThan(0);
    expect(up.paint_infos[up.paint_infos.length - 1]?.pressure).toBe(0);

    const finalize = pipeline.finalize();
    expect(finalize.length).toBe(0);
  });

  it('emits final point once when stroke ends without pointerup', () => {
    const pipeline = createPipeline();

    pipeline.processSample({
      x_px: 0,
      y_px: 0,
      pressure_01: 0.4,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 0,
      device_time_us: 0,
      source: 'pointerevent',
      phase: 'down',
    });
    pipeline.processSample({
      x_px: 4,
      y_px: 0,
      pressure_01: 0.4,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      host_time_us: 8_000,
      device_time_us: 8_000,
      source: 'pointerevent',
      phase: 'move',
    });

    const finalize = pipeline.finalize();
    expect(finalize.length).toBe(1);
    expect(finalize[0]?.x).toBeCloseTo(4, 5);
    expect(finalize[0]?.timestampMs).toBeCloseTo(8, 5);
    expect(pipeline.finalize().length).toBe(0);
  });
});
