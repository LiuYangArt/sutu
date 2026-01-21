/**
 * Scatter Dynamics algorithms for brush rendering
 *
 * Implements Photoshop-compatible Scattering:
 * - Scatter: displacement perpendicular to stroke direction
 * - Both Axes: scatter in both perpendicular and parallel directions
 * - Count: multiple dabs per spacing interval
 * - Count Jitter: randomize dab count
 *
 * CPU implementation as Ground Truth for GPU replication.
 */

import { ScatterSettings } from '@/stores/tool';
import { getControlValue, DynamicsInput, RandomFn } from './shapeDynamics';

/**
 * Result of scatter computation - one or more scattered dab positions
 */
export interface ScatteredDab {
  x: number;
  y: number;
}

/**
 * Input for scatter computation
 */
export interface ScatterInput {
  /** Original dab X position */
  x: number;
  /** Original dab Y position */
  y: number;
  /** Stroke direction in radians */
  strokeAngle: number;
  /** Current brush diameter in pixels */
  diameter: number;
  /** Dynamics input for control source evaluation */
  dynamics: DynamicsInput;
}

/**
 * Apply scatter to a single dab position
 *
 * Returns array of scattered positions (length >= 1).
 * When scatter=0 and count=1, returns the original position.
 *
 * @param input - Input dab position and context
 * @param settings - Scatter settings
 * @param random - Random function for jitter (default: Math.random)
 * @returns Array of scattered dab positions
 */
export function applyScatter(
  input: ScatterInput,
  settings: ScatterSettings,
  random: RandomFn = Math.random
): ScatteredDab[] {
  const { x, y, strokeAngle, diameter, dynamics } = input;

  // 1. Calculate effective scatter amount
  // Scatter is a percentage of brush diameter (0-1000%)
  const scatterControl = getControlValue(settings.scatterControl, dynamics);
  const scatterAmount = (settings.scatter / 100) * diameter * scatterControl;

  // 2. Calculate effective count
  const countControl = getControlValue(settings.countControl, dynamics);
  const baseCount = Math.max(1, Math.round(settings.count * countControl));

  // Apply count jitter: ±jitterPercent of baseCount
  const jitterRange = (settings.countJitter / 100) * baseCount;
  const countOffset = (random() * 2 - 1) * jitterRange;
  const actualCount = Math.max(1, Math.round(baseCount + countOffset));

  // 3. Generate scattered positions
  const results: ScatteredDab[] = [];

  // Perpendicular angle (90° from stroke direction)
  const perpAngle = strokeAngle + Math.PI / 2;

  for (let i = 0; i < actualCount; i++) {
    // Perpendicular offset (always applied when scatter > 0)
    // Random value in range [-scatterAmount, +scatterAmount]
    const perpOffset = (random() * 2 - 1) * scatterAmount;

    // Parallel offset (only if bothAxes is true)
    const paraOffset = settings.bothAxes ? (random() * 2 - 1) * scatterAmount : 0;

    // Convert to canvas coordinates
    // perpOffset moves perpendicular to stroke direction
    // paraOffset moves along stroke direction
    results.push({
      x: x + Math.cos(perpAngle) * perpOffset + Math.cos(strokeAngle) * paraOffset,
      y: y + Math.sin(perpAngle) * perpOffset + Math.sin(strokeAngle) * paraOffset,
    });
  }

  return results;
}

/**
 * Check if Scatter would have any effect
 *
 * Useful for performance optimization - skip computation when all settings are off
 *
 * @param settings - Scatter settings
 * @returns true if scatter would modify dab positions or count
 */
export function isScatterActive(settings: ScatterSettings): boolean {
  // Scatter is active if:
  // - scatter > 0 (positions will be displaced)
  // - count > 1 (multiple dabs per spacing interval)
  return settings.scatter > 0 || settings.count > 1;
}
