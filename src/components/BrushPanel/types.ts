export interface BrushPreset {
  id: string;
  /** Original ABR sampled UUID (if any). Used for linking Dual Brush secondary tips. */
  sourceUuid?: string | null;
  name: string;
  diameter: number;
  spacing: number;
  hardness: number;
  angle: number;
  roundness: number;
  hasTexture: boolean;
  // Note: textureData removed - textures served via project://brush/{id}
  textureWidth: number | null;
  textureHeight: number | null;
  sizePressure: boolean;
  opacityPressure: boolean;
  /** Pre-computed cursor outline as SVG path data (normalized 0-1 coordinates) */
  cursorPath?: string | null;
  /** Cursor bounds for proper scaling */
  cursorBounds?: { width: number; height: number } | null;
  /** Texture settings from ABR Texture panel */
  textureSettings?: TextureSettings | null;
  /** Dual Brush settings from ABR Dual Brush panel */
  dualBrushSettings?: DualBrushSettingsPreset | null;

  /** Shape Dynamics (Photoshop-compatible) */
  shapeDynamicsEnabled?: boolean | null;
  shapeDynamics?: ShapeDynamicsSettings | null;
  /** Scattering (Photoshop-compatible) */
  scatterEnabled?: boolean | null;
  scatter?: ScatterSettings | null;
  /** Color Dynamics (Photoshop-compatible) */
  colorDynamicsEnabled?: boolean | null;
  colorDynamics?: ColorDynamicsSettings | null;
  /** Transfer (Photoshop-compatible) */
  transferEnabled?: boolean | null;
  transfer?: TransferSettings | null;
  /** Wet Edges panel enabled state */
  wetEdgeEnabled?: boolean | null;
  /** Build-up panel enabled state */
  buildupEnabled?: boolean | null;
  /** Noise panel enabled state */
  noiseEnabled?: boolean | null;

  /** Base opacity (0..1) */
  baseOpacity?: number | null;
  /** Base flow (0..1) */
  baseFlow?: number | null;
}

/** Dual blend mode (Photoshop Dual Brush panel compatible) */
export type DualBlendMode =
  | 'multiply'
  | 'darken'
  | 'overlay'
  | 'colorDodge'
  | 'colorBurn'
  | 'linearBurn'
  | 'hardMix'
  | 'linearHeight';

/** Dual Brush settings payload from ABR import */
export interface DualBrushSettingsPreset {
  enabled: boolean;
  brushId: string | null;
  brushName: string | null;
  mode: DualBlendMode;
  flip: boolean;
  size: number; // px
  roundness: number; // 0-100
  sizeRatio: number; // dual_size / main_size (0-10)
  spacing: number; // 0-1
  scatter: number;
  bothAxes: boolean;
  count: number;
}

/** ABR import benchmark timing */
export interface AbrBenchmark {
  totalMs: number;
  readMs: number;
  parseMs: number;
  cacheMs: number;
  brushCount: number;
  patternCount: number;
  rawBytes: number;
  compressedBytes: number;
}

/** ABR import result with benchmark info */
export interface ImportAbrResult {
  presets: BrushPreset[];
  tips: BrushPreset[];
  patterns: PatternInfo[];
  benchmark: AbrBenchmark;
}

/** Pattern metadata */
export interface PatternInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  mode: string;
}

/** Texture blend mode (Photoshop-compatible) */
export type TextureBlendMode =
  | 'multiply'
  | 'subtract'
  | 'darken'
  | 'overlay'
  | 'colorDodge'
  | 'colorBurn'
  | 'linearBurn'
  | 'hardMix'
  | 'linearHeight'
  | 'height';

/** Texture settings for brush (Photoshop Texture panel compatible) */
export interface TextureSettings {
  // Note: 'enabled' is NOT stored here - use `textureEnabled` from useToolStore
  /** Pattern ID (references a pattern in the library) */
  patternId: string | null;
  /** Scale percentage (1-1000) */
  scale: number;
  /** Brightness adjustment (-150 to +150) */
  brightness: number;
  /** Contrast adjustment (-50 to +50) */
  contrast: number;
  /** Apply texture to each dab tip (vs continuous) */
  textureEachTip: boolean;
  /** Blend mode for texture application */
  mode: TextureBlendMode;
  /** Depth/strength (0-100%) */
  depth: number;
  /** Minimum depth when using control (0-100%) */
  minimumDepth: number;
  /** Depth jitter amount (0-100%) */
  depthJitter: number;
  /** Invert texture values */
  invert: boolean;
  /** Depth control source (0=Off, 2=Pressure, etc.) */
  depthControl: number;
}

/**
 * Control source for dynamic brush parameters (Photoshop-compatible)
 */
export type ControlSource =
  | 'off'
  | 'fade'
  | 'penPressure'
  | 'penTilt'
  | 'rotation'
  | 'direction'
  | 'initial';

/**
 * Shape Dynamics settings (Photoshop Shape Dynamics panel compatible)
 */
export interface ShapeDynamicsSettings {
  sizeJitter: number; // 0-100 (%)
  sizeControl: ControlSource;
  minimumDiameter: number; // 0-100 (%)

  angleJitter: number; // 0-360 (deg)
  angleControl: ControlSource;

  roundnessJitter: number; // 0-100 (%)
  roundnessControl: ControlSource;
  minimumRoundness: number; // 0-100 (%)

  flipXJitter: boolean;
  flipYJitter: boolean;
}

/**
 * Scatter settings (Photoshop Scattering panel compatible)
 */
export interface ScatterSettings {
  scatter: number; // 0-1000 (% of diameter)
  scatterControl: ControlSource;
  bothAxes: boolean;
  count: number; // 1-16
  countControl: ControlSource;
  countJitter: number; // 0-100 (%)
}

/**
 * Color Dynamics settings (Photoshop Color Dynamics panel compatible)
 */
export interface ColorDynamicsSettings {
  foregroundBackgroundJitter: number; // 0-100 (%)
  foregroundBackgroundControl: ControlSource;
  hueJitter: number; // 0-100 (%)
  saturationJitter: number; // 0-100 (%)
  brightnessJitter: number; // 0-100 (%)
  purity: number; // -100..100
}

/**
 * Transfer settings (Photoshop Transfer panel compatible)
 */
export interface TransferSettings {
  opacityJitter: number; // 0-100 (%)
  opacityControl: ControlSource;
  minimumOpacity: number; // 0-100 (%)
  flowJitter: number; // 0-100 (%)
  flowControl: ControlSource;
  minimumFlow: number; // 0-100 (%)
}

/** Default texture settings */
export const DEFAULT_TEXTURE_SETTINGS: TextureSettings = {
  patternId: null,
  scale: 100,
  brightness: 0,
  contrast: 0,
  textureEachTip: false,
  mode: 'multiply',
  depth: 100,
  minimumDepth: 0,
  depthJitter: 0,
  invert: false,
  depthControl: 0,
};

/** Default procedural brush preset (always first in the list) */
export const DEFAULT_ROUND_BRUSH: BrushPreset = {
  id: '__default_round__',
  name: 'Round Brush',
  diameter: 20,
  spacing: 25,
  hardness: 100,
  angle: 0,
  roundness: 100,
  hasTexture: false,
  textureWidth: null,
  textureHeight: null,
  sizePressure: true,
  opacityPressure: false,
  cursorPath: null,
  cursorBounds: null,
  textureSettings: null,
};
