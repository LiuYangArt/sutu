import { describe, expect, it } from 'vitest';
import { computeDabColor } from './colorDynamics';
import { DEFAULT_COLOR_DYNAMICS } from '@/stores/tool';
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

describe('colorDynamics control semantics', () => {
  it('foreground/background control 在 jitter=0 时直接控制主混合比例', () => {
    const settings = {
      ...DEFAULT_COLOR_DYNAMICS,
      foregroundBackgroundControl: 'penPressure' as const,
      foregroundBackgroundJitter: 0,
    };

    const fg = '#ff0000';
    const bg = '#00ff00';

    const highPressure = computeDabColor(fg, bg, settings, createInput({ pressure: 1 }), () => 0.5);
    const lowPressure = computeDabColor(fg, bg, settings, createInput({ pressure: 0 }), () => 0.5);

    // pressure=1 => control=1 => mixFactor=0 => foreground
    expect(highPressure.color.toLowerCase()).toBe(fg);
    // pressure=0 => control=0 => mixFactor=1 => background
    expect(lowPressure.color.toLowerCase()).toBe(bg);
  });
});
