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
}

/** ABR import benchmark timing */
export interface AbrBenchmark {
  totalMs: number;
  readMs: number;
  parseMs: number;
  cacheMs: number;
  brushCount: number;
  rawBytes: number;
  compressedBytes: number;
}

/** ABR import result with benchmark info */
export interface ImportAbrResult {
  presets: BrushPreset[];
  benchmark: AbrBenchmark;
}

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
};
