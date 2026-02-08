import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXTURE_SETTINGS } from '@/components/BrushPanel/types';
import { computeTextureDepth, depthControlToSource, sourceToDepthControl } from './textureDynamics';
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

describe('textureDynamics mapping', () => {
  it('maps depthControl index <-> control source consistently', () => {
    expect(depthControlToSource(0)).toBe('off');
    expect(depthControlToSource(1)).toBe('fade');
    expect(depthControlToSource(2)).toBe('penPressure');
    expect(depthControlToSource(3)).toBe('penTilt');
    expect(depthControlToSource(4)).toBe('rotation');
    expect(depthControlToSource(99)).toBe('off');

    expect(sourceToDepthControl('off')).toBe(0);
    expect(sourceToDepthControl('fade')).toBe(1);
    expect(sourceToDepthControl('penPressure')).toBe(2);
    expect(sourceToDepthControl('penTilt')).toBe(3);
    expect(sourceToDepthControl('rotation')).toBe(4);
    expect(sourceToDepthControl('direction')).toBe(0);
  });
});

describe('computeTextureDepth semantics', () => {
  it('textureEachTip=false 时忽略 control/jitter，仅使用基准 depth', () => {
    const settings = {
      ...DEFAULT_TEXTURE_SETTINGS,
      textureEachTip: false,
      depth: 60,
      minimumDepth: 30,
      depthJitter: 80,
      depthControl: 2,
    };
    const input = createInput({ pressure: 0.2 });
    const result = computeTextureDepth(settings.depth, settings, input, () => 1);
    expect(result).toBe(60);
  });

  it('control 在 jitter=0 时直接作用 depth 主属性', () => {
    const settings = {
      ...DEFAULT_TEXTURE_SETTINGS,
      textureEachTip: true,
      depth: 100,
      minimumDepth: 0,
      depthJitter: 0,
      depthControl: 2, // penPressure
    };
    const input = createInput({ pressure: 0.3 });
    const result = computeTextureDepth(settings.depth, settings, input, () => 0.5);
    expect(result).toBeCloseTo(30, 6);
  });

  it('minimumDepth 生效后，jitter 仅做附加扰动', () => {
    const settings = {
      ...DEFAULT_TEXTURE_SETTINGS,
      textureEachTip: true,
      depth: 80,
      minimumDepth: 25,
      depthJitter: 10,
      depthControl: 2, // penPressure
    };
    const input = createInput({ pressure: 0.5 });
    // 控制后: 20 + (80-20)*0.5 = 50; jitter +10% => +5
    const result = computeTextureDepth(settings.depth, settings, input, () => 1);
    expect(result).toBeCloseTo(55, 6);
  });
});
