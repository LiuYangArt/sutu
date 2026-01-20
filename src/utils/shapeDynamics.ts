/**
 * Shape Dynamics algorithms for brush rendering
 *
 * Implements Photoshop-compatible Shape Dynamics:
 * - Size Jitter with control source and minimum diameter
 * - Angle Jitter with control source
 * - Roundness Jitter with control source and minimum roundness
 * - Flip X/Y Jitter
 *
 * CPU implementation as Ground Truth for GPU replication.
 */

import { ControlSource, ShapeDynamicsSettings } from '@/stores/tool';

/**
 * Input data for shape dynamics computation
 */
export interface DynamicsInput {
  /** Pen pressure (0-1) */
  pressure: number;
  /** Pen tilt X (-1 to 1, left to right) */
  tiltX: number;
  /** Pen tilt Y (-1 to 1, away to towards user) */
  tiltY: number;
  /** Current stroke direction in degrees (0-360) */
  direction: number;
  /** Initial stroke direction in degrees (captured at stroke start) */
  initialDirection: number;
}

/**
 * Computed shape for a single dab
 */
export interface ComputedDabShape {
  /** Final size in pixels */
  size: number;
  /** Final angle in degrees (0-360) */
  angle: number;
  /** Final roundness (0-1, where 1 = circle) */
  roundness: number;
  /** Whether to flip horizontally */
  flipX: boolean;
  /** Whether to flip vertically */
  flipY: boolean;
}

/**
 * Random number generator interface for testability
 */
export type RandomFn = () => number;

/**
 * Apply bidirectional jitter to a value
 *
 * @param baseValue - The base value to apply jitter to
 * @param jitterPercent - Jitter amount (0-100)
 * @param random - Random function returning 0-1
 * @returns Value with jitter applied (can be ± jitterPercent of baseValue)
 */
export function applyJitter(
  baseValue: number,
  jitterPercent: number,
  random: RandomFn
): number {
  if (jitterPercent <= 0) return baseValue;

  // Jitter is bidirectional: ±jitterPercent%
  const jitterFraction = jitterPercent / 100;
  const jitterRange = baseValue * jitterFraction;
  // random() returns 0-1, convert to -1 to 1
  const offset = (random() * 2 - 1) * jitterRange;

  return baseValue + offset;
}

/**
 * Apply angle jitter (wraps around 360°)
 *
 * @param baseAngle - Base angle in degrees (0-360)
 * @param jitterDegrees - Jitter amount in degrees (0-360)
 * @param random - Random function returning 0-1
 * @returns Angle with jitter applied, normalized to 0-360
 */
export function applyAngleJitter(
  baseAngle: number,
  jitterDegrees: number,
  random: RandomFn
): number {
  if (jitterDegrees <= 0) return baseAngle;

  // Bidirectional jitter: ±jitterDegrees
  const offset = (random() * 2 - 1) * jitterDegrees;
  // Normalize to 0-360
  return ((baseAngle + offset) % 360 + 360) % 360;
}

/**
 * Get control value from input data based on control source
 *
 * @param source - The control source type
 * @param input - Input data containing pressure, tilt, direction
 * @returns Control value (0-1)
 */
export function getControlValue(source: ControlSource, input: DynamicsInput): number {
  switch (source) {
    case 'off':
      return 1.0; // Full base value

    case 'penPressure':
      return Math.max(0, Math.min(1, input.pressure));

    case 'penTilt': {
      // Tilt magnitude: 0 (vertical) to 1 (horizontal)
      const tiltMag = Math.sqrt(input.tiltX * input.tiltX + input.tiltY * input.tiltY);
      return Math.min(1, tiltMag);
    }

    case 'direction':
      // Map 0-360 to 0-1
      return (input.direction % 360) / 360;

    case 'initial':
      // Map initial direction 0-360 to 0-1
      return (input.initialDirection % 360) / 360;

    default:
      return 1.0;
  }
}

/**
 * Apply control source with minimum constraint
 *
 * Formula: finalValue = minimum + (base - minimum) * controlValue
 *
 * Example: base=100, minimumPercent=25%, controlValue=0.5
 *   → minimum = 25
 *   → finalValue = 25 + (100-25) * 0.5 = 25 + 37.5 = 62.5
 *
 * @param baseValue - Base value
 * @param controlValue - Control value (0-1) from control source
 * @param minimumPercent - Minimum percentage (0-100)
 * @returns Value with control and minimum applied
 */
export function applyControlWithMinimum(
  baseValue: number,
  controlValue: number,
  minimumPercent: number
): number {
  const minimum = baseValue * (minimumPercent / 100);
  const range = baseValue - minimum;
  return minimum + range * controlValue;
}

/**
 * Compute shape dynamics for a single dab
 *
 * This is the main entry point for Shape Dynamics calculation.
 * Called once per dab during stroke rendering.
 *
 * @param baseSize - Base brush size in pixels
 * @param baseAngle - Base brush angle in degrees (0-360)
 * @param baseRoundness - Base brush roundness (0-100, where 100 = circle)
 * @param settings - Shape Dynamics settings
 * @param input - Input data (pressure, tilt, direction)
 * @param random - Random function for jitter (default: Math.random)
 * @returns Computed shape for this dab
 */
export function computeDabShape(
  baseSize: number,
  baseAngle: number,
  baseRoundness: number,
  settings: ShapeDynamicsSettings,
  input: DynamicsInput,
  random: RandomFn = Math.random
): ComputedDabShape {
  // --- Size ---
  const sizeControl = getControlValue(settings.sizeControl, input);
  let size = applyControlWithMinimum(baseSize, sizeControl, settings.minimumDiameter);
  size = applyJitter(size, settings.sizeJitter, random);
  size = Math.max(1, size); // Minimum 1px

  // --- Angle ---
  let angle = baseAngle;
  if (settings.angleControl === 'direction') {
    // Direction control: angle follows stroke direction
    angle = input.direction;
  } else if (settings.angleControl === 'initial') {
    // Initial direction control
    angle = input.initialDirection;
  } else if (settings.angleControl !== 'off') {
    // Other controls: modulate base angle by control value
    const angleControl = getControlValue(settings.angleControl, input);
    angle = baseAngle * angleControl;
  }
  angle = applyAngleJitter(angle, settings.angleJitter, random);

  // --- Roundness ---
  const roundnessControl = getControlValue(settings.roundnessControl, input);
  let roundness = applyControlWithMinimum(
    baseRoundness,
    roundnessControl,
    settings.minimumRoundness
  );
  roundness = applyJitter(roundness, settings.roundnessJitter, random);
  roundness = Math.max(1, Math.min(100, roundness)); // Clamp 1-100

  // --- Flip ---
  const flipX = settings.flipXJitter && random() > 0.5;
  const flipY = settings.flipYJitter && random() > 0.5;

  return {
    size,
    angle,
    roundness: roundness / 100, // Convert to 0-1 for rendering
    flipX,
    flipY,
  };
}

/**
 * Calculate stroke direction from two consecutive points
 *
 * @param x1 - Previous point X
 * @param y1 - Previous point Y
 * @param x2 - Current point X
 * @param y2 - Current point Y
 * @returns Direction in degrees (0-360, where 0 = right, 90 = down)
 */
export function calculateDirection(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;

  // Handle zero movement
  if (dx === 0 && dy === 0) {
    return 0;
  }

  // atan2 returns radians from -PI to PI
  // Convert to degrees and normalize to 0-360
  const radians = Math.atan2(dy, dx);
  const degrees = (radians * 180) / Math.PI;
  return ((degrees % 360) + 360) % 360;
}

/**
 * Check if Shape Dynamics would have any effect
 *
 * Useful for performance optimization - skip computation when all settings are off
 *
 * @param settings - Shape Dynamics settings
 * @returns true if any dynamics are active
 */
export function isShapeDynamicsActive(settings: ShapeDynamicsSettings): boolean {
  return (
    settings.sizeJitter > 0 ||
    settings.sizeControl !== 'off' ||
    settings.angleJitter > 0 ||
    settings.angleControl !== 'off' ||
    settings.roundnessJitter > 0 ||
    settings.roundnessControl !== 'off' ||
    settings.flipXJitter ||
    settings.flipYJitter
  );
}
