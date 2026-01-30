import type { TextureSettings } from '@/components/BrushPanel/types';
import type { PatternData } from './patternManager';

/**
 * Calculate the texture modulation value for a given pixel
 *
 * @param canvasX Absolute X position on canvas
 * @param canvasY Absolute Y position on canvas
 * @param settings Texture settings
 * @param pattern Pattern data
 * @param depth Effective depth (0-1), already including pressure dynamics if applicable
 * @returns Alpha multiplier (0-1)
 */
export function calculateTextureInfluence(
  canvasX: number,
  canvasY: number,
  settings: TextureSettings,
  pattern: PatternData,
  depth: number
): number {
  if (depth <= 0.001) return 1.0;

  // 1. Calculate Pattern UV (Canvas Space) with Tiling
  const scale = Math.max(1, settings.scale);
  const scaleFactor = 100.0 / scale;

  let patternX = Math.floor(canvasX * scaleFactor);
  let patternY = Math.floor(canvasY * scaleFactor);

  // Handle negative coordinates for correct tiling
  patternX = ((patternX % pattern.width) + pattern.width) % pattern.width;
  patternY = ((patternY % pattern.height) + pattern.height) % pattern.height;

  // 2. Sample Texture
  // ABR patterns are typically Grayscale but stored as RGBA; use first channel
  const idx = (patternY * pattern.width + patternX) * 4;
  if (idx < 0 || idx >= pattern.data.length) return 1.0;

  // Normalize to 0-1 range
  let textureValue = pattern.data[idx]! / 255.0;

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
  textureValue = Math.max(0, Math.min(1, textureValue));

  // 4. Apply Blend Mode
  // Calculate multiplier for brush alpha (1.0 = no change)
  switch (settings.mode) {
    case 'subtract':
      // Subtract: White (1.0) subtracts max alpha, Black (0.0) preserves alpha.
      // Mathematical equivalent: 1.0 - (depth * textureValue)
      return 1.0 - depth * textureValue;

    case 'multiply':
    case 'height':
    case 'linearHeight':
    default:
      // Multiply: Result = Alpha * mix(1.0, textureValue, depth)
      return 1.0 * (1.0 - depth) + textureValue * depth;
  }
}
