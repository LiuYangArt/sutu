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

  // 1. Calculate Pattern UV (Canvas Space)
  // Scale: 100 = 1:1, 50 = pattern is 2x larger (repeats less), 200 = pattern is 0.5x larger
  // Wait, standard behavior: Scale 100 means pattern pixels map 1:1 to canvas pixels.
  // Scale 200 means pattern is drawn at 200% size.
  // Scale 50 means pattern is drawn at 50% size.

  // Inverse scale factor for coordinate mapping
  // If we draw at 200% size, we step through texture 2x slower. -> factor = 0.5
  // If we draw at 50% size, we step through texture 2x faster. -> factor = 2.0
  const scale = Math.max(1, settings.scale);
  const scaleFactor = 100.0 / scale;

  // Pattern coordinates (Nearest Neighbor)
  // Use modulo for tiling. Handle negative coordinates correctly.
  let patX = Math.floor(canvasX * scaleFactor);
  let patY = Math.floor(canvasY * scaleFactor);

  // JS modulo operator returns negative values for negative numbers, needed custom logic
  // ((a % n) + n) % n
  patX = ((patX % pattern.width) + pattern.width) % pattern.width;
  patY = ((patY % pattern.height) + pattern.height) % pattern.height;

  // 2. Sample Texture
  // Pattern data includes header? No, pattern.data is raw RGBA or Gray?
  // PatternManager returns raw RGBA (LZ4 decoded).
  // Assuming RGBA8. We usually use the first channel or luminance.
  // ABR patterns are often Grayscale, but stored as RGBA.
  const idx = (patY * pattern.width + patX) * 4;

  // Safe check (should be ensured by modulo)
  if (idx < 0 || idx >= pattern.data.length) return 1.0;

  let texVal = pattern.data[idx]! / 255.0;

  // Invert if needed
  if (settings.invert) {
    texVal = 1.0 - texVal;
  }

  // Brightness / Contrast
  if (settings.brightness !== 0) {
    texVal -= settings.brightness / 255.0;
  }

  if (settings.contrast !== 0) {
    // Standard contrast correction formula
    // Map contrast (-100..100) to a reasonable range for the factor calculation
    // Using simple approach: (val - 0.5) * factor + 0.5
    // where factor > 1 increases contrast, factor < 1 decreases it
    const factor = Math.pow((settings.contrast + 100) / 100, 2);
    texVal = (texVal - 0.5) * factor + 0.5;
  }

  // Clamp after adjustments
  texVal = Math.max(0, Math.min(1, texVal));

  // 3. Apply Blend Mode
  // Influence: 1.0 = No change, 0.0 = Fully Transparent (if texture is black in multiply)

  // We calculate a 'multiplier' for the brush alpha.
  // Result = BrushAlpha * Multiplier

  let multiplier = 1.0;

  switch (settings.mode) {
    case 'multiply':
      // Multiply: Multiplier = mix(1.0, texVal, depth)
      // If texVal is 0 (black), depth 100% -> Multiplier 0.
      // If texVal is 1 (white), depth 100% -> Multiplier 1.
      multiplier = 1.0 * (1.0 - depth) + texVal * depth;
      break;

    case 'subtract':
      // Subtract: Multiplier = mix(1.0, 1.0 - texVal, depth)
      // If texVal is 1 (white), we subtract max -> Multiplier 0.
      // If texVal is 0 (black), we subtract min -> Multiplier 1.
      multiplier = 1.0 * (1.0 - depth) + (1.0 - texVal) * depth;
      break;

    case 'height':
    case 'linearHeight':
      // Height: (texVal - 0.5) * 2 * depth ... complicated mapping
      // Simple approx: mix(1.0, texVal, depth) like multiply but maybe different curve
      multiplier = 1.0 * (1.0 - depth) + texVal * depth;
      break;

    // Fallback for others
    default:
      // Default to multiply
      multiplier = 1.0 * (1.0 - depth) + texVal * depth;
      break;
  }

  return multiplier;
}
