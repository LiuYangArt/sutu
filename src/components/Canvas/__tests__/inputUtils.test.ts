import { describe, it, expect } from 'vitest';
import type { RawInputPoint } from '@/stores/tablet';
import { getEffectiveInputData } from '../inputUtils';

function createRawPoint(partial: Partial<RawInputPoint> = {}): RawInputPoint {
  return {
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    pressure: partial.pressure ?? 0.5,
    tilt_x: partial.tilt_x ?? 0,
    tilt_y: partial.tilt_y ?? 0,
    rotation: partial.rotation,
    timestamp_ms: partial.timestamp_ms ?? 0,
  };
}

function createPointerEvent(
  init: Partial<PointerEvent> & {
    pointerType?: string;
    pressure?: number;
    twist?: number;
    altitudeAngle?: number;
    azimuthAngle?: number;
  } = {}
): PointerEvent {
  return {
    pointerType: init.pointerType ?? 'pen',
    pressure: init.pressure ?? 0,
    tiltX: init.tiltX ?? 0,
    tiltY: init.tiltY ?? 0,
    twist: init.twist ?? 0,
    altitudeAngle: init.altitudeAngle,
    azimuthAngle: init.azimuthAngle,
  } as PointerEvent;
}

describe('inputUtils.getEffectiveInputData', () => {
  it('非 WinTab 模式使用 PointerEvent，并归一化 tilt 与读取 twist', () => {
    const evt = createPointerEvent({ pressure: 0.62, tiltX: 45, tiltY: -30, twist: 270 });
    const result = getEffectiveInputData(evt, false, [], null);
    expect(result).toEqual({ pressure: 0.62, tiltX: 0.5, tiltY: -1 / 3, rotation: 270 });
  });

  it('tiltX/tiltY 不可用时回退 altitude/azimuth', () => {
    const evt = createPointerEvent({
      pressure: 0.2,
      tiltX: 0,
      tiltY: 0,
      altitudeAngle: Math.PI / 4,
      azimuthAngle: 0,
    });
    const result = getEffectiveInputData(evt, false, [], null);
    expect(result.pressure).toBe(0.2);
    expect(result.tiltX).toBeCloseTo(0.5, 6);
    expect(result.tiltY).toBeCloseTo(0, 6);
    expect(result.rotation).toBe(0);
  });

  it('coalesced 样本缺少 tilt/twist 时回退主 PointerEvent 姿态', () => {
    const sampled = createPointerEvent({ pressure: 0.55, tiltX: 0, tiltY: 0, twist: 0 });
    const fallback = createPointerEvent({ pressure: 0.8, tiltX: 36, tiltY: -18, twist: 123 });
    const result = getEffectiveInputData(sampled, false, [], null, fallback);
    expect(result).toEqual({
      pressure: 0.55,
      tiltX: 36 / 90,
      tiltY: -18 / 90,
      rotation: 123,
    });
  });

  it('WinTab 优先使用 buffered 点', () => {
    const evt = createPointerEvent({ pressure: 0.8, tiltX: 5, tiltY: 5, twist: 30 });
    const buffered = [createRawPoint({ pressure: 0.33, tilt_x: 21, tilt_y: -12, rotation: 210 })];
    const current = createRawPoint({ pressure: 0.9, tilt_x: 30, tilt_y: 30, rotation: 320 });
    const result = getEffectiveInputData(evt, true, buffered, current);
    expect(result).toEqual({ pressure: 0.33, tiltX: 21 / 90, tiltY: -12 / 90, rotation: 210 });
  });

  it('WinTab 无 buffered 时回退 currentPoint', () => {
    const evt = createPointerEvent({ pressure: 0.7, tiltX: 0, tiltY: 0, twist: 75 });
    const current = createRawPoint({ pressure: 0.41, tilt_x: 8, tilt_y: 3, rotation: 288 });
    const result = getEffectiveInputData(evt, true, [], current);
    expect(result).toEqual({ pressure: 0.41, tiltX: 8 / 90, tiltY: 3 / 90, rotation: 288 });
  });

  it('WinTab 点缺少 rotation 时回退 PointerEvent twist', () => {
    const evt = createPointerEvent({ pressure: 0.4, tiltX: 2, tiltY: -1, twist: 123 });
    const buffered = [createRawPoint({ pressure: 0.39, tilt_x: 4, tilt_y: -2 })];
    const result = getEffectiveInputData(evt, true, buffered, null);
    expect(result).toEqual({ pressure: 0.39, tiltX: 4 / 90, tiltY: -2 / 90, rotation: 123 });
  });

  it('WinTab pen 无可用数据时返回 0 压力', () => {
    const evt = createPointerEvent({
      pointerType: 'pen',
      pressure: 0,
      tiltX: 1,
      tiltY: 2,
      twist: 9,
    });
    const result = getEffectiveInputData(evt, true, [], null);
    expect(result).toEqual({ pressure: 0, tiltX: 1 / 90, tiltY: 2 / 90, rotation: 9 });
  });

  it('WinTab mouse 无可用数据时返回 0.5 压力兜底', () => {
    const evt = createPointerEvent({ pointerType: 'mouse', pressure: 0, tiltX: 1, tiltY: 2 });
    const result = getEffectiveInputData(evt, true, [], null);
    expect(result).toEqual({ pressure: 0.5, tiltX: 1 / 90, tiltY: 2 / 90, rotation: 0 });
  });
});
