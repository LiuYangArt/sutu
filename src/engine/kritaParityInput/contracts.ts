export type {
  NormalizedInputPhase,
  NormalizedInputSource,
  RawInputSample,
  PaintInfo,
  DabRequest,
  PressureAnomalyFlags,
  GateArtifact,
  GateCaseResult,
  GatePresetResult,
  GateRunMeta,
  GateStatus,
} from './core/types';

export interface NativeTabletEventV3 {
  seq: number;
  stroke_id: number;
  pointer_id: number;
  device_id: string;
  source: 'wintab' | 'macnative' | 'pointerevent';
  phase: 'hover' | 'down' | 'move' | 'up';
  x_px: number;
  y_px: number;
  pressure_0_1: number;
  tilt_x_deg: number;
  tilt_y_deg: number;
  rotation_deg: number;
  host_time_us: number;
  device_time_us?: number;
}
