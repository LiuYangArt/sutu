import type { StrokeCaptureData } from '@/test/StrokeCapture';
import {
  disablePressureToPressureEnabled,
  pressureEnabledToDisablePressure,
} from '../bridge/disablePressureBridge';
import { combineCurveOption, type CurveCombineMode } from '../core/curveOptionCombiner';
import {
  evaluateDynamicSensor,
  type DynamicSensorConfig,
  type DynamicSensorDomain,
  type DynamicSensorInput,
} from '../core/dynamicSensor';
import {
  createDefaultGlobalPressureLut,
  sampleGlobalPressureCurve,
} from '../core/globalPressureCurve';
import { PaintInfoBuilder } from '../core/paintInfoBuilder';
import { mixPaintInfo } from '../core/paintInfoMix';
import { KritaSegmentSampler } from '../core/segmentSampler';
import type { GateArtifact, GateStatus, PaintInfo, RawInputSample } from '../core/types';
import { clamp01, normalizeInputSource } from '../core/types';
import { KritaPressurePipeline } from '../pipeline/kritaPressurePipeline';

type Metrics = Record<string, number | boolean>;

type SemanticCheckName =
  | 'no_start_distance_gate'
  | 'no_start_transition_ramp'
  | 'no_forced_zero_initial_pressure_non_buildup'
  | 'linear_mix_pressure_speed_time'
  | 'pointerup_finalize_consumes_pending_segment'
  | 'disable_pressure_bridge_matches_contract';

type SemanticChecks = Record<SemanticCheckName, GateStatus>;

interface GateThresholds {
  stage: {
    pressure_curve_mae_max: number;
    pressure_curve_p95_max: number;
    speed_mae_max: number;
    speed_p95_max: number;
    dab_count_delta_max: number;
    carry_distance_error_px_max: number;
    carry_time_error_ms_max: number;
    pressure_mix_mae_max: number;
    speed_mix_mae_max: number;
    time_mix_mae_us_max: number;
    sensor_value_mae_max: number;
    sensor_value_p95_max: number;
    combiner_output_mae_max: number;
    combiner_output_p95_max: number;
  };
  final: {
    width_profile_delta_max: number;
    tail_decay_delta_max: number;
    pixel_roi_delta_max: number;
  };
  fast: {
    fast_window_min_required: number;
    fast_speed_p95_max: number;
    fast_speed_mae_max: number;
  };
  preset: {
    sensor_map_mae_max: number;
    sensor_map_p95_max: number;
    combiner_output_mae_max: number;
    combiner_output_p95_max: number;
  };
}

export interface KritaPressureCaseResult {
  case_id: string;
  case_name: string;
  sample_count: number;
  dab_count: number;
  stage_metrics: Metrics;
  final_metrics: Metrics;
  fast_windows_metrics: Metrics;
  stage_gate: GateStatus;
  final_gate: GateStatus;
  fast_gate: GateStatus;
  overall: GateStatus;
  blocking_failures: string[];
}

export interface KritaPressurePresetResult {
  preset_id: string;
  preset_name: string;
  case_results: Record<string, GateStatus>;
  sensor_map_mae: number;
  sensor_map_p95: number;
  combiner_output_mae: number;
  combiner_output_p95: number;
  stage_gate: GateStatus;
  final_gate: GateStatus;
  fast_gate: GateStatus;
  overall: GateStatus;
  blocking_failures: string[];
}

export interface KritaPressureGateOptions {
  baseline_version: string;
  threshold_version?: string;
  env?: {
    krita_version: string;
    tablet: string;
    os: string;
  };
}

export interface KritaPressureGateResult extends GateArtifact {}

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

const DEFAULT_THRESHOLDS: GateThresholds = {
  stage: {
    pressure_curve_mae_max: 0.02,
    pressure_curve_p95_max: 0.04,
    speed_mae_max: 0.03,
    speed_p95_max: 0.06,
    dab_count_delta_max: 2,
    carry_distance_error_px_max: 1.5,
    carry_time_error_ms_max: 2,
    pressure_mix_mae_max: 0.02,
    speed_mix_mae_max: 0.03,
    time_mix_mae_us_max: 1500,
    sensor_value_mae_max: 0.02,
    sensor_value_p95_max: 0.04,
    combiner_output_mae_max: 0.03,
    combiner_output_p95_max: 0.06,
  },
  final: {
    width_profile_delta_max: 0.05,
    tail_decay_delta_max: 0.07,
    pixel_roi_delta_max: 0.12,
  },
  fast: {
    fast_window_min_required: 1,
    fast_speed_p95_max: 1,
    fast_speed_mae_max: 0.04,
  },
  preset: {
    sensor_map_mae_max: 0.02,
    sensor_map_p95_max: 0.04,
    combiner_output_mae_max: 0.03,
    combiner_output_p95_max: 0.06,
  },
};

const CASES = [
  { id: 'A', name: 'slow_lift' },
  { id: 'B', name: 'fast_flick' },
  { id: 'C', name: 'abrupt_stop' },
  { id: 'D', name: 'low_pressure_drag' },
  { id: 'E', name: 'first_point_boundary' },
  { id: 'F', name: 'final_point_boundary' },
  { id: 'G', name: 'near_zero_pressure_jitter' },
  { id: 'H', name: 'timestamp_jump' },
] as const;

function createSensorLut(size: number = 256): Float32Array {
  const n = Math.max(2, Math.floor(size));
  const lut = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    lut[i] = clamp01(0.92 * Math.pow(t, 0.85) + 0.08 * t);
  }
  return lut;
}

const PRESETS: Array<{
  id: string;
  name: string;
  mode: CurveCombineMode;
  sensors: DynamicSensorConfig[];
}> = [
  {
    id: 'P0_pressure_size_multiply',
    name: 'pressure -> size (multiply)',
    mode: 'multiply',
    sensors: [
      { enabled: true, input: 'pressure', domain: 'scaling', curve_lut: createSensorLut() },
    ],
  },
  {
    id: 'P1_pressure_flow_opacity',
    name: 'pressure -> flow+opacity',
    mode: 'multiply',
    sensors: [
      { enabled: true, input: 'pressure', domain: 'scaling', curve_lut: createSensorLut() },
      { enabled: true, input: 'pressure', domain: 'additive', curve_lut: createSensorLut() },
    ],
  },
  {
    id: 'P2_speed_sensor',
    name: 'speed sensor',
    mode: 'multiply',
    sensors: [{ enabled: true, input: 'speed', domain: 'scaling', curve_lut: createSensorLut() }],
  },
  {
    id: 'P3_combiner_modes',
    name: 'combiner difference',
    mode: 'difference',
    sensors: [
      { enabled: true, input: 'pressure', domain: 'scaling', curve_lut: createSensorLut() },
      { enabled: true, input: 'speed', domain: 'scaling', curve_lut: createSensorLut() },
    ],
  },
  {
    id: 'P4_low_pressure_micro',
    name: 'low pressure near zero',
    mode: 'min',
    sensors: [
      { enabled: true, input: 'pressure', domain: 'scaling', curve_lut: createSensorLut() },
      { enabled: true, input: 'time', domain: 'scaling', curve_lut: createSensorLut() },
    ],
  },
];

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toRawSamples(capture: StrokeCaptureData): {
  samples: RawInputSample[];
  pressure_clamp_violation_count: number;
  source_alias_unresolved_count: number;
  timestamp_non_monotonic_count: number;
  timestamp_jump_count: number;
} {
  const samples: RawInputSample[] = [];
  let pressureClamp = 0;
  let sourceAlias = 0;
  let nonMonotonic = 0;
  let timestampJump = 0;
  let lastTimeUs: number | null = null;

  for (let i = 0; i < capture.samples.length; i += 1) {
    const s = capture.samples[i]!;
    if (!Number.isFinite(s.pressure) || s.pressure < 0 || s.pressure > 1) {
      pressureClamp += 1;
    }
    const source = normalizeInputSource(s.pointerType);
    const resolvedSource = source ?? 'pointerevent';
    if (!source && !['pen', 'mouse', 'touch'].includes(s.pointerType.toLowerCase())) {
      sourceAlias += 1;
    }
    const hostUs = Math.max(0, Math.round(s.timeMs * 1000));
    if (lastTimeUs !== null) {
      if (hostUs < lastTimeUs) nonMonotonic += 1;
      if (hostUs - lastTimeUs > 500_000) timestampJump += 1;
    }
    lastTimeUs = hostUs;
    samples.push({
      x_px: s.x,
      y_px: s.y,
      pressure_01: clamp01(s.pressure),
      tilt_x_deg: s.tiltX,
      tilt_y_deg: s.tiltY,
      rotation_deg: 0,
      host_time_us: hostUs,
      device_time_us: hostUs,
      source: resolvedSource,
      phase:
        s.type === 'pointerdown'
          ? 'down'
          : s.type === 'pointerup' || s.type === 'pointercancel'
            ? 'up'
            : 'move',
      seq: i,
    });
  }

  return {
    samples,
    pressure_clamp_violation_count: pressureClamp,
    source_alias_unresolved_count: sourceAlias,
    timestamp_non_monotonic_count: nonMonotonic,
    timestamp_jump_count: timestampJump,
  };
}

function spacingPx(capture: StrokeCaptureData): number {
  const size = Math.max(1, asNumber(capture.metadata.tool.brushSize, 12));
  const spacing = Math.max(0.01, Math.min(10, asNumber(capture.metadata.tool.brushSpacing, 0.1)));
  return Math.max(0.5, size * spacing);
}

function maxIntervalUs(capture: StrokeCaptureData): number {
  const intervalMs = Math.max(
    8,
    Math.min(40, asNumber(capture.metadata.tool.brushSpacing, 0.1) * 20)
  );
  return Math.round(intervalMs * 1000);
}

function runPipeline(
  samples: RawInputSample[],
  spacing: number,
  intervalUs: number,
  lut: Float32Array
): { current: PaintInfo[]; dabs: PaintInfo[] } {
  const pipeline = new KritaPressurePipeline({
    pressure_enabled: true,
    global_pressure_lut: lut,
    use_device_time_for_speed: false,
    max_allowed_speed_px_per_ms: 30,
    speed_smoothing_samples: 3,
    spacing_px: spacing,
    max_interval_us: intervalUs,
  });
  const current: PaintInfo[] = [];
  const dabs: PaintInfo[] = [];
  for (const sample of samples) {
    const out = pipeline.processSample(sample);
    current.push(out.current_info);
    dabs.push(...out.paint_infos);
  }
  dabs.push(...pipeline.finalize());
  return { current, dabs };
}

function runReference(
  samples: RawInputSample[],
  spacing: number,
  intervalUs: number,
  lut: Float32Array
): { current: PaintInfo[]; dabs: PaintInfo[] } {
  const builder = new PaintInfoBuilder({
    pressure_enabled: true,
    global_pressure_lut: lut,
    use_device_time_for_speed: false,
    max_allowed_speed_px_per_ms: 30,
    speed_smoothing_samples: 3,
  });
  const sampler = new KritaSegmentSampler();
  const current: PaintInfo[] = [];
  const dabs: PaintInfo[] = [];
  let prev: PaintInfo | null = null;
  let lastPhase: RawInputSample['phase'] | null = null;
  let seenPointerUp = false;
  let emittedDabCount = 0;
  for (const sample of samples) {
    const info = builder.build(sample).info;
    current.push(info);
    const phase = sample.phase;
    if (!prev) {
      prev = info;
      lastPhase = phase;
      seenPointerUp = phase === 'up';
      if (phase === 'up') {
        dabs.push(info);
        emittedDabCount += 1;
      }
      continue;
    }
    const distance = Math.hypot(info.x_px - prev.x_px, info.y_px - prev.y_px);
    const duration = Math.max(0, info.time_us - prev.time_us);
    const ts = sampler.sampleSegment({
      distance_px: distance,
      duration_us: duration,
      spacing_px: spacing,
      max_interval_us: intervalUs,
    });
    const mixed: PaintInfo[] = [];
    if (ts.length > 0) {
      mixed.push(...ts.map((t) => mixPaintInfo(prev!, info, t)));
    } else if (distance <= 1e-6 && duration <= 1e-6 && phase === 'up') {
      mixed.push(info);
    }

    if (phase === 'up') {
      const tail = mixed[mixed.length - 1];
      const needsAppendTerminal =
        !tail ||
        Math.abs(tail.x_px - info.x_px) > 1e-6 ||
        Math.abs(tail.y_px - info.y_px) > 1e-6 ||
        Math.abs(tail.time_us - info.time_us) > 1;
      if (needsAppendTerminal) {
        mixed.push(info);
      }
    }

    dabs.push(...mixed);
    emittedDabCount += mixed.length;
    prev = info;
    lastPhase = phase;
    seenPointerUp = seenPointerUp || phase === 'up';
  }
  if (prev) {
    const shouldEmitFinal = emittedDabCount === 0 || (!seenPointerUp && lastPhase !== 'up');
    if (shouldEmitFinal) {
      dabs.push(prev);
    }
  }
  return { current, dabs };
}

function metricErrors(
  left: number[],
  right: number[],
  mismatchPenalty: number
): { mae: number; p95: number } {
  const count = Math.min(left.length, right.length);
  const errors: number[] = [];
  for (let i = 0; i < count; i += 1) {
    errors.push(Math.abs((left[i] ?? 0) - (right[i] ?? 0)));
  }
  if (left.length !== right.length) {
    errors.push(mismatchPenalty);
  }
  return { mae: mean(errors), p95: p95(errors) };
}

function localSensor(info: PaintInfo, config: DynamicSensorConfig): number {
  const readInput = (input: DynamicSensorInput): number => {
    if (input === 'pressure') return info.pressure_01;
    if (input === 'speed') return info.drawing_speed_01;
    return clamp01(info.time_us / 1_000_000);
  };
  const toDomain = (value: number, domain: DynamicSensorDomain): number => {
    if (domain === 'additive') return clamp01((value + 1) * 0.5);
    if (domain === 'absolute_rotation') return clamp01((((value % 360) + 360) % 360) / 360);
    return clamp01(value);
  };
  const fromDomain = (value: number, domain: DynamicSensorDomain): number => {
    if (domain === 'additive') return value * 2 - 1;
    if (domain === 'absolute_rotation') return value * 360;
    return clamp01(value);
  };

  const domain = config.domain ?? 'scaling';
  const base = toDomain(readInput(config.input), domain);
  const lut = config.curve_lut;
  if (!lut || lut.length < 2) return fromDomain(base, domain);
  const pos = clamp01(base) * (lut.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lut.length - 1, lo + 1);
  const t = pos - lo;
  const mapped = (lut[lo] ?? 0) + ((lut[hi] ?? 0) - (lut[lo] ?? 0)) * t;
  return fromDomain(clamp01(mapped), domain);
}

function sensorCombinerMetrics(dabs: PaintInfo[]): {
  sensor_value_mae: number;
  sensor_value_p95: number;
  combiner_output_mae: number;
  combiner_output_p95: number;
} {
  const sensorErrors: number[] = [];
  const combinerErrors: number[] = [];
  const sensorA: DynamicSensorConfig = {
    enabled: true,
    input: 'pressure',
    domain: 'scaling',
    curve_lut: createSensorLut(),
  };
  const sensorB: DynamicSensorConfig = {
    enabled: true,
    input: 'speed',
    domain: 'additive',
    curve_lut: createSensorLut(),
  };
  for (const info of dabs) {
    const a0 = evaluateDynamicSensor(info, sensorA);
    const a1 = localSensor(info, sensorA);
    const b0 = evaluateDynamicSensor(info, sensorB);
    const b1 = localSensor(info, sensorB);
    sensorErrors.push(Math.abs(a0 - a1), Math.abs(b0 - b1));

    const c0 = combineCurveOption({
      constant: 1,
      values: [a0, b0],
      mode: 'multiply',
      min: 0,
      max: 1,
    });
    const c1 = clamp01(a1 * b1);
    combinerErrors.push(Math.abs(c0 - c1));
  }
  return {
    sensor_value_mae: mean(sensorErrors),
    sensor_value_p95: p95(sensorErrors),
    combiner_output_mae: mean(combinerErrors),
    combiner_output_p95: p95(combinerErrors),
  };
}

function splitCases(samples: RawInputSample[]): Record<string, RawInputSample[]> {
  const out: Record<string, RawInputSample[]> = {};
  for (const c of CASES) out[c.id] = [];
  if (samples.length === 0) return out;

  const range = (startRatio: number, endRatio: number): RawInputSample[] => {
    const start = Math.floor(samples.length * startRatio);
    const end = Math.max(start + 1, Math.ceil(samples.length * endRatio));
    return samples.slice(start, Math.min(end, samples.length));
  };

  out.A = range(0.55, 1);
  out.C = range(0.78, 1);
  out.E = samples.slice(0, Math.min(8, samples.length));
  out.F = samples.slice(Math.max(0, samples.length - 8));
  out.D = samples.filter((s) => s.pressure_01 <= 0.2);
  out.G = samples.filter((s) => s.pressure_01 <= 0.05);

  const speedPairs: Array<{ index: number; speed: number }> = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dt = Math.max(0.0001, (samples[i]!.host_time_us - samples[i - 1]!.host_time_us) / 1000);
    speedPairs.push({
      index: i,
      speed:
        Math.hypot(
          samples[i]!.x_px - samples[i - 1]!.x_px,
          samples[i]!.y_px - samples[i - 1]!.y_px
        ) / dt,
    });
  }
  const threshold = p95(speedPairs.map((v) => v.speed));
  const fastIndices = new Set(speedPairs.filter((v) => v.speed >= threshold).map((v) => v.index));
  out.B = samples.filter((_, i) => fastIndices.has(i));

  out.H = samples.map((s) => ({ ...s }));
  if (out.H.length > 3) {
    const start = Math.floor(out.H.length * 0.6);
    for (let i = start; i < out.H.length; i += 1) {
      out.H[i] = {
        ...out.H[i]!,
        host_time_us: out.H[i]!.host_time_us + 700_000,
        device_time_us: out.H[i]!.device_time_us + 700_000,
      };
    }
  }

  for (const c of CASES) {
    const caseSamples = out[c.id] ?? [];
    if (caseSamples.length < 2) out[c.id] = samples.slice();
  }

  return out;
}

function gateDecision(
  stage: Metrics,
  final: Metrics,
  fast: Metrics,
  semantic: SemanticChecks | null,
  t: GateThresholds
): { stage_gate: GateStatus; final_gate: GateStatus; fast_gate: GateStatus } {
  const semanticFail = semantic
    ? Object.values(semantic).some((status) => status !== 'pass')
    : false;
  const stageFail =
    semanticFail ||
    asNumber(stage.pressure_clamp_violation_count, 0) > 0 ||
    asNumber(stage.source_alias_unresolved_count, 0) > 0 ||
    asNumber(stage.timestamp_non_monotonic_count, 0) > 0 ||
    stage.speed_first_point_is_zero !== true ||
    asNumber(stage.pressure_curve_mae, 0) > t.stage.pressure_curve_mae_max ||
    asNumber(stage.pressure_curve_p95, 0) > t.stage.pressure_curve_p95_max ||
    asNumber(stage.speed_mae, 0) > t.stage.speed_mae_max ||
    asNumber(stage.speed_p95, 0) > t.stage.speed_p95_max ||
    asNumber(stage.dab_count_delta, 0) > t.stage.dab_count_delta_max ||
    asNumber(stage.carry_distance_error_px, 0) > t.stage.carry_distance_error_px_max ||
    asNumber(stage.carry_time_error_ms, 0) > t.stage.carry_time_error_ms_max ||
    asNumber(stage.pressure_mix_mae, 0) > t.stage.pressure_mix_mae_max ||
    asNumber(stage.speed_mix_mae, 0) > t.stage.speed_mix_mae_max ||
    asNumber(stage.time_mix_mae_us, 0) > t.stage.time_mix_mae_us_max ||
    asNumber(stage.sensor_value_mae, 0) > t.stage.sensor_value_mae_max ||
    asNumber(stage.sensor_value_p95, 0) > t.stage.sensor_value_p95_max ||
    asNumber(stage.combiner_output_mae, 0) > t.stage.combiner_output_mae_max ||
    asNumber(stage.combiner_output_p95, 0) > t.stage.combiner_output_p95_max;
  const finalFail =
    asNumber(final.width_profile_delta, 0) > t.final.width_profile_delta_max ||
    asNumber(final.tail_decay_delta, 0) > t.final.tail_decay_delta_max ||
    asNumber(final.pixel_roi_delta, 0) > t.final.pixel_roi_delta_max;
  const fastFail =
    asNumber(fast.fast_window_count, 0) <
      asNumber(fast.fast_window_min_required, t.fast.fast_window_min_required) ||
    asNumber(fast.fast_speed_p95, 0) > t.fast.fast_speed_p95_max ||
    asNumber(fast.fast_speed_mae, 0) > t.fast.fast_speed_mae_max;

  return {
    stage_gate: stageFail ? 'fail' : 'pass',
    final_gate: finalFail ? 'fail' : 'pass',
    fast_gate: fastFail ? 'fail' : 'pass',
  };
}

export function runKritaPressureGate(
  capture: StrokeCaptureData,
  options: KritaPressureGateOptions
): KritaPressureGateResult {
  const runId = `kp_${Date.now().toString(36)}`;
  const thresholds = DEFAULT_THRESHOLDS;
  const lut = createDefaultGlobalPressureLut();
  const normalized = toRawSamples(capture);
  const spacing = spacingPx(capture);
  const intervalUs = maxIntervalUs(capture);
  const pipeline = runPipeline(normalized.samples, spacing, intervalUs, lut);
  const reference = runReference(normalized.samples, spacing, intervalUs, lut);

  const pressureExpected = normalized.samples.map((sample) =>
    sampleGlobalPressureCurve(lut, sample.pressure_01)
  );
  const pressureActual = pipeline.current.map((info) => info.pressure_01);
  const pressureError = metricErrors(pressureActual, pressureExpected, 0.05);

  const speedBuilder = new PaintInfoBuilder({
    pressure_enabled: true,
    global_pressure_lut: lut,
    use_device_time_for_speed: false,
    max_allowed_speed_px_per_ms: 30,
    speed_smoothing_samples: 3,
  });
  const speedExpected = normalized.samples.map(
    (sample) => speedBuilder.build(sample).info.drawing_speed_01
  );
  const speedActual = pipeline.current.map((info) => info.drawing_speed_01);
  const speedError = metricErrors(speedActual, speedExpected, 0.05);

  const mixPressure = metricErrors(
    pipeline.dabs.map((dab) => dab.pressure_01),
    reference.dabs.map((dab) => dab.pressure_01),
    1
  ).mae;
  const mixSpeed = metricErrors(
    pipeline.dabs.map((dab) => dab.drawing_speed_01),
    reference.dabs.map((dab) => dab.drawing_speed_01),
    1
  ).mae;
  const mixTime = metricErrors(
    pipeline.dabs.map((dab) => dab.time_us),
    reference.dabs.map((dab) => dab.time_us),
    50_000
  ).mae;

  const sensor = sensorCombinerMetrics(pipeline.dabs);

  const carryDistance = (() => {
    if (pipeline.current.length < 2) return 0;
    let totalDistance = 0;
    for (let i = 1; i < pipeline.current.length; i += 1) {
      const prev = pipeline.current[i - 1]!;
      const curr = pipeline.current[i]!;
      totalDistance += Math.hypot(curr.x_px - prev.x_px, curr.y_px - prev.y_px);
    }
    const expectedCarry = spacing > 0 ? totalDistance % spacing : 0;
    const tail = pipeline.dabs[pipeline.dabs.length - 1];
    const last = pipeline.current[pipeline.current.length - 1];
    if (!tail || !last) return expectedCarry;
    const actualCarry = Math.hypot(last.x_px - tail.x_px, last.y_px - tail.y_px);
    return Math.abs(actualCarry - expectedCarry);
  })();

  const carryTimeMs = (() => {
    if (pipeline.current.length < 2) return 0;
    const first = pipeline.current[0]!;
    const last = pipeline.current[pipeline.current.length - 1]!;
    const expectedCarry =
      intervalUs > 0 ? Math.max(0, last.time_us - first.time_us) % intervalUs : 0;
    const tail = pipeline.dabs[pipeline.dabs.length - 1];
    const actualCarry = tail ? Math.max(0, last.time_us - tail.time_us) : expectedCarry;
    return Math.abs(actualCarry - expectedCarry) / 1000;
  })();

  const stageMetrics: Metrics = {
    pressure_clamp_violation_count: normalized.pressure_clamp_violation_count,
    source_alias_unresolved_count: normalized.source_alias_unresolved_count,
    timestamp_non_monotonic_count: normalized.timestamp_non_monotonic_count,
    speed_first_point_is_zero: (pipeline.current[0]?.drawing_speed_01 ?? 0) === 0,
    pressure_curve_mae: pressureError.mae,
    pressure_curve_p95: pressureError.p95,
    speed_mae: speedError.mae,
    speed_p95: speedError.p95,
    dab_count_delta: Math.abs(pipeline.dabs.length - reference.dabs.length),
    carry_distance_error_px: carryDistance,
    carry_time_error_ms: carryTimeMs,
    pressure_mix_mae: mixPressure,
    speed_mix_mae: mixSpeed,
    time_mix_mae_us: mixTime,
    sensor_value_mae: sensor.sensor_value_mae,
    sensor_value_p95: sensor.sensor_value_p95,
    combiner_output_mae: sensor.combiner_output_mae,
    combiner_output_p95: sensor.combiner_output_p95,
    timestamp_jump_count: normalized.timestamp_jump_count,
  };

  const baseSize = Math.max(1, asNumber(capture.metadata.tool.brushSize, 12));
  const finalMetrics: Metrics = {
    width_profile_delta: metricErrors(
      pipeline.dabs.map((dab) => dab.pressure_01 * baseSize),
      reference.dabs.map((dab) => dab.pressure_01 * baseSize),
      baseSize * 0.1
    ).mae,
    tail_decay_delta: Math.abs(
      mean(
        pipeline.dabs
          .slice(-Math.max(1, Math.floor(pipeline.dabs.length * 0.2)))
          .map((dab) => dab.pressure_01)
      ) -
        mean(
          reference.dabs
            .slice(-Math.max(1, Math.floor(reference.dabs.length * 0.2)))
            .map((dab) => dab.pressure_01)
        )
    ),
    pixel_roi_delta: (() => {
      const area = (dabs: PaintInfo[]): number => {
        if (dabs.length === 0) return 0;
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const dab of dabs) {
          const radius = Math.max(0.5, baseSize * dab.pressure_01 * 0.5);
          minX = Math.min(minX, dab.x_px - radius);
          minY = Math.min(minY, dab.y_px - radius);
          maxX = Math.max(maxX, dab.x_px + radius);
          maxY = Math.max(maxY, dab.y_px + radius);
        }
        return Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
      };
      const areaPipeline = area(pipeline.dabs);
      const areaReference = area(reference.dabs);
      return areaPipeline <= 0 && areaReference <= 0
        ? 0
        : Math.abs(areaPipeline - areaReference) / Math.max(areaPipeline, areaReference, 1);
    })(),
  };

  const speeds = pipeline.current.map((info) => info.drawing_speed_01);
  const fastThreshold = Math.max(0.75, p95(speeds));
  const fastIndices = speeds
    .map((speed, index) => ({ speed, index }))
    .filter((item) => item.speed >= fastThreshold)
    .map((item) => item.index);
  const fastMetrics: Metrics = {
    fast_window_count: fastIndices.length,
    fast_window_min_required: thresholds.fast.fast_window_min_required,
    fast_speed_p95: p95(fastIndices.map((index) => speeds[index] ?? 0)),
    fast_speed_mae: mean(
      fastIndices.map((index) =>
        Math.abs(
          (pipeline.current[index]?.drawing_speed_01 ?? 0) -
            (reference.current[index]?.drawing_speed_01 ?? 0)
        )
      )
    ),
  };

  const firstInput = normalized.samples[0];
  const firstDab = pipeline.dabs[0];
  const lastInput = normalized.samples[normalized.samples.length - 1];
  const lastDab = pipeline.dabs[pipeline.dabs.length - 1];
  const semanticChecks: SemanticChecks = {
    no_start_distance_gate: pipeline.dabs.length > 0 ? 'pass' : 'fail',
    no_start_transition_ramp:
      Math.abs((firstDab?.pressure_01 ?? 0) - (firstInput?.pressure_01 ?? 0)) <= 0.08
        ? 'pass'
        : 'fail',
    no_forced_zero_initial_pressure_non_buildup:
      (firstInput?.pressure_01 ?? 0) <= 1e-4 || (firstDab?.pressure_01 ?? 0) > 1e-4
        ? 'pass'
        : 'fail',
    linear_mix_pressure_speed_time:
      asNumber(stageMetrics.pressure_mix_mae, 1) <= 0.08 &&
      asNumber(stageMetrics.speed_mix_mae, 1) <= 0.08 &&
      asNumber(stageMetrics.time_mix_mae_us, 50_000) <= 10_000
        ? 'pass'
        : 'fail',
    pointerup_finalize_consumes_pending_segment:
      lastInput && lastDab
        ? Math.hypot(lastDab.x_px - lastInput.x_px, lastDab.y_px - lastInput.y_px) <= 6 &&
          lastDab.time_us >= lastInput.host_time_us - 5000
          ? 'pass'
          : 'fail'
        : 'fail',
    disable_pressure_bridge_matches_contract:
      disablePressureToPressureEnabled(false) === false &&
      disablePressureToPressureEnabled(true) === true &&
      pressureEnabledToDisablePressure(false) === false &&
      pressureEnabledToDisablePressure(true) === true
        ? 'pass'
        : 'fail',
  };

  const caseSamples = splitCases(normalized.samples);
  const caseResults: KritaPressureCaseResult[] = CASES.map((caseDef) => {
    const samples = caseSamples[caseDef.id] ?? normalized.samples;
    const casePipeline = runPipeline(samples, spacing, intervalUs, lut);
    const caseReference = runReference(samples, spacing, intervalUs, lut);
    const caseStage: Metrics = {
      ...stageMetrics,
      dab_count_delta: Math.abs(casePipeline.dabs.length - caseReference.dabs.length),
      pressure_mix_mae: metricErrors(
        casePipeline.dabs.map((dab) => dab.pressure_01),
        caseReference.dabs.map((dab) => dab.pressure_01),
        1
      ).mae,
      speed_mix_mae: metricErrors(
        casePipeline.dabs.map((dab) => dab.drawing_speed_01),
        caseReference.dabs.map((dab) => dab.drawing_speed_01),
        1
      ).mae,
      time_mix_mae_us: metricErrors(
        casePipeline.dabs.map((dab) => dab.time_us),
        caseReference.dabs.map((dab) => dab.time_us),
        50_000
      ).mae,
      timestamp_non_monotonic_count: samples
        .slice(1)
        .filter((sample, index) => sample.host_time_us < samples[index]!.host_time_us).length,
    };
    const caseFinal: Metrics = {
      width_profile_delta: metricErrors(
        casePipeline.dabs.map((dab) => dab.pressure_01 * baseSize),
        caseReference.dabs.map((dab) => dab.pressure_01 * baseSize),
        baseSize * 0.1
      ).mae,
      tail_decay_delta: Math.abs(
        mean(
          casePipeline.dabs
            .slice(-Math.max(1, Math.floor(casePipeline.dabs.length * 0.2)))
            .map((dab) => dab.pressure_01)
        ) -
          mean(
            caseReference.dabs
              .slice(-Math.max(1, Math.floor(caseReference.dabs.length * 0.2)))
              .map((dab) => dab.pressure_01)
          )
      ),
      pixel_roi_delta: 0,
    };
    const caseSpeeds = casePipeline.current.map((info) => info.drawing_speed_01);
    const caseFastThreshold = Math.max(0.75, p95(caseSpeeds));
    const caseFastIndices = caseSpeeds
      .map((speed, index) => ({ speed, index }))
      .filter((item) => item.speed >= caseFastThreshold)
      .map((item) => item.index);
    const caseFastWindowMinRequired =
      caseDef.id === 'B' || caseDef.id === 'H' ? thresholds.fast.fast_window_min_required : 0;
    const caseFast: Metrics = {
      fast_window_count: caseFastIndices.length,
      fast_window_min_required: caseFastWindowMinRequired,
      fast_speed_p95: p95(caseFastIndices.map((index) => caseSpeeds[index] ?? 0)),
      fast_speed_mae: mean(
        caseFastIndices.map((index) =>
          Math.abs(
            (casePipeline.current[index]?.drawing_speed_01 ?? 0) -
              (caseReference.current[index]?.drawing_speed_01 ?? 0)
          )
        )
      ),
    };
    const decision = gateDecision(caseStage, caseFinal, caseFast, null, thresholds);
    const overall: GateStatus =
      decision.stage_gate === 'pass' &&
      decision.final_gate === 'pass' &&
      decision.fast_gate === 'pass'
        ? 'pass'
        : 'fail';
    const blocking = [
      decision.stage_gate !== 'pass' ? 'stage_gate_failed' : '',
      decision.final_gate !== 'pass' ? 'final_gate_failed' : '',
      decision.fast_gate !== 'pass' ? 'fast_gate_failed' : '',
    ].filter(Boolean);
    return {
      case_id: caseDef.id,
      case_name: caseDef.name,
      sample_count: samples.length,
      dab_count: casePipeline.dabs.length,
      stage_metrics: caseStage,
      final_metrics: caseFinal,
      fast_windows_metrics: caseFast,
      stage_gate: decision.stage_gate,
      final_gate: decision.final_gate,
      fast_gate: decision.fast_gate,
      overall,
      blocking_failures: blocking,
    };
  });

  const presetResults: KritaPressurePresetResult[] = PRESETS.map((preset) => {
    const sensorErrors: number[] = [];
    const combinerErrors: number[] = [];
    const caseMap: Record<string, GateStatus> = {};
    for (const caseResult of caseResults) {
      const samples = caseSamples[caseResult.case_id] ?? normalized.samples;
      const dabs = runPipeline(samples, spacing, intervalUs, lut).dabs;
      const caseSensorErrors: number[] = [];
      const caseCombinerErrors: number[] = [];
      for (const info of dabs) {
        const runtimeValues = preset.sensors.map((sensor) => evaluateDynamicSensor(info, sensor));
        const expectedValues = preset.sensors.map((sensor) => localSensor(info, sensor));
        for (let i = 0; i < runtimeValues.length; i += 1) {
          caseSensorErrors.push(Math.abs((runtimeValues[i] ?? 0) - (expectedValues[i] ?? 0)));
        }
        const runtimeCombined = combineCurveOption({
          constant: 1,
          values: runtimeValues,
          mode: preset.mode,
          min: 0,
          max: 1,
        });
        const expectedCombined = clamp01(
          (() => {
            if (expectedValues.length === 0) return 1;
            let acc = expectedValues[0] ?? 1;
            for (let i = 1; i < expectedValues.length; i += 1) {
              const v = expectedValues[i] ?? 1;
              acc =
                preset.mode === 'add'
                  ? acc + v
                  : preset.mode === 'max'
                    ? Math.max(acc, v)
                    : preset.mode === 'min'
                      ? Math.min(acc, v)
                      : preset.mode === 'difference'
                        ? Math.abs(acc - v)
                        : acc * v;
            }
            return acc;
          })()
        );
        caseCombinerErrors.push(Math.abs(runtimeCombined - expectedCombined));
      }
      sensorErrors.push(...caseSensorErrors);
      combinerErrors.push(...caseCombinerErrors);
      const pass =
        mean(caseSensorErrors) <= thresholds.preset.sensor_map_mae_max &&
        p95(caseSensorErrors) <= thresholds.preset.sensor_map_p95_max &&
        mean(caseCombinerErrors) <= thresholds.preset.combiner_output_mae_max &&
        p95(caseCombinerErrors) <= thresholds.preset.combiner_output_p95_max;
      caseMap[caseResult.case_id] = pass ? 'pass' : 'fail';
    }

    const stageGate: GateStatus =
      mean(sensorErrors) <= thresholds.preset.sensor_map_mae_max &&
      p95(sensorErrors) <= thresholds.preset.sensor_map_p95_max &&
      mean(combinerErrors) <= thresholds.preset.combiner_output_mae_max &&
      p95(combinerErrors) <= thresholds.preset.combiner_output_p95_max &&
      Object.values(caseMap).every((value) => value === 'pass')
        ? 'pass'
        : 'fail';
    const blocking =
      stageGate === 'pass'
        ? []
        : [
            'preset_stage_failed',
            ...Object.entries(caseMap)
              .filter(([, status]) => status !== 'pass')
              .map(([id]) => `preset_case_failed:${id}`),
          ];
    return {
      preset_id: preset.id,
      preset_name: preset.name,
      case_results: caseMap,
      sensor_map_mae: mean(sensorErrors),
      sensor_map_p95: p95(sensorErrors),
      combiner_output_mae: mean(combinerErrors),
      combiner_output_p95: p95(combinerErrors),
      stage_gate: stageGate,
      final_gate: stageGate,
      fast_gate: stageGate,
      overall: stageGate,
      blocking_failures: blocking,
    };
  });

  const decision = gateDecision(
    stageMetrics,
    finalMetrics,
    fastMetrics,
    semanticChecks,
    thresholds
  );
  const hasCaseFailures = caseResults.some((item) => item.overall !== 'pass');
  const hasPresetFailures = presetResults.some((item) => item.overall !== 'pass');
  const overall: GateStatus =
    decision.stage_gate === 'pass' &&
    decision.final_gate === 'pass' &&
    decision.fast_gate === 'pass' &&
    !hasCaseFailures &&
    !hasPresetFailures
      ? 'pass'
      : 'fail';

  const blockingFailures = [
    decision.stage_gate !== 'pass' ? 'stage_gate_failed' : '',
    decision.final_gate !== 'pass' ? 'final_gate_failed' : '',
    decision.fast_gate !== 'pass' ? 'fast_gate_failed' : '',
    ...Object.entries(semanticChecks)
      .filter(([, status]) => status !== 'pass')
      .map(([name]) => `semantic_check_failed:${name}`),
    ...caseResults
      .filter((item) => item.overall !== 'pass')
      .map((item) => `case_failed:${item.case_id}`),
    ...presetResults
      .filter((item) => item.overall !== 'pass')
      .map((item) => `preset_failed:${item.preset_id}`),
  ].filter(Boolean);

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
    input_hash: hashString(canonicalize(capture)),
    baseline_version: options.baseline_version,
    threshold_version: options.threshold_version ?? 'krita-pressure-thresholds.v1',
    stage_metrics: stageMetrics,
    final_metrics: finalMetrics,
    fast_windows_metrics: fastMetrics,
    semantic_checks: semanticChecks,
    stage_gate: decision.stage_gate,
    final_gate: decision.final_gate,
    fast_gate: decision.fast_gate,
    overall,
    blocking_failures: blockingFailures,
    case_results: caseResults,
    preset_results: presetResults,
    summary: {
      overall,
      stage_gate: decision.stage_gate,
      final_gate: decision.final_gate,
      fast_gate: decision.fast_gate,
      blocking_failures_count: blockingFailures.length,
      case_passed: caseResults.filter((item) => item.overall === 'pass').length,
      case_total: caseResults.length,
      preset_passed: presetResults.filter((item) => item.overall === 'pass').length,
      preset_total: presetResults.length,
    },
  };
}
