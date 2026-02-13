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
  it('should handle all texture blend modes at full depth', () => {
    const baseAlpha = 0.25;
    const blendByte = 230;
    const blend = blendByte / 255;

    const pattern: PatternData = {
      id: 'flat-pattern',
      width: 1,
      height: 1,
      data: new Uint8Array([blendByte, blendByte, blendByte, 255]),
    };

    const cases: Array<{ mode: TextureSettings['mode']; expectedMultiplier: number }> = [
      { mode: 'multiply', expectedMultiplier: blend },
      { mode: 'subtract', expectedMultiplier: 1.0 - blend },
      { mode: 'darken', expectedMultiplier: Math.min(baseAlpha, blend) / baseAlpha },
      { mode: 'overlay', expectedMultiplier: (2 * baseAlpha * blend) / baseAlpha },
      { mode: 'colorDodge', expectedMultiplier: 1.0 / baseAlpha },
      {
        mode: 'colorBurn',
        expectedMultiplier: (1 - Math.min(1, (1 - baseAlpha) / blend)) / baseAlpha,
      },
      { mode: 'linearBurn', expectedMultiplier: Math.max(0, baseAlpha + blend - 1) / baseAlpha },
      { mode: 'hardMix', expectedMultiplier: 1.0 / baseAlpha },
      { mode: 'linearHeight', expectedMultiplier: 0.5 + blend * 0.5 },
      { mode: 'height', expectedMultiplier: Math.min(1.0, baseAlpha * 2.0 * blend) / baseAlpha },
    ];

    for (const c of cases) {
      const settings = { ...defaultSettings, mode: c.mode };
      expect(calculateTextureInfluence(0, 0, settings, pattern, 1.0, baseAlpha)).toBeCloseTo(
        c.expectedMultiplier,
        5
      );
    }
  });

  it('should handle Overlay mode correctly when base alpha >= 0.5', () => {
    const baseAlpha = 0.75;
    const blendByte = 230;
    const blend = blendByte / 255;

    const pattern: PatternData = {
      id: 'flat-pattern',
      width: 1,
      height: 1,
      data: new Uint8Array([blendByte, blendByte, blendByte, 255]),
    };

    const settings = { ...defaultSettings, mode: 'overlay' as const };
    const expected = 1.0 - 2.0 * (1.0 - baseAlpha) * (1.0 - blend);

    expect(calculateTextureInfluence(0, 0, settings, pattern, 1.0, baseAlpha)).toBeCloseTo(
      expected / baseAlpha,
      5
    );
  });

  it('should return multiplier=1 when depth is 0', () => {
    const result = calculateTextureInfluence(0, 0, defaultSettings, mockPattern, 0, 0.3);
    expect(result).toBe(1.0);
  });

  it('should handle Multiply mode correctly at 100% depth', () => {
    // (0,0) is Black (0)
    expect(calculateTextureInfluence(0, 0, defaultSettings, mockPattern, 1.0, 1.0)).toBe(0.0);

    // (1,0) is White (1)
    expect(calculateTextureInfluence(1, 0, defaultSettings, mockPattern, 1.0, 1.0)).toBeCloseTo(
      1.0,
      10
    );

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

    // Subtract uses proportional reduction:
    // blended = base * (1 - tex), so multiplier = mix(1, 1 - tex, depth).
    // This keeps texture influence continuous and independent of per-dab base alpha.

    // (0,0) Black (0) -> Multiplier 1.0
    expect(calculateTextureInfluence(0, 0, settings, mockPattern, 1.0, 1.0)).toBe(1.0);

    // (1,0) White (1) -> Multiplier 0.0
    expect(calculateTextureInfluence(1, 0, settings, mockPattern, 1.0, 1.0)).toBeCloseTo(0.0, 10);
  });

  it('should handle Invert option', () => {
    const settings = { ...defaultSettings, invert: true };

    // (0,0) Black (0) -> Inverted to White (1) -> Multiplier 1.0
    expect(calculateTextureInfluence(0, 0, settings, mockPattern, 1.0, 1.0)).toBe(1.0);

    // (1,0) White (1) -> Inverted to Black (0) -> Multiplier 0.0
    expect(calculateTextureInfluence(1, 0, settings, mockPattern, 1.0, 1.0)).toBeCloseTo(0.0, 10);
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

  it('should convert RGB pattern to grayscale using luma', () => {
    const pattern: PatternData = {
      id: 'rgb-pattern',
      width: 1,
      height: 1,
      data: new Uint8Array([255, 0, 0, 255]),
    };

    expect(calculateTextureInfluence(0, 0, defaultSettings, pattern, 1.0, 1.0)).toBeCloseTo(
      0.299,
      3
    );
  });
});
