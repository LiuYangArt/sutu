/**
 * Color Dynamics algorithms for brush rendering
 *
 * Implements Photoshop-compatible Color Dynamics:
 * - Foreground/Background Jitter with control source
 * - Hue/Saturation/Brightness Jitter
 * - Purity (global saturation adjustment)
 *
 * CPU implementation as Ground Truth for GPU replication.
 */

import { ColorDynamicsSettings } from '@/stores/tool';
import { hexToHsva, hsvaToHex } from './colorUtils';
import { getControlValue, type DynamicsInput, type RandomFn } from './shapeDynamics';

/**
 * Computed color for a single dab
 */
export interface ComputedDabColor {
  /** Final color in hex format */
  color: string;
}

/**
 * Lerp between two hex colors in HSV space
 * Used for Foreground/Background interpolation
 *
 * @param colorA - First color (hex)
 * @param colorB - Second color (hex)
 * @param t - Interpolation factor (0 = colorA, 1 = colorB)
 * @returns Interpolated color (hex)
 */
export function lerpColorHsv(colorA: string, colorB: string, t: number): string {
  const a = hexToHsva(colorA);
  const b = hexToHsva(colorB);

  // Hue interpolation needs special handling for wrap-around
  // Find shortest path around the color wheel
  let hDiff = b.h - a.h;
  if (hDiff > 180) hDiff -= 360;
  if (hDiff < -180) hDiff += 360;

  const h = (((a.h + hDiff * t) % 360) + 360) % 360;
  const s = a.s + (b.s - a.s) * t;
  const v = a.v + (b.v - a.v) * t;

  return hsvaToHex({ h, s, v, a: 1 });
}

/**
 * Apply hue jitter (wraps around 360°)
 *
 * @param baseHue - Base hue in degrees (0-360)
 * @param jitterPercent - Jitter amount (0-100), maps to ±(jitterPercent * 1.8)°
 *                        At 100%, this gives ±180° (full spectrum)
 * @param random - Random function returning 0-1
 * @returns Hue with jitter applied, normalized to 0-360
 */
export function applyHueJitter(baseHue: number, jitterPercent: number, random: RandomFn): number {
  if (jitterPercent <= 0) return baseHue;

  // 100% jitter = ±180° (full spectrum coverage)
  const maxOffset = jitterPercent * 1.8;
  const offset = (random() * 2 - 1) * maxOffset;
  return (((baseHue + offset) % 360) + 360) % 360;
}

/**
 * Apply saturation/brightness jitter
 *
 * @param baseValue - Base value (0-100)
 * @param jitterPercent - Jitter amount (0-100)
 * @param random - Random function returning 0-1
 * @returns Value with jitter applied, clamped to 0-100
 */
export function applySVJitter(baseValue: number, jitterPercent: number, random: RandomFn): number {
  if (jitterPercent <= 0) return baseValue;

  // Bidirectional jitter: ±jitterPercent% of value range
  const offset = (random() * 2 - 1) * jitterPercent;
  return Math.max(0, Math.min(100, baseValue + offset));
}

/**
 * Apply purity adjustment
 *
 * Purity controls the overall saturation:
 * - -100: Force grayscale (s = 0)
 * - 0: No change
 * - +100: Maximum saturation (s = 100)
 *
 * @param baseSaturation - Current saturation (0-100)
 * @param purity - Purity value (-100 to +100)
 * @returns Adjusted saturation (0-100)
 */
export function applyPurity(baseSaturation: number, purity: number): number {
  if (purity === 0) return baseSaturation;

  if (purity < 0) {
    // Negative purity: interpolate towards 0 (grayscale)
    const t = -purity / 100;
    return baseSaturation * (1 - t);
  } else {
    // Positive purity: interpolate towards 100 (full saturation)
    const t = purity / 100;
    return baseSaturation + (100 - baseSaturation) * t;
  }
}

/**
 * Compute color dynamics for a single dab
 *
 * This is the main entry point for Color Dynamics calculation.
 * Called once per dab during stroke rendering.
 *
 * Processing order:
 * 1. Apply Foreground/Background mixing (control + jitter)
 * 2. Convert to HSV
 * 3. Apply Hue Jitter
 * 4. Apply Saturation Jitter
 * 5. Apply Brightness Jitter
 * 6. Apply Purity (global saturation adjustment)
 * 7. Convert back to Hex
 *
 * @param foregroundColor - Foreground color (hex)
 * @param backgroundColor - Background color (hex)
 * @param settings - Color Dynamics settings
 * @param input - Input data (pressure, tilt, direction)
 * @param random - Random function for jitter (default: Math.random)
 * @returns Computed color for this dab
 */
export function computeDabColor(
  foregroundColor: string,
  backgroundColor: string,
  settings: ColorDynamicsSettings,
  input: DynamicsInput,
  random: RandomFn = Math.random
): ComputedDabColor {
  // Step 1: Start with foreground color
  let workingColor = foregroundColor;

  // Step 2: Apply Foreground/Background mixing
  if (settings.foregroundBackgroundJitter > 0 || settings.foregroundBackgroundControl !== 'off') {
    // Get control value (0-1)
    const controlValue = getControlValue(settings.foregroundBackgroundControl, input);

    // Calculate mix factor
    // Control source: high value (e.g., high pressure) = more foreground
    // So we invert: mixFactor 0 = foreground, 1 = background
    let mixFactor = 0;
    if (settings.foregroundBackgroundControl !== 'off') {
      mixFactor = 1 - controlValue;
    }

    // Add jitter on top
    if (settings.foregroundBackgroundJitter > 0) {
      const jitterAmount = (settings.foregroundBackgroundJitter / 100) * random();
      mixFactor = Math.max(0, Math.min(1, mixFactor + jitterAmount));
    }

    // Interpolate between foreground and background
    if (mixFactor > 0) {
      workingColor = lerpColorHsv(foregroundColor, backgroundColor, mixFactor);
    }
  }

  // Step 3: Convert to HSV for jitter operations
  const hsv = hexToHsva(workingColor);

  // Step 4: Apply Hue Jitter
  hsv.h = applyHueJitter(hsv.h, settings.hueJitter, random);

  // Step 5: Apply Saturation Jitter
  hsv.s = applySVJitter(hsv.s, settings.saturationJitter, random);

  // Step 6: Apply Brightness Jitter
  hsv.v = applySVJitter(hsv.v, settings.brightnessJitter, random);

  // Step 7: Apply Purity (after jitter, as global adjustment)
  hsv.s = applyPurity(hsv.s, settings.purity);

  // Step 8: Convert back to hex
  return {
    color: hsvaToHex(hsv),
  };
}

/**
 * Check if Color Dynamics would have any effect
 *
 * Useful for performance optimization - skip computation when all settings are off
 *
 * @param settings - Color Dynamics settings
 * @returns true if any dynamics are active
 */
export function isColorDynamicsActive(settings: ColorDynamicsSettings): boolean {
  return (
    settings.foregroundBackgroundJitter > 0 ||
    settings.foregroundBackgroundControl !== 'off' ||
    settings.hueJitter > 0 ||
    settings.saturationJitter > 0 ||
    settings.brightnessJitter > 0 ||
    settings.purity !== 0
  );
}
