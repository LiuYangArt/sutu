import { describe, expect, it } from 'vitest';
import type { GateArtifact, RawInputSample } from '../core/types';
import { normalizeInputSource } from '../core/types';

describe('krita pressure contract roundtrip', () => {
  it('normalizes source aliases from contract payload', () => {
    expect(normalizeInputSource('win_tab')).toBe('wintab');
    expect(normalizeInputSource('mac_native')).toBe('macnative');
    expect(normalizeInputSource('pointer_event')).toBe('pointerevent');
  });

  it('keeps snake_case payload for RawInputSample contract', () => {
    const payload: RawInputSample = {
      x_px: 10,
      y_px: 20,
      pressure_01: 0.5,
      tilt_x_deg: 0,
      tilt_y_deg: 0,
      rotation_deg: 0,
      device_time_us: 1000,
      host_time_us: 1000,
      source: 'wintab',
      phase: 'down',
      seq: 1,
    };

    const json = JSON.stringify(payload);
    expect(json).toContain('"x_px"');
    expect(json).not.toContain('"xPx"');
  });

  it('supports GateArtifact serialized roundtrip shape', () => {
    const artifact: GateArtifact = {
      run_meta: {
        run_id: 'kp_test',
        created_at: '2026-02-18T00:00:00.000Z',
        source_of_truth_version: ['docs/testing/krita-pressure-full-gate-spec.md'],
        env: {
          krita_version: '5.2',
          tablet: 'Wacom',
          os: 'Windows 11',
        },
      },
      input_hash: 'abc123',
      baseline_version: 'krita-5.2-default-wintab',
      threshold_version: 'krita-pressure-thresholds.v1',
      stage_metrics: { pressure_curve_mae: 0.001 },
      final_metrics: { width_profile_delta: 0.001 },
      fast_windows_metrics: { fast_window_count: 1 },
      semantic_checks: { no_start_distance_gate: 'pass' },
      stage_gate: 'pass',
      final_gate: 'pass',
      fast_gate: 'pass',
      overall: 'pass',
      blocking_failures: [],
      case_results: [],
      preset_results: [],
      summary: {
        overall: 'pass',
        stage_gate: 'pass',
        final_gate: 'pass',
        fast_gate: 'pass',
        blocking_failures_count: 0,
        case_passed: 0,
        case_total: 0,
        preset_passed: 0,
        preset_total: 0,
      },
    };

    const serialized = JSON.stringify(artifact);
    const parsed = JSON.parse(serialized) as GateArtifact;
    expect(parsed.input_hash).toBe('abc123');
    expect(parsed.stage_gate).toBe('pass');
  });
});
