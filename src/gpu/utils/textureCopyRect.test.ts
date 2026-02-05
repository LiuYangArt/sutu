import { describe, expect, it } from 'vitest';
import { computeTextureCopyRectFromLogicalRect } from './textureCopyRect';

describe('computeTextureCopyRectFromLogicalRect', () => {
  it('scale=1: floor/ceil + pad + clamp', () => {
    const out = computeTextureCopyRectFromLogicalRect(
      { left: 10.2, top: 20.8, right: 30.1, bottom: 40.9 },
      1.0,
      100,
      100,
      1
    );
    expect(out).toEqual({ originX: 9, originY: 19, width: 23, height: 23 });
  });

  it('scale=0.5: covers sampled texels', () => {
    const logical = { left: 1, top: 1, right: 3, bottom: 3 };
    const out = computeTextureCopyRectFromLogicalRect(logical, 0.5, 64, 64, 0);

    const scale = 0.5;
    const sampledTexelsX = [Math.floor(1 * scale), Math.floor(2 * scale)];
    const sampledTexelsY = [Math.floor(1 * scale), Math.floor(2 * scale)];

    for (const x of sampledTexelsX) {
      expect(x).toBeGreaterThanOrEqual(out.originX);
      expect(x).toBeLessThan(out.originX + out.width);
    }
    for (const y of sampledTexelsY) {
      expect(y).toBeGreaterThanOrEqual(out.originY);
      expect(y).toBeLessThan(out.originY + out.height);
    }
  });

  it('clamps to texture bounds', () => {
    const out = computeTextureCopyRectFromLogicalRect(
      { left: -10, top: -5, right: 200, bottom: 100 },
      1.0,
      128,
      64,
      1
    );
    expect(out).toEqual({ originX: 0, originY: 0, width: 128, height: 64 });
  });

  it('padTexels expands the rect', () => {
    const base = computeTextureCopyRectFromLogicalRect(
      { left: 10, top: 10, right: 11, bottom: 11 },
      1.0,
      100,
      100,
      0
    );
    const padded = computeTextureCopyRectFromLogicalRect(
      { left: 10, top: 10, right: 11, bottom: 11 },
      1.0,
      100,
      100,
      2
    );
    expect(padded.originX).toBeLessThanOrEqual(base.originX);
    expect(padded.originY).toBeLessThanOrEqual(base.originY);
    expect(padded.width).toBeGreaterThanOrEqual(base.width);
    expect(padded.height).toBeGreaterThanOrEqual(base.height);
  });
});
