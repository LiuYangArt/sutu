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
