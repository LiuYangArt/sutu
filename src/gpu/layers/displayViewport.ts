import type { TileRect } from './GpuLayerStore';

export interface DisplayViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function computeClampedDisplayViewport(
  tileRect: TileRect,
  canvasWidth: number,
  canvasHeight: number
): DisplayViewport | null {
  const x = tileRect.originX;
  const y = tileRect.originY;
  const right = Math.min(canvasWidth, tileRect.originX + tileRect.width);
  const bottom = Math.min(canvasHeight, tileRect.originY + tileRect.height);
  const width = right - x;
  const height = bottom - y;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}
