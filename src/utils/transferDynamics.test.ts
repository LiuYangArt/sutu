import { describe, expect, it } from 'vitest';
import { computeDabTransfer } from './transferDynamics';
import { DEFAULT_TRANSFER_SETTINGS } from '@/stores/tool';
import type { DynamicsInput } from './shapeDynamics';

function createInput(partial: Partial<DynamicsInput> = {}): DynamicsInput {
  return {
    pressure: partial.pressure ?? 1,
    tiltX: partial.tiltX ?? 0,
    tiltY: partial.tiltY ?? 0,
    rotation: partial.rotation ?? 0,
    direction: partial.direction ?? 0,
    initialDirection: partial.initialDirection ?? 0,
    fadeProgress: partial.fadeProgress ?? 0,
  };
}

describe('transferDynamics control semantics', () => {
  it('opacity control 在 jitter=0 时直接作用 opacity 本体', () => {
    const settings = {
      ...DEFAULT_TRANSFER_SETTINGS,
      opacityControl: 'penTilt' as const,
      opacityJitter: 0,
      minimumOpacity: 0,
    };
    const input = createInput({ tiltX: 0.5, tiltY: 0 });
    const result = computeDabTransfer(1, 1, settings, input, () => 0.5);
    expect(result.opacity).toBeCloseTo(0.5, 6);
  });

  it('flow control 在 jitter=0 时直接作用 flow 本体', () => {
    const settings = {
      ...DEFAULT_TRANSFER_SETTINGS,
      flowControl: 'penPressure' as const,
      flowJitter: 0,
      minimumFlow: 0,
    };
    const input = createInput({ pressure: 0.3 });
    const result = computeDabTransfer(1, 1, settings, input, () => 0.5);
    expect(result.flow).toBeCloseTo(0.3, 6);
  });
});
