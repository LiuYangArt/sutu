import { describe, expect, it } from 'vitest';
import { MaskCache } from '../maskCache';

type MaskCacheInternal = {
  mask: Float32Array | null;
  maskWidth: number;
  maskHeight: number;
};

function sampleAt(cache: MaskCache, x: number, y: number): number {
  const internal = cache as unknown as MaskCacheInternal;
  const mask = internal.mask;
  if (!mask) return 0;
  const width = internal.maskWidth;
  const idx = y * width + x;
  return mask[idx] ?? 0;
}

describe('MaskCache softness profile', () => {
  it('soft edge keeps fading beyond 1.5x radius to avoid hard clipping', () => {
    const cache = new MaskCache();
    cache.generateMask({
      size: 100,
      hardness: 0,
      roundness: 1,
      angle: 0,
    });

    const internal = cache as unknown as MaskCacheInternal;
    const cx = Math.floor(internal.maskWidth / 2);
    const cy = Math.floor(internal.maskHeight / 2);
    const radius = 50;

    const alphaAt15x = sampleAt(cache, cx + Math.round(radius * 1.5), cy);
    const alphaAt17x = sampleAt(cache, cx + Math.round(radius * 1.7), cy);

    expect(alphaAt15x).toBeGreaterThan(0);
    expect(alphaAt17x).toBeGreaterThan(0);
    expect(alphaAt17x).toBeLessThan(alphaAt15x);
  });

  it('gaussian mode keeps solid core at hardness 50% (default-like, less dabby)', () => {
    const cache = new MaskCache();
    cache.generateMask({
      size: 100,
      hardness: 0.5,
      roundness: 1,
      angle: 0,
    });

    const internal = cache as unknown as MaskCacheInternal;
    const cx = Math.floor(internal.maskWidth / 2);
    const cy = Math.floor(internal.maskHeight / 2);

    const coreAlpha = sampleAt(cache, cx + 20, cy);
    const edgeAlpha = sampleAt(cache, cx + 50, cy);

    expect(coreAlpha).toBeGreaterThan(0.98);
    expect(edgeAlpha).toBeLessThan(coreAlpha);
  });
});
