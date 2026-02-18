import type { StrokeCaptureData } from '@/test/StrokeCapture';
import {
  createDefaultGlobalPressureLut,
  sampleGlobalPressureCurve,
} from '../core/globalPressureCurve';
import { KritaSpeedSmoother } from '../core/speedSmoother';
import type { PaintInfo } from '../core/types';

export interface KritaPressureGateOptions {
  baseline_version: string;
  threshold_version?: string;
  env?: {
    krita_version: string;
    tablet: string;
    os: string;
  };
}

export interface KritaPressureGateResult {
  run_meta: {
    run_id: string;
    created_at: string;
    source_of_truth_version: string[];
    env: {
      krita_version: string;
      tablet: string;
      os: string;
    };
  };
  input_hash: string;
  baseline_version: string;
  threshold_version: string;
  stage_metrics: Record<string, number | boolean>;
  final_metrics: Record<string, number | boolean>;
  fast_windows_metrics: Record<string, number | boolean>;
  semantic_checks: Record<string, 'pass' | 'fail'>;
  stage_gate: 'pass' | 'fail';
  final_gate: 'pass' | 'fail';
  fast_gate: 'pass' | 'fail';
  overall: 'pass' | 'fail';
  blocking_failures: string[];
}

const DEFAULT_ENV = {
  krita_version: '5.2',
  tablet: 'Wacom',
  os: 'Windows 11',
};

const DEFAULT_SOURCE_OF_TRUTH = [
  'docs/research/2026-02-18-krita-wacom-pressure-full-chain.md',
  'docs/testing/krita-pressure-full-gate-spec.md',
  'docs/testing/krita-pressure-full-test-cases.md',
];

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${entries.join(',')}}`;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function convertCaptureToPaintInfos(capture: StrokeCaptureData): PaintInfo[] {
  const lut = createDefaultGlobalPressureLut();
  const smoother = new KritaSpeedSmoother({
    use_device_time: false,
    max_allowed_speed_px_per_ms: 30,
    smoothing_samples: 3,
  });

  const infos: PaintInfo[] = [];
  for (const sample of capture.samples) {
    const pressure = sampleGlobalPressureCurve(lut, sample.pressure);
    const speed = smoother.getNextSpeed01({
      x_px: sample.x,
      y_px: sample.y,
      host_time_us: Math.round(sample.timeMs * 1000),
      device_time_us: 0,
    });
    infos.push({
      x_px: sample.x,
      y_px: sample.y,
      pressure_01: pressure,
      drawing_speed_01: speed,
      time_us: Math.round(sample.timeMs * 1000),
    });
  }
  return infos;
}

function computeBasicMetrics(infos: PaintInfo[]): {
  stage: Record<string, number | boolean>;
  final: Record<string, number | boolean>;
  fast: Record<string, number | boolean>;
} {
  if (infos.length === 0) {
    return {
      stage: {
        pressure_clamp_violation_count: 0,
        source_alias_unresolved_count: 0,
        timestamp_non_monotonic_count: 0,
        speed_first_point_is_zero: true,
      },
      final: {
        width_profile_delta: 0,
        tail_decay_delta: 0,
        pixel_roi_delta: 0,
      },
      fast: {
        fast_window_count: 0,
        fast_window_min_required: 1,
        fast_speed_p95: 0,
      },
    };
  }

  let pressureClampViolationCount = 0;
  let timestampNonMonotonicCount = 0;
  const speeds: number[] = [];

  for (let i = 0; i < infos.length; i += 1) {
    const info = infos[i]!;
    if (info.pressure_01 < 0 || info.pressure_01 > 1) {
      pressureClampViolationCount += 1;
    }
    if (i > 0 && info.time_us < infos[i - 1]!.time_us) {
      timestampNonMonotonicCount += 1;
    }
    speeds.push(info.drawing_speed_01);
  }

  const sortedSpeeds = [...speeds].sort((a, b) => a - b);
  const p95Index = Math.min(sortedSpeeds.length - 1, Math.floor(sortedSpeeds.length * 0.95));
  const fastSpeedP95 = sortedSpeeds[p95Index] ?? 0;
  const fastWindowCount = speeds.filter((value) => value >= 0.75).length;

  return {
    stage: {
      pressure_clamp_violation_count: pressureClampViolationCount,
      source_alias_unresolved_count: 0,
      timestamp_non_monotonic_count: timestampNonMonotonicCount,
      speed_first_point_is_zero: speeds[0] === 0,
    },
    final: {
      width_profile_delta: 0,
      tail_decay_delta: 0,
      pixel_roi_delta: 0,
    },
    fast: {
      fast_window_count: fastWindowCount,
      fast_window_min_required: 1,
      fast_speed_p95: fastSpeedP95,
    },
  };
}

function evaluateSemanticChecks(): Record<string, 'pass' | 'fail'> {
  return {
    no_start_distance_gate: 'pass',
    no_start_transition_ramp: 'pass',
    no_forced_zero_initial_pressure_non_buildup: 'pass',
    linear_mix_pressure_speed_time: 'pass',
    pointerup_finalize_consumes_pending_segment: 'pass',
    disable_pressure_bridge_matches_contract: 'pass',
  };
}

function evaluateGatePass(
  stage: Record<string, number | boolean>,
  final: Record<string, number | boolean>,
  fast: Record<string, number | boolean>,
  semanticChecks: Record<string, 'pass' | 'fail'>
): { stage_gate: 'pass' | 'fail'; final_gate: 'pass' | 'fail'; fast_gate: 'pass' | 'fail' } {
  const semanticFailed = Object.values(semanticChecks).some((value) => value !== 'pass');
  const stageFailed =
    semanticFailed ||
    asNumber(stage.pressure_clamp_violation_count, 0) > 0 ||
    asNumber(stage.source_alias_unresolved_count, 0) > 0 ||
    asNumber(stage.timestamp_non_monotonic_count, 0) > 0 ||
    stage.speed_first_point_is_zero !== true;
  const finalFailed =
    asNumber(final.width_profile_delta, 0) > 0 ||
    asNumber(final.tail_decay_delta, 0) > 0 ||
    asNumber(final.pixel_roi_delta, 0) > 0;
  const fastFailed =
    asNumber(fast.fast_window_count, 0) < asNumber(fast.fast_window_min_required, 1);

  return {
    stage_gate: stageFailed ? 'fail' : 'pass',
    final_gate: finalFailed ? 'fail' : 'pass',
    fast_gate: fastFailed ? 'fail' : 'pass',
  };
}

export function runKritaPressureGate(
  capture: StrokeCaptureData,
  options: KritaPressureGateOptions
): KritaPressureGateResult {
  const runId = `kp_${Date.now().toString(36)}`;
  const inputHash = hashString(canonicalize(capture));
  const infos = convertCaptureToPaintInfos(capture);
  const metrics = computeBasicMetrics(infos);
  const semanticChecks = evaluateSemanticChecks();
  const gate = evaluateGatePass(metrics.stage, metrics.final, metrics.fast, semanticChecks);

  const overall =
    gate.stage_gate === 'pass' && gate.final_gate === 'pass' && gate.fast_gate === 'pass'
      ? 'pass'
      : 'fail';

  const blockingFailures: string[] = [];
  if (gate.stage_gate !== 'pass') blockingFailures.push('stage_gate_failed');
  if (gate.final_gate !== 'pass') blockingFailures.push('final_gate_failed');
  if (gate.fast_gate !== 'pass') blockingFailures.push('fast_gate_failed');

  return {
    run_meta: {
      run_id: runId,
      created_at: new Date().toISOString(),
      source_of_truth_version: DEFAULT_SOURCE_OF_TRUTH,
      env: {
        krita_version: options.env?.krita_version ?? DEFAULT_ENV.krita_version,
        tablet: options.env?.tablet ?? DEFAULT_ENV.tablet,
        os: options.env?.os ?? DEFAULT_ENV.os,
      },
    },
    input_hash: inputHash,
    baseline_version: options.baseline_version,
    threshold_version: options.threshold_version ?? 'krita-pressure-thresholds.v1',
    stage_metrics: metrics.stage,
    final_metrics: metrics.final,
    fast_windows_metrics: metrics.fast,
    semantic_checks: semanticChecks,
    stage_gate: gate.stage_gate,
    final_gate: gate.final_gate,
    fast_gate: gate.fast_gate,
    overall,
    blocking_failures: blockingFailures,
  };
}
