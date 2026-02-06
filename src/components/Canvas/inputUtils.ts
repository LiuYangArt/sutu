import { RawInputPoint } from '@/stores/tablet';

export const LARGE_CANVAS_THRESHOLD = 4096;
export const LARGE_CANVAS_MIN_START_PRESSURE = 0.03;
export const WINTAB_CURRENT_POINT_MAX_AGE_MS = 80;

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function isLargeCanvas(width: number, height: number): boolean {
  return Math.max(width, height) >= LARGE_CANVAS_THRESHOLD;
}

export function isFreshCurrentPoint(
  point: RawInputPoint | null,
  maxAgeMs: number = WINTAB_CURRENT_POINT_MAX_AGE_MS,
  now: number = nowMs()
): point is RawInputPoint {
  if (!point) return false;
  const age = Math.abs(point.timestamp_ms - now);
  return Number.isFinite(age) && age <= maxAgeMs;
}

function getWinTabPressureFallback(evt: PointerEvent): number {
  if (evt.pointerType === 'pen') return 0;
  if (evt.pressure > 0) return evt.pressure;
  return 0.5;
}

export interface EffectiveInputData {
  pressure: number;
  tiltX: number;
  tiltY: number;
  source: 'buffered' | 'current-point' | 'pointer-event' | 'fallback';
}

export interface PointerDownPressureResult {
  pressure: number;
  source:
    | 'buffered'
    | 'current-point'
    | 'pointer-event'
    | 'large-canvas-floor'
    | 'pen-zero'
    | 'non-pen-default';
}

export function resolvePointerDownPressure(
  evt: PointerEvent,
  shouldUseWinTab: boolean,
  bufferedPoints: RawInputPoint[],
  currentPoint: RawInputPoint | null,
  largeCanvasMode: boolean
): PointerDownPressureResult {
  const pointerPressure = evt.pressure > 0 ? evt.pressure : 0;

  if (evt.pointerType !== 'pen') {
    if (pointerPressure > 0) {
      return { pressure: pointerPressure, source: 'pointer-event' };
    }
    return { pressure: 0.5, source: 'non-pen-default' };
  }

  if (shouldUseWinTab && bufferedPoints.length > 0) {
    return { pressure: bufferedPoints[bufferedPoints.length - 1]!.pressure, source: 'buffered' };
  }

  if (shouldUseWinTab && isFreshCurrentPoint(currentPoint)) {
    return { pressure: currentPoint.pressure, source: 'current-point' };
  }

  if (pointerPressure > 0) {
    return { pressure: pointerPressure, source: 'pointer-event' };
  }

  if (largeCanvasMode) {
    return { pressure: LARGE_CANVAS_MIN_START_PRESSURE, source: 'large-canvas-floor' };
  }

  return { pressure: 0, source: 'pen-zero' };
}

/**
 * Resolves pressure and tilt data, preferring WinTab buffer if active.
 * Respects pressure=0 from backend smoothing.
 */
export function getEffectiveInputData(
  evt: PointerEvent,
  isWinTabActive: boolean,
  bufferedPoints: RawInputPoint[],
  currentPoint: RawInputPoint | null
): EffectiveInputData {
  if (!isWinTabActive) {
    return {
      pressure: evt.pressure,
      tiltX: evt.tiltX,
      tiltY: evt.tiltY,
      source: 'pointer-event',
    };
  }

  // Note: WinTab timestamps (pkTime) are not guaranteed to share a time origin with
  // PointerEvent.timeStamp, so we avoid time-based matching here.
  // Use the most recent WinTab sample we have for this event batch.
  if (bufferedPoints.length > 0) {
    const pt = bufferedPoints[bufferedPoints.length - 1]!;
    return {
      pressure: pt.pressure,
      tiltX: pt.tilt_x,
      tiltY: pt.tilt_y,
      source: 'buffered',
    };
  }

  // 2. Fallback: Use currentPoint (last known input) if it is fresh
  if (isFreshCurrentPoint(currentPoint)) {
    return {
      pressure: currentPoint.pressure,
      tiltX: currentPoint.tilt_x,
      tiltY: currentPoint.tilt_y,
      source: 'current-point',
    };
  }

  // 3. Next fallback: use PointerEvent pressure if available
  if (evt.pressure > 0) {
    return {
      pressure: evt.pressure,
      tiltX: evt.tiltX,
      tiltY: evt.tiltY,
      source: 'pointer-event',
    };
  }

  // 4. Ultimate Fallback
  return {
    // Mouse/touch often report pressure=0; use 0.5 as a reasonable default.
    // In WinTab mode, treat pen pressure as unknown (0) when we can't match tablet samples.
    pressure: getWinTabPressureFallback(evt),
    tiltX: evt.tiltX,
    tiltY: evt.tiltY,
    source: 'fallback',
  };
}
