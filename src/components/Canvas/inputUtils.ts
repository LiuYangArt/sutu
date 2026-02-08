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

function resolvePointerOrientation(
  evt: PointerEvent,
  fallbackEvent?: PointerEvent
): { tiltX: number; tiltY: number; rotation: number } {
  const primaryTilt = getNormalizedTiltFromPointerEvent(evt);
  const primaryRotation = getRotationFromPointerEvent(evt);
  const hasPrimaryTilt = Math.abs(primaryTilt.tiltX) > 1e-5 || Math.abs(primaryTilt.tiltY) > 1e-5;
  const hasPrimaryRotation = Math.abs(primaryRotation) > 1e-5;

  if (!fallbackEvent || (hasPrimaryTilt && hasPrimaryRotation)) {
    return { tiltX: primaryTilt.tiltX, tiltY: primaryTilt.tiltY, rotation: primaryRotation };
  }

  const fallbackTilt = getNormalizedTiltFromPointerEvent(fallbackEvent);
  const fallbackRotation = getRotationFromPointerEvent(fallbackEvent);
  const resolvedTilt = hasPrimaryTilt ? primaryTilt : fallbackTilt;
  const resolvedRotation = hasPrimaryRotation ? primaryRotation : fallbackRotation;
  return {
    tiltX: resolvedTilt.tiltX,
    tiltY: resolvedTilt.tiltY,
    rotation: resolvedRotation,
  };
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
  fallbackEvent?: PointerEvent
): { pressure: number; tiltX: number; tiltY: number; rotation: number } {
  const pointerOrientation = resolvePointerOrientation(evt, fallbackEvent);

  if (!isWinTabActive) {
    return {
      pressure: evt.pressure,
      tiltX: pointerOrientation.tiltX,
      tiltY: pointerOrientation.tiltY,
      rotation: pointerOrientation.rotation,
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
      rotation: pointerOrientation.rotation,
    };
  }

  // 2. Fallback: Use currentPoint (last known input) if available
  if (currentPoint) {
    return {
      pressure: currentPoint.pressure,
      tiltX: normalizeTiltComponent(currentPoint.tilt_x),
      tiltY: normalizeTiltComponent(currentPoint.tilt_y),
      rotation: pointerOrientation.rotation,
    };
  }

  // 3. Ultimate Fallback: Use PointerEvent data
  return {
    // Mouse/touch often report pressure=0; use 0.5 as a reasonable default.
    // In WinTab mode, treat pen pressure as unknown (0) when we can't match tablet samples.
    pressure: getWinTabPressureFallback(evt),
    tiltX: pointerOrientation.tiltX,
    tiltY: pointerOrientation.tiltY,
    rotation: pointerOrientation.rotation,
  };
}
