export interface BrushPreset {
  id: string;
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
