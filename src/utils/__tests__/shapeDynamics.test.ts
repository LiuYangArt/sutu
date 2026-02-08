import { describe, it, expect } from 'vitest';
import { computeDabShape, type DynamicsInput } from '../shapeDynamics';
import { DEFAULT_SHAPE_DYNAMICS } from '@/stores/tool';

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

describe('shapeDynamics control semantics', () => {
  it('angle control 在 angleJitter=0 时直接驱动 angle（不依赖 jitter）', () => {
    const settings = {
      ...DEFAULT_SHAPE_DYNAMICS,
      angleControl: 'penTilt' as const,
      angleJitter: 0,
    };
    const input = createInput({ tiltX: 0.5, tiltY: 0 }); // control = 0.5
    const shape = computeDabShape(20, 0, 100, settings, input, () => 0.5);
    expect(shape.angle).toBeCloseTo(180, 6);
  });

  it('angle control 叠加 baseAngle 作为偏移', () => {
    const settings = {
      ...DEFAULT_SHAPE_DYNAMICS,
      angleControl: 'penTilt' as const,
      angleJitter: 0,
    };
    const input = createInput({ tiltX: 0.5, tiltY: 0 }); // control = 0.5 -> +180
    const shape = computeDabShape(20, 30, 100, settings, input, () => 0.5);
    expect(shape.angle).toBeCloseTo(210, 6);
  });

  it('roundness control 在 roundnessJitter=0 时直接驱动 roundness', () => {
    const settings = {
      ...DEFAULT_SHAPE_DYNAMICS,
      roundnessControl: 'penTilt' as const,
      roundnessJitter: 0,
      minimumRoundness: 25,
    };
    const input = createInput({ tiltX: 0.5, tiltY: 0 }); // control = 0.5
    const shape = computeDabShape(20, 0, 100, settings, input, () => 0.5);
    // 25 + (100-25) * 0.5 = 62.5%
    expect(shape.roundness).toBeCloseTo(0.625, 6);
  });

  it('direction control 直接驱动 angle，本体不依赖 jitter', () => {
    const settings = {
      ...DEFAULT_SHAPE_DYNAMICS,
      angleControl: 'direction' as const,
      angleJitter: 0,
    };
    const input = createInput({ direction: 140 });
    const shape = computeDabShape(20, 0, 100, settings, input, () => 0.5);
    expect(shape.angle).toBeCloseTo(140, 6);
  });

  it('initial direction control 使用首方向并叠加 baseAngle 偏移', () => {
    const settings = {
      ...DEFAULT_SHAPE_DYNAMICS,
      angleControl: 'initial' as const,
      angleJitter: 0,
    };
    const input = createInput({ initialDirection: 90 });
    const shape = computeDabShape(20, 30, 100, settings, input, () => 0.5);
    expect(shape.angle).toBeCloseTo(120, 6);
  });
});
