import type { Rect } from '@/utils/strokeBuffer';

export function alignTo(value: number, alignment: number): number {
  if (alignment <= 0) return value;
  return Math.ceil(value / alignment) * alignment;
}

export function computeTextureCopyRectFromLogicalRect(
  logicalRect: Rect,
  renderScale: number,
  texW: number,
  texH: number,
  padTexels: number = 1
): { originX: number; originY: number; width: number; height: number } {
  const scale = renderScale > 0 ? renderScale : 1;
  const pad = Math.max(0, Math.floor(padTexels));

  const rawLeft = Math.floor(logicalRect.left * scale) - pad;
  const rawTop = Math.floor(logicalRect.top * scale) - pad;
  const rawRight = Math.ceil(logicalRect.right * scale) + pad;
  const rawBottom = Math.ceil(logicalRect.bottom * scale) + pad;

  const originX = Math.max(0, Math.min(rawLeft, texW));
  const originY = Math.max(0, Math.min(rawTop, texH));
  const right = Math.max(originX, Math.min(rawRight, texW));
  const bottom = Math.max(originY, Math.min(rawBottom, texH));

  return {
    originX,
    originY,
    width: Math.max(0, right - originX),
    height: Math.max(0, bottom - originY),
  };
}
