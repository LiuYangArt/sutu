export interface BrushPreset {
  id: string;
  name: string;
  diameter: number;
  spacing: number;
  hardness: number;
  angle: number;
  roundness: number;
  hasTexture: boolean;
  textureData: string | null;
  textureWidth: number | null;
  textureHeight: number | null;
  sizePressure: boolean;
  opacityPressure: boolean;
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
  textureData: null,
  textureWidth: null,
  textureHeight: null,
  sizePressure: true,
  opacityPressure: false,
};
