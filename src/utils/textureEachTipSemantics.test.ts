import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TEXTURE_SETTINGS } from '@/components/BrushPanel/types';
import type { PatternData } from './patternManager';
import * as textureRendering from './textureRendering';
import { MaskCache } from './maskCache';
import { TextureMaskCache } from './textureMaskCache';

const TEST_PATTERN: PatternData = {
  id: '__test_pattern__',
  width: 1,
  height: 1,
  data: new Uint8Array([128, 128, 128, 255]),
};

function createTextureSettings(textureEachTip: boolean) {
  return {
    ...DEFAULT_TEXTURE_SETTINGS,
    textureEachTip,
    depth: 100,
    mode: 'darken' as const,
  };
}

describe('Texture Each Tip texture influence semantics', () => {
  beforeEach(() => {
    vi.spyOn(textureRendering, 'calculateTextureInfluence').mockReturnValue(1.0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('MaskCache passes accumulatedAlpha=0 when Texture Each Tip is enabled', () => {
    const cache = new MaskCache();
    cache.generateMask({ size: 10, hardness: 0.5, roundness: 1, angle: 0 });

    const buffer = new Uint8ClampedArray(48 * 48 * 4);
    cache.stampToBuffer(
      buffer,
      48,
      48,
      24,
      24,
      1,
      1,
      0,
      0,
      0,
      0,
      createTextureSettings(true),
      TEST_PATTERN
    );

    const influenceSpy = vi.mocked(textureRendering.calculateTextureInfluence);
    expect(influenceSpy).toHaveBeenCalled();
    for (const call of influenceSpy.mock.calls) {
      expect(call[6]).toBe(0);
    }
  });

  it('MaskCache skips texture influence when Texture Each Tip is disabled', () => {
    const cache = new MaskCache();
    cache.generateMask({ size: 10, hardness: 0.5, roundness: 1, angle: 0 });

    const buffer = new Uint8ClampedArray(48 * 48 * 4);
    cache.stampToBuffer(
      buffer,
      48,
      48,
      24,
      24,
      1,
      1,
      0,
      0,
      0,
      0,
      createTextureSettings(false),
      TEST_PATTERN
    );

    const influenceSpy = vi.mocked(textureRendering.calculateTextureInfluence);
    expect(influenceSpy).not.toHaveBeenCalled();
  });

  it('TextureMaskCache passes accumulatedAlpha=0 when Texture Each Tip is enabled', () => {
    const cache = new TextureMaskCache();
    const internal = cache as unknown as {
      scaledMask: Float32Array;
      scaledWidth: number;
      scaledHeight: number;
    };

    internal.scaledMask = new Float32Array([1]);
    internal.scaledWidth = 1;
    internal.scaledHeight = 1;

    const buffer = new Uint8ClampedArray(16 * 16 * 4);
    cache.stampToBuffer(
      buffer,
      16,
      16,
      8.5,
      8.5,
      1,
      1,
      0,
      0,
      0,
      createTextureSettings(true),
      TEST_PATTERN
    );

    const influenceSpy = vi.mocked(textureRendering.calculateTextureInfluence);
    expect(influenceSpy).toHaveBeenCalled();
    for (const call of influenceSpy.mock.calls) {
      expect(call[6]).toBe(0);
    }
  });

  it('TextureMaskCache skips texture influence when Texture Each Tip is disabled', () => {
    const cache = new TextureMaskCache();
    const internal = cache as unknown as {
      scaledMask: Float32Array;
      scaledWidth: number;
      scaledHeight: number;
    };

    internal.scaledMask = new Float32Array([1]);
    internal.scaledWidth = 1;
    internal.scaledHeight = 1;

    const buffer = new Uint8ClampedArray(16 * 16 * 4);
    cache.stampToBuffer(
      buffer,
      16,
      16,
      8.5,
      8.5,
      1,
      1,
      0,
      0,
      0,
      createTextureSettings(false),
      TEST_PATTERN
    );

    const influenceSpy = vi.mocked(textureRendering.calculateTextureInfluence);
    expect(influenceSpy).not.toHaveBeenCalled();
  });
});
