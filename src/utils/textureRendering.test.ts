import { describe, it, expect } from 'vitest';
import { calculateTextureInfluence } from './textureRendering';
import type { TextureSettings } from '@/components/BrushPanel/types';
import type { PatternData } from './patternManager';

// Mock data
const mockPattern: PatternData = {
  id: 'test-pattern',
  width: 2,
  height: 2,
  data: new Uint8Array([
    0,
    0,
    0,
    255, // (0,0) Black, Alpha 255
    255,
    255,
    255,
    255, // (1,0) White, Alpha 255
    128,
    128,
    128,
    255, // (0,1) Gray 50%, Alpha 255
    0,
    0,
    0,
    0, // (1,1) Transparent Black
  ]),
};

const defaultSettings: TextureSettings = {
  patternId: 'test-pattern',
  scale: 100,
  brightness: 0,
  contrast: 0,
  textureEachTip: false,
  mode: 'multiply',
  depth: 100, // 100% depth
  invert: false,
  depthControl: 0,
  minimumDepth: 0,
  depthJitter: 0,
};

describe('calculateTextureInfluence', () => {
  it('should handle all texture blend modes (non-unity base ceiling)', () => {
    const baseCeiling = 0.25;
    const blendByte = 230;
    const blend = blendByte / 255;

    const pattern: PatternData = {
      id: 'flat-pattern',
      width: 1,
      height: 1,
      data: new Uint8Array([blendByte, blendByte, blendByte, 255]),
    };

    const cases: Array<{ mode: TextureSettings['mode']; expected: number }> = [
      { mode: 'multiply', expected: blend },
      { mode: 'subtract', expected: Math.max(0, baseCeiling - blend) / baseCeiling },
      { mode: 'darken', expected: Math.min(baseCeiling, blend) / baseCeiling },
      { mode: 'overlay', expected: (2 * baseCeiling * blend) / baseCeiling },
      { mode: 'colorDodge', expected: 1 / baseCeiling },
      {
        mode: 'colorBurn',
        expected: (1 - Math.min(1, (1 - baseCeiling) / blend)) / baseCeiling,
      },
      { mode: 'linearBurn', expected: Math.max(0, baseCeiling + blend - 1) / baseCeiling },
      { mode: 'hardMix', expected: 1 / baseCeiling },
      { mode: 'linearHeight', expected: (baseCeiling * (0.5 + blend * 0.5)) / baseCeiling },
      { mode: 'height', expected: blend },
    ];

    for (const c of cases) {
      const settings = { ...defaultSettings, mode: c.mode };
      expect(calculateTextureInfluence(0, 0, settings, pattern, 1.0, baseCeiling)).toBeCloseTo(
        c.expected,
        5
      );
    }
  });

  it('should handle Overlay mode correctly when base ceiling >= 0.5', () => {
    const baseCeiling = 0.75;
    const blendByte = 230;
    const blend = blendByte / 255;

    const pattern: PatternData = {
      id: 'flat-pattern',
      width: 1,
      height: 1,
      data: new Uint8Array([blendByte, blendByte, blendByte, 255]),
    };

    const settings = { ...defaultSettings, mode: 'overlay' as const };
    const blendedCeiling = 1.0 - 2.0 * (1.0 - baseCeiling) * (1.0 - blend);
    const expected = blendedCeiling / baseCeiling;

    expect(calculateTextureInfluence(0, 0, settings, pattern, 1.0, baseCeiling)).toBeCloseTo(
      expected,
      5
    );
  });

  it('should return 1.0 when depth is 0', () => {
    const result = calculateTextureInfluence(0, 0, defaultSettings, mockPattern, 0, 1.0);
    expect(result).toBe(1.0);
  });

  it('should handle Multiply mode correctly at 100% depth', () => {
    // (0,0) is Black (0)
    expect(calculateTextureInfluence(0, 0, defaultSettings, mockPattern, 1.0, 1.0)).toBe(0.0);

    // (1,0) is White (1)
    expect(calculateTextureInfluence(1, 0, defaultSettings, mockPattern, 1.0, 1.0)).toBe(1.0);

    // (0,1) is Gray (~0.5)
    expect(calculateTextureInfluence(0, 1, defaultSettings, mockPattern, 1.0, 1.0)).toBeCloseTo(
      128 / 255,
      2
    );
  });

  it('should handle Multiply mode correctly at 50% depth', () => {
    // (0,0) is Black (0). Multiply: mix(1.0, 0.0, 0.5) = 0.5
    expect(calculateTextureInfluence(0, 0, defaultSettings, mockPattern, 0.5, 1.0)).toBe(0.5);
  });

  it('should handle Subtract mode correctly', () => {
    const settings = { ...defaultSettings, mode: 'subtract' as const };

    // Subtract: mix(1.0, 1.0 - tex, depth)
    // (0,0) Black (0). Tex=0. Result = mix(1.0, 1.0, 1.0) = 1.0 ... Wait.
    // Subtract in Photoshop usually means output = input - texture.
    // My implementation: multiplier = 1.0 * (1-depth) + (1.0 - texVal) * depth
    // If texVal=0, multiplier = 1.0. (No subtraction)
    // If texVal=1, multiplier = 0.0. (Subtracted full value)

    // (0,0) Black (0) -> Multiplier 1.0
    expect(calculateTextureInfluence(0, 0, settings, mockPattern, 1.0, 1.0)).toBe(1.0);

    // (1,0) White (1) -> Multiplier 0.0
    expect(calculateTextureInfluence(1, 0, settings, mockPattern, 1.0, 1.0)).toBe(0.0);
  });

  it('should handle Invert option', () => {
    const settings = { ...defaultSettings, invert: true };

    // (0,0) Black (0) -> Inverted to White (1) -> Multiplier 1.0
    expect(calculateTextureInfluence(0, 0, settings, mockPattern, 1.0, 1.0)).toBe(1.0);

    // (1,0) White (1) -> Inverted to Black (0) -> Multiplier 0.0
    expect(calculateTextureInfluence(1, 0, settings, mockPattern, 1.0, 1.0)).toBe(0.0);
  });

  it('should handle Scale parameter', () => {
    // Scale 50 means pattern is drawn at 50% size.
    // Coordinates step 2x faster through pattern.
    const settings = { ...defaultSettings, scale: 50 };

    // Canvas (2,0) should map to Pattern (4,0) -> (0,0) due to modulo 2
    // Wait, pattern width is 2.
    // Scale 50 -> scaleFactor 2.0.
    // Canvas 0 -> Pat 0
    // Canvas 1 -> Pat 2 -> Pat 0 (Wrapped)

    // (1,0) canvas -> (2,0) pattern -> (0,0) pattern wrap -> Black (0)
    expect(calculateTextureInfluence(1, 0, settings, mockPattern, 1.0, 1.0)).toBe(0.0);
  });

  it('should apply Brightness correctly', () => {
    // Increase brightness by ~50% (128/255 = 0.5)
    // Expectation: Texture value DECREASES (becomes lighter/more transparent)
    // Texture Value: 1.0 (Opaque) -> 0.5 (Semi-transparent)
    const settings = { ...defaultSettings, brightness: 128 };

    // (1,0) White/Opaque (1.0) - 0.5 = 0.5
    expect(calculateTextureInfluence(1, 0, settings, mockPattern, 1.0, 1.0)).toBeCloseTo(0.5, 1);

    // (0,0) Black/Transparent (0.0) - 0.5 = -0.5 -> Clamped to 0.0
    expect(calculateTextureInfluence(0, 0, settings, mockPattern, 1.0, 1.0)).toBe(0.0);

    // Decrease brightness (-128) -> Negative subtraction = Addition 0.5
    // Expectation: Texture value INCREASES (becomes darker/more opaque)
    const darkSettings = { ...defaultSettings, brightness: -128 };

    // (1,0) White (1.0) + 0.5 = 1.5 -> Clamped to 1.0
    expect(calculateTextureInfluence(1, 0, darkSettings, mockPattern, 1.0, 1.0)).toBe(1.0);

    // (0,0) Black (0.0) + 0.5 = 0.5
    expect(calculateTextureInfluence(0, 0, darkSettings, mockPattern, 1.0, 1.0)).toBeCloseTo(
      0.5,
      1
    );
  });

  it('should apply Contrast correctly', () => {
    // High contrast
    const settings = { ...defaultSettings, contrast: 100 }; // Factor = 2^2 = 4

    // Gray 0.5 -> (0.5 - 0.5)*4 + 0.5 = 0.5 (Unchanged)
    // Gray 0.6 -> (0.6 - 0.5)*4 + 0.5 = 0.9 (Increased)
    // Gray 0.4 -> (0.4 - 0.5)*4 + 0.5 = 0.1 (Decreased)

    // Let's test with Gray ~0.5 (128/255 = 0.502)
    // 0.502 -> (0.002)*4 + 0.5 = 0.508
    expect(calculateTextureInfluence(0, 1, settings, mockPattern, 1.0, 1.0)).toBeCloseTo(0.5, 1);

    // Test with white (1.0) -> (0.5)*4 + 0.5 = 2.5 -> Clamped to 1.0
    expect(calculateTextureInfluence(1, 0, settings, mockPattern, 1.0, 1.0)).toBe(1.0);
  });
});
