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
import { hexToHsva, hsvaToHex, type HSVA } from './colorUtils';
import { getControlValue, type DynamicsInput, type RandomFn } from './shapeDynamics';

/**
 * Computed color for a single dab
 */
export interface ComputedDabColor {
  /** Final color in hex format */
  color: string;
}

/** Random jitter samples for one color-dynamics evaluation window (per tip/per stroke) */
export interface ColorJitterSample {
  foregroundBackground: number;
  hue: number;
  saturation: number;
  brightness: number;
}

export function createColorJitterSample(random: RandomFn = Math.random): ColorJitterSample {
  return {
    foregroundBackground: random(),
    hue: random(),
    saturation: random(),
    brightness: random(),
  };
}

/**
 * Lerp between two HSVA colors (operates directly on HSVA to avoid conversions)
 *
 * @param a - First color (HSVA)
 * @param b - Second color (HSVA)
 * @param t - Interpolation factor (0 = a, 1 = b)
 * @returns Interpolated color (HSVA)
 */
function lerpHsva(a: HSVA, b: HSVA, t: number): HSVA {
  // Hue interpolation needs special handling for wrap-around
  // Find shortest path around the color wheel
  let hDiff = b.h - a.h;
  if (hDiff > 180) hDiff -= 360;
  if (hDiff < -180) hDiff += 360;

  return {
    h: (((a.h + hDiff * t) % 360) + 360) % 360,
    s: a.s + (b.s - a.s) * t,
    v: a.v + (b.v - a.v) * t,
    a: a.a + (b.a - a.a) * t,
  };
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
 * Processing order (all in HSV space to minimize conversions):
 * 1. Convert foreground/background to HSV once
 * 2. Apply Foreground/Background mixing
 * 3. Apply Hue Jitter
 * 4. Apply Saturation Jitter
 * 5. Apply Brightness Jitter
 * 6. Apply Purity (global saturation adjustment)
 * 7. Convert back to Hex once
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
  random: RandomFn = Math.random,
  jitterSample?: ColorJitterSample
): ComputedDabColor {
  // Convert to HSV once at entry
  let hsv = hexToHsva(foregroundColor);

  // Apply Foreground/Background mixing (if needed)
  if (settings.foregroundBackgroundJitter > 0 || settings.foregroundBackgroundControl !== 'off') {
    const controlValue = getControlValue(settings.foregroundBackgroundControl, input);

    // Calculate mix factor (high pressure = more foreground, so invert)
    let mixFactor = 0;
    if (settings.foregroundBackgroundControl !== 'off') {
      mixFactor = 1 - controlValue;
    }

    // Add jitter on top
    if (settings.foregroundBackgroundJitter > 0) {
      const jitterBase = jitterSample?.foregroundBackground ?? random();
      const jitterAmount = (settings.foregroundBackgroundJitter / 100) * jitterBase;
      mixFactor = Math.max(0, Math.min(1, mixFactor + jitterAmount));
    }

    // Interpolate in HSV space (convert background only when needed)
    if (mixFactor > 0) {
      const bgHsv = hexToHsva(backgroundColor);
      hsv = lerpHsva(hsv, bgHsv, mixFactor);
    }
  }

  // Apply Hue Jitter
  hsv.h = applyHueJitter(hsv.h, settings.hueJitter, () => jitterSample?.hue ?? random());

  // Apply Saturation Jitter
  hsv.s = applySVJitter(
    hsv.s,
    settings.saturationJitter,
    () => jitterSample?.saturation ?? random()
  );

  // Apply Brightness Jitter
  hsv.v = applySVJitter(
    hsv.v,
    settings.brightnessJitter,
    () => jitterSample?.brightness ?? random()
  );

  // Apply Purity (after jitter, as global adjustment)
  hsv.s = applyPurity(hsv.s, settings.purity);

  // Convert back to hex once at exit
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
