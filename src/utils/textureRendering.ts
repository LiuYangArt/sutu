import type { TextureSettings } from '@/components/BrushPanel/types';
import type { PatternData } from './patternManager';

const EPSILON = 0.001;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isDepthEmbeddedMode(mode: TextureSettings['mode']): boolean {
  return mode === 'hardMix' || mode === 'linearHeight' || mode === 'height';
}

function blendHardMixSofterPhotoshop(base: number, blend: number, depth: number): number {
  return clamp01(3.0 * base * depth - 2.0 * (1.0 - blend));
}

function blendLinearHeightPhotoshop(base: number, blend: number, depth: number): number {
  const m = 10.0 * depth * base;
  return clamp01(Math.max((1.0 - blend) * m, m - blend));
}

function blendHeightPhotoshop(base: number, blend: number, depth: number): number {
  return clamp01(10.0 * depth * base - blend);
}

export function sampleTextureValue(
  canvasX: number,
  canvasY: number,
  settings: TextureSettings,
  pattern: PatternData
): number {
  // 1. Calculate Pattern UV (Canvas Space) with Tiling
  const scale = Math.max(1, settings.scale);
  const scaleFactor = 100.0 / scale;

  let patternX = Math.floor(canvasX * scaleFactor);
  let patternY = Math.floor(canvasY * scaleFactor);

  // Handle negative coordinates for correct tiling
  patternX = ((patternX % pattern.width) + pattern.width) % pattern.width;
  patternY = ((patternY % pattern.height) + pattern.height) % pattern.height;

  // 2. Sample Texture (stored as RGBA; use first channel)
  const idx = (patternY * pattern.width + patternX) * 4;
  if (idx < 0 || idx >= pattern.data.length) return 1.0;

  // Normalize to 0-1 range (use luminance to match Photoshop for RGB patterns)
  const r = (pattern.data[idx] ?? 0) / 255.0;
  const g = (pattern.data[idx + 1] ?? 0) / 255.0;
  const b = (pattern.data[idx + 2] ?? 0) / 255.0;
  let textureValue = 0.299 * r + 0.587 * g + 0.114 * b;

  // 3. Apply Adjustments
  if (settings.invert) {
    textureValue = 1.0 - textureValue;
  }

  // Fix: Brightness should be subtracted to make the result lighter (less opaque)
  if (settings.brightness !== 0) {
    textureValue -= settings.brightness / 255.0;
  }

  if (settings.contrast !== 0) {
    // Contrast curve: (val - 0.5) * factor + 0.5
    const factor = Math.pow((settings.contrast + 100) / 100, 2);
    textureValue = (textureValue - 0.5) * factor + 0.5;
  }

  // Clamp to valid range
  return clamp01(textureValue);
}

/**
 * Calculate the texture modulation value for a given pixel
 *
 * @param canvasX Absolute X position on canvas
 * @param canvasY Absolute Y position on canvas
 * @param settings Texture settings
 * @param pattern Pattern data
 * @param depth Effective depth (0-1), already including pressure dynamics if applicable
 * @param baseAlpha Base tip alpha (0-1) before texture modulation
 * @returns Alpha multiplier relative to baseAlpha (may exceed 1.0 for some modes)
 */
export function calculateTextureInfluence(
  canvasX: number,
  canvasY: number,
  settings: TextureSettings,
  pattern: PatternData,
  depth: number,
  baseAlpha: number,
  accumulatedAlpha: number = 0
): number {
  const baseMask = clamp01(baseAlpha);
  const accum = clamp01(accumulatedAlpha);
  // Use the larger of tip mask and already accumulated stroke alpha
  // to reduce per-dab clipping artifacts in non-linear blend modes.
  const base = Math.max(baseMask, accum);
  if (base <= EPSILON) return 0.0;

  const depth01 = clamp01(depth);
  if (depth01 <= EPSILON) return 1.0;

  const textureValue = sampleTextureValue(canvasX, canvasY, settings, pattern);
  const blend = clamp01(textureValue);

  // 4. Apply Blend Mode (match GPU apply_blend_mode)
  // Base: current tip alpha (maskValue)
  // Blend: pattern texture value
  const blendedAlpha = (() => {
    switch (settings.mode) {
      case 'multiply':
        return base * blend;
      case 'subtract':
        // Keep subtract proportional to base alpha to avoid dab-shaped clipping.
        return base * (1.0 - blend);
      case 'darken':
        return Math.min(base, blend);
      case 'overlay':
        if (base < 0.5) return 2.0 * base * blend;
        return 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
      case 'colorDodge':
        if (blend >= 1.0) return 1.0;
        return Math.min(1.0, base / (1.0 - blend));
      case 'colorBurn':
        if (blend <= 0.0) return 0.0;
        return 1.0 - Math.min(1.0, (1.0 - base) / blend);
      case 'linearBurn':
        return Math.max(0.0, base + blend - 1.0);
      case 'hardMix':
        return blendHardMixSofterPhotoshop(base, blend, depth01);
      case 'linearHeight':
        return blendLinearHeightPhotoshop(base, blend, depth01);
      case 'height':
        return blendHeightPhotoshop(base, blend, depth01);
      default:
        return base * blend;
    }
  })();

  // 5. Apply Depth (Strength)
  const finalAlpha = isDepthEmbeddedMode(settings.mode)
    ? blendedAlpha
    : base * (1.0 - depth01) + blendedAlpha * depth01;
  const clampedFinalAlpha = clamp01(finalAlpha);

  // Return alpha multiplier relative to the original base alpha.
  // NOTE: Can exceed 1.0 for some blend modes (e.g. Overlay/Color Dodge/Height).
  return clampedFinalAlpha / base;
}
