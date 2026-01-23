/**
 * Transfer Dynamics algorithms for brush rendering
 *
 * Implements Photoshop-compatible Transfer:
 * - Opacity Jitter with control source and minimum
 * - Flow Jitter with control source and minimum
 *
 * CPU implementation as Ground Truth for GPU replication.
 */

import { ControlSource, TransferSettings } from '@/stores/tool';
import {
  getControlValue,
  applyJitter,
  applyControlWithMinimum,
  type DynamicsInput,
  type RandomFn,
} from './shapeDynamics';

/**
 * Compute a single transfer value (opacity or flow) with control and jitter
 */
function computeTransferValue(
  base: number,
  control: ControlSource,
  minimum: number,
  jitter: number,
  input: DynamicsInput,
  random: RandomFn
): number {
  let value = base;
  if (control !== 'off') {
    value = applyControlWithMinimum(base, getControlValue(control, input), minimum);
  }
  if (jitter > 0) {
    value = applyJitter(value, jitter, random);
  }
  return Math.max(0, Math.min(1, value));
}

/**
 * Computed transfer values for a single dab
 */
export interface ComputedDabTransfer {
  /** Final opacity (0-1) */
  opacity: number;
  /** Final flow (0-1) */
  flow: number;
}

/**
 * Compute transfer dynamics for a single dab
 *
 * This is the main entry point for Transfer calculation.
 * Called once per dab during stroke rendering.
 *
 * Processing order:
 * 1. Apply control source to get base-controlled value
 * 2. Apply jitter on top of controlled value
 * 3. Clamp to valid range
 *
 * @param baseOpacity - Base opacity value (0-1)
 * @param baseFlow - Base flow value (0-1)
 * @param settings - Transfer settings
 * @param input - Input data (pressure, tilt, direction)
 * @param random - Random function for jitter (default: Math.random)
 * @returns Computed opacity and flow for this dab
 */
export function computeDabTransfer(
  baseOpacity: number,
  baseFlow: number,
  settings: TransferSettings,
  input: DynamicsInput,
  random: RandomFn = Math.random
): ComputedDabTransfer {
  const opacity = computeTransferValue(
    baseOpacity,
    settings.opacityControl,
    settings.minimumOpacity,
    settings.opacityJitter,
    input,
    random
  );
  const flow = computeTransferValue(
    baseFlow,
    settings.flowControl,
    settings.minimumFlow,
    settings.flowJitter,
    input,
    random
  );
  return { opacity, flow };
}

/**
 * Check if Transfer would have any effect
 *
 * Useful for performance optimization - skip computation when all settings are off
 *
 * @param settings - Transfer settings
 * @returns true if any transfer dynamics are active
 */
export function isTransferActive(settings: TransferSettings): boolean {
  return (
    settings.opacityJitter > 0 ||
    settings.opacityControl !== 'off' ||
    settings.flowJitter > 0 ||
    settings.flowControl !== 'off'
  );
}
