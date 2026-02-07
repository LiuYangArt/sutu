import { alignTo } from '../utils/textureCopyRect';

export interface ExportChunkRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function normalizeExportChunkSize(chunkSize: number | undefined, tileSize: number): number {
  const raw = Math.floor(chunkSize ?? 2048);
  const safe = Number.isFinite(raw) ? raw : 2048;
  return Math.max(tileSize, safe);
}

export function buildExportChunkRects(
  width: number,
  height: number,
  chunkSize: number
): ExportChunkRect[] {
  const rects: ExportChunkRect[] = [];
  if (width <= 0 || height <= 0) return rects;

  for (let y = 0; y < height; y += chunkSize) {
    for (let x = 0; x < width; x += chunkSize) {
      rects.push({
        x,
        y,
        width: Math.min(chunkSize, width - x),
        height: Math.min(chunkSize, height - y),
      });
    }
  }
  return rects;
}

export function computeReadbackBytesPerRow(pixelWidth: number): number {
  return alignTo(pixelWidth * 4, 256);
}

export function copyMappedRowsToImageData(args: {
  mapped: Uint8Array;
  bytesPerRow: number;
  width: number;
  height: number;
  dest: Uint8ClampedArray;
  destWidth: number;
  destX: number;
  destY: number;
}): void {
  const { mapped, bytesPerRow, width, height, dest, destWidth, destX, destY } = args;
  for (let y = 0; y < height; y += 1) {
    const srcRowStart = y * bytesPerRow;
    const dstRowStart = ((destY + y) * destWidth + destX) * 4;
    const rowSize = width * 4;
    dest.set(mapped.subarray(srcRowStart, srcRowStart + rowSize), dstRowStart);
  }
}
