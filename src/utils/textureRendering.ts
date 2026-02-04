import type { TextureSettings } from '@/components/BrushPanel/types';
import type { PatternData } from './patternManager';

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
  return Math.max(0, Math.min(1, textureValue));
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
  baseAlpha: number
): number {
  const base = Math.max(0, Math.min(1, baseAlpha));
  if (base <= 0.001) return 0.0;

  const depth01 = Math.max(0, Math.min(1, depth));
  if (depth01 <= 0.001) return 1.0;

  const textureValue = sampleTextureValue(canvasX, canvasY, settings, pattern);

  const blend = Math.max(0, Math.min(1, textureValue));

  // 4. Apply Blend Mode (match GPU apply_blend_mode)
  // Base: current tip alpha (maskValue)
  // Blend: pattern texture value
  const blendedAlpha = (() => {
    switch (settings.mode) {
      case 'multiply':
        return base * blend;
      case 'subtract':
        return Math.max(0, base - blend);
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
        return base + blend >= 1.0 ? 1.0 : 0.0;
      case 'linearHeight':
        return base * (0.5 + blend * 0.5);
      case 'height':
        // Height: treat texture as height map (neutral at 0.5), allowing lift (alpha increase)
        // Full depth (depth=1) => influence = 2 * blend, final alpha = base * influence (clamped)
        return Math.min(1.0, base * 2.0 * blend);
      default:
        return base * blend;
    }
  })();

  // 5. Apply Depth (Strength)
  const finalAlpha = base * (1.0 - depth01) + blendedAlpha * depth01;
  const clampedFinalAlpha = Math.max(0, Math.min(1, finalAlpha));

  // Return alpha multiplier relative to the original base alpha.
  // NOTE: Can exceed 1.0 for some blend modes (e.g. Overlay/Color Dodge/Height).
  return clampedFinalAlpha / base;
}
