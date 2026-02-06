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
    timestamp_ms: partial.timestamp_ms ?? 0,
  };
}

function createPointerEvent(
  init: Partial<PointerEvent> & { pointerType?: string; pressure?: number } = {}
): PointerEvent {
  return {
    pointerType: init.pointerType ?? 'pen',
    pressure: init.pressure ?? 0,
    tiltX: init.tiltX ?? 0,
    tiltY: init.tiltY ?? 0,
  } as PointerEvent;
}

describe('inputUtils.getEffectiveInputData', () => {
  it('非 WinTab 模式直接使用 PointerEvent', () => {
    const evt = createPointerEvent({ pressure: 0.62, tiltX: 11, tiltY: -7 });
    const result = getEffectiveInputData(evt, false, [], null);
    expect(result).toEqual({ pressure: 0.62, tiltX: 11, tiltY: -7 });
  });

  it('WinTab 优先使用 buffered 点', () => {
    const evt = createPointerEvent({ pressure: 0.8, tiltX: 5, tiltY: 5 });
    const buffered = [createRawPoint({ pressure: 0.33, tilt_x: 21, tilt_y: -12 })];
    const current = createRawPoint({ pressure: 0.9, tilt_x: 30, tilt_y: 30 });
    const result = getEffectiveInputData(evt, true, buffered, current);
    expect(result).toEqual({ pressure: 0.33, tiltX: 21, tiltY: -12 });
  });

  it('WinTab 无 buffered 时回退 currentPoint', () => {
    const evt = createPointerEvent({ pressure: 0.7, tiltX: 0, tiltY: 0 });
    const current = createRawPoint({ pressure: 0.41, tilt_x: 8, tilt_y: 3 });
    const result = getEffectiveInputData(evt, true, [], current);
    expect(result).toEqual({ pressure: 0.41, tiltX: 8, tiltY: 3 });
  });

  it('WinTab pen 无可用数据时返回 0 压力', () => {
    const evt = createPointerEvent({ pointerType: 'pen', pressure: 0, tiltX: 1, tiltY: 2 });
    const result = getEffectiveInputData(evt, true, [], null);
    expect(result).toEqual({ pressure: 0, tiltX: 1, tiltY: 2 });
  });

  it('WinTab mouse 无可用数据时返回 0.5 压力兜底', () => {
    const evt = createPointerEvent({ pointerType: 'mouse', pressure: 0, tiltX: 1, tiltY: 2 });
    const result = getEffectiveInputData(evt, true, [], null);
    expect(result).toEqual({ pressure: 0.5, tiltX: 1, tiltY: 2 });
  });
});
