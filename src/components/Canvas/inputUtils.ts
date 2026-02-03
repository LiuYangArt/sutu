import { RawInputPoint } from '@/stores/tablet';

function getWinTabPressureFallback(evt: PointerEvent): number {
  if (evt.pointerType === 'pen') return 0;
  if (evt.pressure > 0) return evt.pressure;
  return 0.5;
}

/**
 * Resolves pressure and tilt data, preferring WinTab buffer if active.
 * Respects pressure=0 from backend smoothing.
 */
export function getEffectiveInputData(
  evt: PointerEvent,
  isWinTabActive: boolean,
  bufferedPoints: RawInputPoint[],
  currentPoint: RawInputPoint | null,
  toleranceMs: number = 20
): { pressure: number; tiltX: number; tiltY: number } {
  if (!isWinTabActive) {
    return {
      pressure: evt.pressure,
      tiltX: evt.tiltX,
      tiltY: evt.tiltY,
    };
  }

  const eventTime = evt.timeStamp;

  // 1. Find the best-matching WinTab point near this PointerEvent.
  // Prefer a sample at-or-before eventTime when possible to avoid "lookahead"
  // pressure spikes that can make the stroke start too heavy.
  let bestPast: RawInputPoint | null = null;
  let bestFuture: RawInputPoint | null = null;

  for (const pt of bufferedPoints) {
    if (!pt) continue;

    const deltaMs = pt.timestamp_ms - eventTime;
    if (Math.abs(deltaMs) > toleranceMs) continue;

    if (deltaMs <= 0) {
      if (!bestPast || pt.timestamp_ms > bestPast.timestamp_ms) {
        bestPast = pt;
      }
    } else {
      if (!bestFuture || pt.timestamp_ms < bestFuture.timestamp_ms) {
        bestFuture = pt;
      }
    }
  }

  const best = bestPast ?? bestFuture;
  if (best) {
    return {
      pressure: best.pressure,
      tiltX: best.tilt_x,
      tiltY: best.tilt_y,
    };
  }

  // 2. Fallback: Use currentPoint (last known input) if available
  if (currentPoint) {
    // Guard against stale currentPoint (e.g. previous stroke).
    // If the timestamps are not close, using it can create an overly heavy first dab.
    const maxAgeMs = Math.max(50, toleranceMs * 3);
    if (Math.abs(currentPoint.timestamp_ms - eventTime) > maxAgeMs) {
      return {
        // In WinTab mode, PointerEvent.pressure is often the "device unsupported" default (0.5).
        // Treat pen pressure as unknown (0) when WinTab data is not synchronized.
        pressure: getWinTabPressureFallback(evt),
        tiltX: evt.tiltX,
        tiltY: evt.tiltY,
      };
    }
    return {
      pressure: currentPoint.pressure,
      tiltX: currentPoint.tilt_x,
      tiltY: currentPoint.tilt_y,
    };
  }

  // 3. Ultimate Fallback: Use PointerEvent data
  return {
    // Mouse/touch often report pressure=0; use 0.5 as a reasonable default.
    // In WinTab mode, treat pen pressure as unknown (0) when we can't match tablet samples.
    pressure: getWinTabPressureFallback(evt),
    tiltX: evt.tiltX,
    tiltY: evt.tiltY,
  };
}
