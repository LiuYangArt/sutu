import type { Rect } from '@/utils/strokeBuffer';
import type { TileRect } from './GpuLayerStore';

export interface TileDrawRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function computeTileDrawRegion(tileRect: TileRect, dirtyRect: Rect): TileDrawRegion | null {
  const left = Math.max(tileRect.originX, Math.floor(dirtyRect.left));
  const top = Math.max(tileRect.originY, Math.floor(dirtyRect.top));
  const right = Math.min(tileRect.originX + tileRect.width, Math.ceil(dirtyRect.right));
  const bottom = Math.min(tileRect.originY + tileRect.height, Math.ceil(dirtyRect.bottom));

  if (right <= left || bottom <= top) {
    return null;
  }

  return {
    x: left - tileRect.originX,
    y: top - tileRect.originY,
    width: right - left,
    height: bottom - top,
  };
}
