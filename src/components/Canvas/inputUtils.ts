import { RawInputPoint } from '@/stores/tablet';

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

  // 1. Search backwards for the latest relevant point in buffer
  for (let i = bufferedPoints.length - 1; i >= 0; i--) {
    const pt = bufferedPoints[i];
    if (!pt) continue;

    // Find point with timestamp <= event time + tolerance
    if (pt.timestamp_ms <= eventTime + toleranceMs) {
      return {
        pressure: pt.pressure,
        tiltX: pt.tilt_x,
        tiltY: pt.tilt_y,
      };
    }
  }

  // 2. Fallback: Use currentPoint (last known input) if available
  if (currentPoint) {
    return {
      pressure: currentPoint.pressure,
      tiltX: currentPoint.tilt_x,
      tiltY: currentPoint.tilt_y,
    };
  }

  // 3. Ultimate Fallback: Use PointerEvent data
  return {
    pressure: evt.pressure > 0 ? evt.pressure : 0.5,
    tiltX: evt.tiltX,
    tiltY: evt.tiltY,
  };
}
