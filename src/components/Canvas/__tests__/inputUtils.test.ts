import { describe, it, expect } from 'vitest';
import type { RawInputPoint } from '@/stores/tablet';
import {
  getEffectiveInputData,
  LARGE_CANVAS_MIN_START_PRESSURE,
  resolvePointerDownPressure,
} from '../inputUtils';

function createRawPoint(partial: Partial<RawInputPoint> = {}): RawInputPoint {
  return {
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    pressure: partial.pressure ?? 0.5,
    tilt_x: partial.tilt_x ?? 0,
    tilt_y: partial.tilt_y ?? 0,
    timestamp_ms: partial.timestamp_ms ?? performance.now(),
  };
}

function createPointerEvent(
  type: string,
  init: PointerEventInit & { pointerType?: string } = {}
): PointerEvent {
  return {
    type,
    bubbles: true,
    cancelable: true,
    pointerType: init.pointerType ?? 'pen',
    pressure: init.pressure ?? 0,
    tiltX: init.tiltX ?? 0,
    tiltY: init.tiltY ?? 0,
  } as PointerEvent;
}

describe('inputUtils', () => {
  it('resolvePointerDownPressure: 优先使用 WinTab 缓冲点', () => {
    const evt = createPointerEvent('pointerdown', { pointerType: 'pen', pressure: 0.8 });
    const bufferedPoints = [createRawPoint({ pressure: 0.42 })];
    const currentPoint = createRawPoint({ pressure: 0.9 });

    const result = resolvePointerDownPressure(evt, true, bufferedPoints, currentPoint, true);

    expect(result.source).toBe('buffered');
    expect(result.pressure).toBe(0.42);
  });

  it('resolvePointerDownPressure: 缓冲为空时使用新鲜 currentPoint', () => {
    const evt = createPointerEvent('pointerdown', { pointerType: 'pen', pressure: 0.7 });
    const currentPoint = createRawPoint({
      pressure: 0.31,
      timestamp_ms: performance.now(),
    });

    const result = resolvePointerDownPressure(evt, true, [], currentPoint, true);

    expect(result.source).toBe('current-point');
    expect(result.pressure).toBe(0.31);
  });

  it('resolvePointerDownPressure: currentPoint 过期时回退到 PointerEvent pressure', () => {
    const evt = createPointerEvent('pointerdown', { pointerType: 'pen', pressure: 0.66 });
    const stalePoint = createRawPoint({
      pressure: 0.99,
      timestamp_ms: performance.now() - 300,
    });

    const result = resolvePointerDownPressure(evt, true, [], stalePoint, true);

    expect(result.source).toBe('pointer-event');
    expect(result.pressure).toBe(0.66);
  });

  it('resolvePointerDownPressure: 大画布无可用压力时使用最小兜底', () => {
    const evt = createPointerEvent('pointerdown', { pointerType: 'pen', pressure: 0 });
    const stalePoint = createRawPoint({
      pressure: 0.99,
      timestamp_ms: performance.now() - 300,
    });

    const result = resolvePointerDownPressure(evt, true, [], stalePoint, true);

    expect(result.source).toBe('large-canvas-floor');
    expect(result.pressure).toBe(LARGE_CANVAS_MIN_START_PRESSURE);
  });

  it('getEffectiveInputData: WinTab 下 currentPoint 过期时回退到 PointerEvent', () => {
    const evt = createPointerEvent('pointermove', {
      pointerType: 'pen',
      pressure: 0.55,
      tiltX: 12,
      tiltY: -6,
    });
    const stalePoint = createRawPoint({
      pressure: 0.91,
      tilt_x: 25,
      tilt_y: 25,
      timestamp_ms: performance.now() - 300,
    });

    const result = getEffectiveInputData(evt, true, [], stalePoint);

    expect(result.source).toBe('pointer-event');
    expect(result.pressure).toBe(0.55);
    expect(result.tiltX).toBe(12);
    expect(result.tiltY).toBe(-6);
  });

  it('getEffectiveInputData: WinTab 无可用压力时走 fallback', () => {
    const evt = createPointerEvent('pointermove', {
      pointerType: 'mouse',
      pressure: 0,
      tiltX: 0,
      tiltY: 0,
    });

    const result = getEffectiveInputData(evt, true, [], null);

    expect(result.source).toBe('fallback');
    expect(result.pressure).toBe(0.5);
  });
});
