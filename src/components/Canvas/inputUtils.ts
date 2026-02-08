import { RawInputPoint } from '@/stores/tablet';

function getWinTabPressureFallback(evt: PointerEvent): number {
  if (evt.pointerType === 'pen') return 0;
  if (evt.pressure > 0) return evt.pressure;
  return 0.5;
}

function clampSignedUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function normalizeTiltComponent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clampSignedUnit(value / 90);
}

type PointerEventWithAngles = PointerEvent & {
  altitudeAngle?: number;
  azimuthAngle?: number;
  twist?: number;
};

function getNormalizedTiltFromPointerEvent(evt: PointerEvent): { tiltX: number; tiltY: number } {
  const tiltX = normalizeTiltComponent(evt.tiltX);
  const tiltY = normalizeTiltComponent(evt.tiltY);
  if (Math.abs(tiltX) > 1e-5 || Math.abs(tiltY) > 1e-5) {
    return { tiltX, tiltY };
  }

  const evtWithAngles = evt as PointerEventWithAngles;
  const altitude = evtWithAngles.altitudeAngle;
  const azimuth = evtWithAngles.azimuthAngle;
  if (!Number.isFinite(altitude) || !Number.isFinite(azimuth)) {
    return { tiltX, tiltY };
  }

  const clampedAltitude = Math.max(0, Math.min(Math.PI / 2, altitude!));
  const magnitude = 1 - clampedAltitude / (Math.PI / 2);
  return {
    tiltX: clampSignedUnit(Math.cos(azimuth!) * magnitude),
    tiltY: clampSignedUnit(Math.sin(azimuth!) * magnitude),
  };
}

function getRotationFromPointerEvent(evt: PointerEvent): number {
  const evtWithAngles = evt as PointerEventWithAngles;
  const twist = evtWithAngles.twist;
  if (!Number.isFinite(twist)) return 0;
  return ((twist! % 360) + 360) % 360;
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
): { pressure: number; tiltX: number; tiltY: number; rotation: number } {
  const pointerTilt = getNormalizedTiltFromPointerEvent(evt);
  const pointerRotation = getRotationFromPointerEvent(evt);

  if (!isWinTabActive) {
    return {
      pressure: evt.pressure,
      tiltX: pointerTilt.tiltX,
      tiltY: pointerTilt.tiltY,
      rotation: pointerRotation,
    };
  }

  // Note: WinTab timestamps (pkTime) are not guaranteed to share a time origin with
  // PointerEvent.timeStamp, so we avoid time-based matching here.
  // Use the most recent WinTab sample we have for this event batch.
  if (bufferedPoints.length > 0) {
    const pt = bufferedPoints[bufferedPoints.length - 1]!;
    return {
      pressure: pt.pressure,
      tiltX: normalizeTiltComponent(pt.tilt_x),
      tiltY: normalizeTiltComponent(pt.tilt_y),
      rotation: pointerRotation,
    };
  }

  // 2. Fallback: Use currentPoint (last known input) if available
  if (currentPoint) {
    return {
      pressure: currentPoint.pressure,
      tiltX: normalizeTiltComponent(currentPoint.tilt_x),
      tiltY: normalizeTiltComponent(currentPoint.tilt_y),
      rotation: pointerRotation,
    };
  }

  // 3. Ultimate Fallback: Use PointerEvent data
  return {
    // Mouse/touch often report pressure=0; use 0.5 as a reasonable default.
    // In WinTab mode, treat pen pressure as unknown (0) when we can't match tablet samples.
    pressure: getWinTabPressureFallback(evt),
    tiltX: pointerTilt.tiltX,
    tiltY: pointerTilt.tiltY,
    rotation: pointerRotation,
  };
}
