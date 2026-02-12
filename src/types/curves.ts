export type CurvesChannel = 'rgb' | 'red' | 'green' | 'blue';
export type CurveKernel = 'natural' | 'legacy_monotone';

export interface CurvePoint {
  id: string;
  x: number;
  y: number;
}

export type CurvesPointsByChannel = Record<CurvesChannel, CurvePoint[]>;
export type CurvesHistogramByChannel = Record<CurvesChannel, number[]>;

export interface CurvesState {
  selectedChannel: CurvesChannel;
  previewEnabled: boolean;
  pointsByChannel: CurvesPointsByChannel;
}

export interface CurvesLuts {
  rgb: Uint8Array;
  red: Uint8Array;
  green: Uint8Array;
  blue: Uint8Array;
}

export interface CurvesPreviewPayload {
  previewEnabled: boolean;
  rgbLut: number[];
  redLut: number[];
  greenLut: number[];
  blueLut: number[];
}

export type CurvesRuntimeErrorCode =
  | 'GPU_PREVIEW_FAILED'
  | 'GPU_PREVIEW_HALTED'
  | 'GPU_COMMIT_FAILED'
  | 'CPU_COMMIT_FAILED'
  | 'SESSION_INVALID';

export interface CurvesRuntimeError {
  code: CurvesRuntimeErrorCode;
  stage: 'preview' | 'commit';
  message: string;
  detail?: string;
}

export interface CurvesPreviewResult {
  ok: boolean;
  renderMode: 'gpu' | 'cpu';
  halted: boolean;
  error?: CurvesRuntimeError;
}

export interface CurvesCommitRequest {
  forceCpu?: boolean;
}

export interface CurvesCommitResult {
  ok: boolean;
  appliedMode?: 'gpu' | 'cpu';
  error?: CurvesRuntimeError;
  canForceCpuCommit: boolean;
}

export interface CurvesSessionInfo {
  sessionId: string;
  layerId: string;
  hasSelection: boolean;
  histogram: number[];
  histogramByChannel: CurvesHistogramByChannel;
  renderMode: 'gpu' | 'cpu';
}
