import { RawInputPoint } from '@/stores/tablet';

/**
 * Resolves pressure and tilt data, preferring WinTab buffer if active
 *
 * IMPORTANT: Do NOT filter out pressure=0 points!
 * The backend PressureSmoother intentionally returns 0 for the first few samples
 * to prevent heavy first dab. We must respect this.
 *
 * @param evt The original pointer event
 * @param isWinTabActive Whether WinTab backend is currently active
 * @param bufferedPoints Buffered WinTab points to match against
 * @param currentPoint The last known valid WinTab point, if any
 * @param toleranceMs Time matching tolerance in ms
 */
export function getEffectiveInputData(
  evt: PointerEvent,
  isWinTabActive: boolean,
  bufferedPoints: RawInputPoint[],
  currentPoint: RawInputPoint | null,
  toleranceMs: number = 20 // Relaxed tolerance
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
  // NOTE: We accept pressure=0 now - backend's PressureSmoother returns 0
  // intentionally for the first few samples to prevent heavy first dab
  for (let i = bufferedPoints.length - 1; i >= 0; i--) {
    const pt = bufferedPoints[i];
    if (!pt) continue;

    // Find point with timestamp <= event time + tolerance
    if (pt.timestamp_ms <= eventTime + toleranceMs) {
      // Accept ALL pressure values, including 0
      // The backend has already applied smoothing/fade-in
      return {
        pressure: pt.pressure,
        tiltX: pt.tilt_x,
        tiltY: pt.tilt_y,
      };
    }
  }

  // 2. Fallback: Use currentPoint (last known input) if available
  // This handles cases where WinTab data is sparse or bufferedPoints is empty
  if (currentPoint) {
    return {
      pressure: currentPoint.pressure,
      tiltX: currentPoint.tilt_x,
      tiltY: currentPoint.tilt_y,
    };
  }

  // 3. Ultimate Fallback: Use PointerEvent data
  // Note: Windows Ink 'pressure' might be available even if WinTab logic missed
  return {
    pressure: evt.pressure > 0 ? evt.pressure : 0.5,
    tiltX: evt.tiltX,
    tiltY: evt.tiltY,
  };
}
