import { describe, expect, it } from 'vitest';
import { MaskCache, type MaskCacheParams } from './maskCache';

type MaskCacheInternal = {
  mask: Float32Array;
  maskWidth: number;
  maskHeight: number;
};

function readMask(cache: MaskCache): MaskCacheInternal {
  return cache as unknown as MaskCacheInternal;
}

describe('MaskCache GPU parity behavior', () => {
  it('uses exact parameter invalidation (no tolerance shortcuts)', () => {
    const cache = new MaskCache();
    const base: MaskCacheParams = {
      size: 64,
      hardness: 0.35,
      roundness: 0.92,
      angle: 17,
      maskType: 'gaussian',
    };

    cache.generateMask(base);

    expect(cache.needsUpdate(base)).toBe(false);
    expect(cache.needsUpdate({ ...base, size: base.size + 0.0001 })).toBe(true);
    expect(cache.needsUpdate({ ...base, hardness: base.hardness + 0.0001 })).toBe(true);
    expect(cache.needsUpdate({ ...base, roundness: base.roundness + 0.0001 })).toBe(true);
    expect(cache.needsUpdate({ ...base, angle: base.angle + 0.0001 })).toBe(true);
    expect(cache.needsUpdate({ ...base, maskType: 'default' })).toBe(true);
  });

  it('keeps gaussian/default soft masks as distinct GPU-parity shapes', () => {
    const gaussianCache = new MaskCache();
    const defaultCache = new MaskCache();

    const gaussianParams: MaskCacheParams = {
      size: 4,
      hardness: 0.5,
      roundness: 1,
      angle: 0,
      maskType: 'gaussian',
    };
    const defaultParams: MaskCacheParams = { ...gaussianParams, maskType: 'default' };

    gaussianCache.generateMask(gaussianParams);
    defaultCache.generateMask(defaultParams);

    const gaussian = readMask(gaussianCache);
    const fallback = readMask(defaultCache);
    const centerX = Math.floor(gaussian.maskWidth / 2);
    const centerY = Math.floor(gaussian.maskHeight / 2);

    const centerIdx = centerY * gaussian.maskWidth + centerX;
    const gaussianCenter = gaussian.mask[centerIdx] ?? 0;
    const defaultCenter = fallback.mask[centerIdx] ?? 0;
    let maxProfileDiff = 0;
    const rowStart = centerY * gaussian.maskWidth;
    for (let x = 0; x < gaussian.maskWidth; x++) {
      const g = gaussian.mask[rowStart + x] ?? 0;
      const d = fallback.mask[rowStart + x] ?? 0;
      maxProfileDiff = Math.max(maxProfileDiff, Math.abs(g - d));
    }

    expect(gaussianCenter).toBeGreaterThan(0.99);
    expect(defaultCenter).toBeGreaterThan(0.99);
    expect(maxProfileDiff).toBeGreaterThan(0.01);
  });
});
