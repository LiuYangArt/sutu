export type CurvesChannel = 'rgb' | 'red' | 'green' | 'blue';

export interface CurvePoint {
  id: string;
  x: number;
  y: number;
}

export type CurvesPointsByChannel = Record<CurvesChannel, CurvePoint[]>;

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

export interface CurvesSessionInfo {
  sessionId: string;
  layerId: string;
  hasSelection: boolean;
  histogram: number[];
  renderMode: 'gpu' | 'cpu';
}
