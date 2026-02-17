export const KRITA_TAIL_TRACE_SCHEMA_VERSION = 'krita-tail-trace-v1';

export type KritaTailTracePhase = 'down' | 'move' | 'up';
export type KritaTailSamplerTriggerKind = 'distance' | 'time';
export type KritaTailDabSource = 'normal' | 'finalize' | 'pointerup_fallback';
export type KritaTailSeqSource = 'native' | 'fallback';
export type KritaTailInputBackend =
  | 'windows_wintab'
  | 'windows_winink_pointer'
  | 'mac_native'
  | 'unknown';
export type KritaTailFallbackPressurePolicy = 'none' | 'last_nonzero' | 'event_raw' | 'zero';

export interface KritaTailTraceMeta {
  caseId: string;
  canvas: {
    width: number;
    height: number;
    dpi: number;
  };
  brushPreset: string;
  inputBackend: KritaTailInputBackend;
  runtimeFlags: Record<string, boolean>;
  build: {
    appCommit: string;
    kritaCommit: string;
    platform: string;
    inputBackend: string;
  };
}

export interface KritaTailInputRawSample {
  seq: number;
  seqSource?: KritaTailSeqSource;
  timestampMs: number;
  x: number;
  y: number;
  pressureRaw: number;
  phase: KritaTailTracePhase;
}

export interface KritaTailPressureMappedSample {
  seq: number;
  pressureAfterGlobalCurve: number;
  pressureAfterBrushCurve: number;
  pressureAfterHeuristic: number;
  speedPxPerMs: number;
  normalizedSpeed: number;
}

export interface KritaTailSamplerSample {
  segmentId: number;
  segmentStartSeq: number;
  segmentEndSeq: number;
  sampleIndex: number;
  t: number;
  triggerKind: KritaTailSamplerTriggerKind;
  distanceCarryBefore: number;
  distanceCarryAfter: number;
  timeCarryBefore: number;
  timeCarryAfter: number;
}

export interface KritaTailDabEmitSample {
  dabIndex: number;
  segmentId: number;
  sampleIndex: number;
  x: number;
  y: number;
  pressure: number;
  spacingUsedPx: number;
  timestampMs: number;
  source: KritaTailDabSource;
  fallbackPressurePolicy: KritaTailFallbackPressurePolicy;
}

export interface KritaTailTrace {
  schemaVersion: typeof KRITA_TAIL_TRACE_SCHEMA_VERSION;
  strokeId: string;
  meta: KritaTailTraceMeta;
  stages: {
    input_raw: KritaTailInputRawSample[];
    pressure_mapped: KritaTailPressureMappedSample[];
    sampler_t: KritaTailSamplerSample[];
    dab_emit: KritaTailDabEmitSample[];
  };
}

export interface KritaTailTraceStartOptions {
  strokeId?: string;
  meta: KritaTailTraceMeta;
}
