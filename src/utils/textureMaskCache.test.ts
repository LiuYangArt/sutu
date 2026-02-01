import { describe, it, expect } from 'vitest';
import { TextureMaskCache } from './textureMaskCache';

describe('TextureMaskCache subpixel stamping', () => {
  it('changes output when the center has a subpixel offset', () => {
    const cache = new TextureMaskCache();
    const internal = cache as unknown as {
      scaledMask: Float32Array;
      scaledWidth: number;
      scaledHeight: number;
    };

    internal.scaledWidth = 2;
    internal.scaledHeight = 2;
    internal.scaledMask = new Float32Array([0, 1, 1, 0]);

    const bufferA = new Float32Array(16);
    const bufferB = new Float32Array(16);

    cache.stampToMask(bufferA, 4, 4, 1.2, 1.2, 1.0);
    cache.stampToMask(bufferB, 4, 4, 1.4, 1.2, 1.0);

    expect(bufferA[5]).not.toBeCloseTo(bufferB[5], 6);
  });
});
