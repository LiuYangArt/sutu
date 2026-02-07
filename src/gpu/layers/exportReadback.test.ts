import { describe, expect, it } from 'vitest';
import {
  buildExportChunkRects,
  computeReadbackBytesPerRow,
  copyMappedRowsToImageData,
  normalizeExportChunkSize,
} from './exportReadback';

describe('exportReadback', () => {
  it('normalizes export chunk size with tile-size floor', () => {
    expect(normalizeExportChunkSize(undefined, 512)).toBe(2048);
    expect(normalizeExportChunkSize(128, 512)).toBe(512);
    expect(normalizeExportChunkSize(4096, 512)).toBe(4096);
  });

  it('builds chunk rects with edge clipping', () => {
    const rects = buildExportChunkRects(5000, 3000, 2048);
    expect(rects).toHaveLength(6);
    expect(rects[0]).toEqual({ x: 0, y: 0, width: 2048, height: 2048 });
    expect(rects[2]).toEqual({ x: 4096, y: 0, width: 904, height: 2048 });
    expect(rects[5]).toEqual({ x: 4096, y: 2048, width: 904, height: 952 });
  });

  it('aligns bytesPerRow for GPU readback requirements', () => {
    expect(computeReadbackBytesPerRow(1)).toBe(256);
    expect(computeReadbackBytesPerRow(64)).toBe(256);
    expect(computeReadbackBytesPerRow(65)).toBe(512);
  });

  it('copies mapped rows into destination image buffer with offsets', () => {
    const width = 2;
    const height = 2;
    const bytesPerRow = 256;
    const mapped = new Uint8Array(bytesPerRow * height);

    // Row 0: red, green
    mapped.set([255, 0, 0, 255], 0);
    mapped.set([0, 255, 0, 255], 4);
    // Row 1: blue, white
    mapped.set([0, 0, 255, 255], bytesPerRow);
    mapped.set([255, 255, 255, 255], bytesPerRow + 4);

    const destWidth = 4;
    const dest = new Uint8ClampedArray(destWidth * 4 * 4);
    copyMappedRowsToImageData({
      mapped,
      bytesPerRow,
      width,
      height,
      dest,
      destWidth,
      destX: 1,
      destY: 1,
    });

    const pixel = (x: number, y: number) => {
      const idx = (y * destWidth + x) * 4;
      return Array.from(dest.slice(idx, idx + 4));
    };

    expect(pixel(1, 1)).toEqual([255, 0, 0, 255]);
    expect(pixel(2, 1)).toEqual([0, 255, 0, 255]);
    expect(pixel(1, 2)).toEqual([0, 0, 255, 255]);
    expect(pixel(2, 2)).toEqual([255, 255, 255, 255]);
  });
});
