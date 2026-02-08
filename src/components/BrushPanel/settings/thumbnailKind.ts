import { BrushPreset } from '../types';

export type BrushThumbnailKind = 'texture' | 'procedural' | 'placeholder';

export function resolveBrushThumbnailKind(
  preset: Pick<BrushPreset, 'hasTexture' | 'isComputed'>
): BrushThumbnailKind {
  if (preset.hasTexture) return 'texture';
  if (preset.isComputed === true) return 'procedural';
  return 'placeholder';
}
