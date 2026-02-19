export type NormalizedInputSource = 'wintab' | 'macnative' | 'pointerevent';

export type NormalizedInputPhase = 'hover' | 'down' | 'move' | 'up';

export interface RawInputSample {
  x_px: number;
  y_px: number;
  pressure_01: number;
  tilt_x_deg: number;
  tilt_y_deg: number;
  rotation_deg: number;
  device_time_us: number;
  host_time_us: number;
  source: NormalizedInputSource;
  phase: NormalizedInputPhase;
  seq?: number;
}

export interface PaintInfo {
  x_px: number;
  y_px: number;
  pressure_01: number;
  drawing_speed_01: number;
  time_us: number;
}

export interface DabRequest {
  x_px: number;
  y_px: number;
  size_px: number;
  flow_01: number;
  opacity_01: number;
  time_us: number;
}

export interface PressureAnomalyFlags {
  timestamp_jump: boolean;
  non_monotonic_seq: boolean;
  invalid_pressure: boolean;
  source_alias_unresolved: boolean;
}

export type GateStatus = 'pass' | 'fail';

export interface GateRunMeta {
  run_id: string;
  created_at: string;
  source_of_truth_version: string[];
  env: {
    krita_version: string;
    tablet: string;
    os: string;
  };
}

export interface GateCaseResult {
  case_id: string;
  case_name: string;
  sample_count: number;
  dab_count: number;
  stage_metrics: Record<string, number | boolean>;
  final_metrics: Record<string, number | boolean>;
  fast_windows_metrics: Record<string, number | boolean>;
  stage_gate: GateStatus;
  final_gate: GateStatus;
  fast_gate: GateStatus;
  overall: GateStatus;
  blocking_failures: string[];
}

export interface GatePresetResult {
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

export interface GateArtifact {
  run_meta: GateRunMeta;
  input_hash: string;
  baseline_version: string;
  threshold_version: string;
  stage_metrics: Record<string, number | boolean>;
  final_metrics: Record<string, number | boolean>;
  fast_windows_metrics: Record<string, number | boolean>;
  semantic_checks: Record<string, GateStatus>;
  stage_gate: GateStatus;
  final_gate: GateStatus;
  fast_gate: GateStatus;
  overall: GateStatus;
  blocking_failures: string[];
  case_results: GateCaseResult[];
  preset_results: GatePresetResult[];
  summary: {
    overall: GateStatus;
    stage_gate: GateStatus;
    final_gate: GateStatus;
    fast_gate: GateStatus;
    blocking_failures_count: number;
    case_passed: number;
    case_total: number;
    preset_passed: number;
    preset_total: number;
  };
}

const SOURCE_ALIASES: Record<string, NormalizedInputSource> = {
  wintab: 'wintab',
  win_tab: 'wintab',
  macnative: 'macnative',
  mac_native: 'macnative',
  pointerevent: 'pointerevent',
  pointer_event: 'pointerevent',
};

const PHASE_ALIASES: Record<string, NormalizedInputPhase> = {
  hover: 'hover',
  down: 'down',
  move: 'move',
  up: 'up',
  unknown: 'move',
};

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function clampFinite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function normalizeInputSource(
  source: string | null | undefined
): NormalizedInputSource | null {
  if (typeof source !== 'string') return null;
  const key = source.trim().toLowerCase();
  return SOURCE_ALIASES[key] ?? null;
}

export function normalizeInputPhase(phase: string | null | undefined): NormalizedInputPhase {
  if (typeof phase !== 'string') return 'move';
  const key = phase.trim().toLowerCase();
  return PHASE_ALIASES[key] ?? 'move';
}
