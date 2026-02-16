import { RawInputPoint } from '@/stores/tablet';

type WebKitPointerEvent = PointerEvent & {
  webkitForce?: number;
  WEBKIT_FORCE_AT_MOUSE_DOWN?: number;
  WEBKIT_FORCE_AT_FORCE_MOUSE_DOWN?: number;
};

function getNativeBackendPressureFallback(evt: PointerEvent): number {
  if (evt.pointerType === 'pen') return 0;
  if (evt.pressure > 0) return evt.pressure;
  return 0.5;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function resolvePointerTimestampMs(evt: PointerEvent): number {
  if (Number.isFinite(evt.timeStamp) && evt.timeStamp >= 0) {
    return evt.timeStamp;
  }
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function resolveNativeTimestampMs(
  point: RawInputPoint | null | undefined,
  fallbackTimestampMs: number
): number {
  if (point && Number.isFinite(point.timestamp_ms) && point.timestamp_ms >= 0) {
    return point.timestamp_ms;
  }
  return fallbackTimestampMs;
}

function getWebKitPressure(evt: PointerEvent): number | null {
  const webkitEvt = evt as WebKitPointerEvent;
  const force = webkitEvt.webkitForce;
  if (!Number.isFinite(force) || force! <= 0) return null;

  const base = webkitEvt.WEBKIT_FORCE_AT_MOUSE_DOWN;
  const max = webkitEvt.WEBKIT_FORCE_AT_FORCE_MOUSE_DOWN;
  if (Number.isFinite(base) && Number.isFinite(max) && max! > base!) {
    return clampUnit((force! - base!) / (max! - base!));
  }

  // Fallback range normalization for WebKit variants.
  return clampUnit(force! <= 1 ? force! : force! / 3);
}

function resolvePointerPressure(evt: PointerEvent, fallbackEvent?: PointerEvent): number {
  const raw = evt.pressure;
  const hasFinitePressure = Number.isFinite(raw);
  const pressure = hasFinitePressure ? clampUnit(raw) : 0;
  const likelySyntheticMousePressure =
    evt.pointerType !== 'pen' && Math.abs(pressure - 0.5) <= 1e-6;
  const needsFallback = !hasFinitePressure || pressure <= 0 || likelySyntheticMousePressure;

  if (!needsFallback) {
    return pressure;
  }

  const webkitPressure = getWebKitPressure(evt);
  if (webkitPressure !== null) {
    return webkitPressure;
  }

  if (fallbackEvent && fallbackEvent !== evt) {
    const fallbackWebKitPressure = getWebKitPressure(fallbackEvent);
    if (fallbackWebKitPressure !== null) {
      return fallbackWebKitPressure;
    }
    const fallbackPressure = fallbackEvent.pressure;
    if (Number.isFinite(fallbackPressure) && fallbackPressure > 0) {
      return clampUnit(fallbackPressure);
    }
  }

  return pressure;
}

export function isNativeTabletStreamingBackend(activeBackend: string | null | undefined): boolean {
  if (typeof activeBackend !== 'string') return false;
  const normalized = activeBackend.toLowerCase();
  return normalized === 'wintab' || normalized === 'macnative';
}

export interface TabletStreamingBackendStateLike {
  backend: string | null | undefined;
  activeBackend: string | null | undefined;
  isStreaming: boolean;
}

export function resolveStreamingBackendName(
  activeBackend: string | null | undefined,
  backend: string | null | undefined
): string | null {
  if (typeof activeBackend === 'string' && activeBackend.length > 0) {
    return activeBackend;
  }
  if (typeof backend === 'string' && backend.length > 0) {
    return backend;
  }
  return null;
}

export function isNativeTabletStreamingState(state: TabletStreamingBackendStateLike): boolean {
  if (!state.isStreaming) return false;
  const backendName = resolveStreamingBackendName(state.activeBackend, state.backend);
  return isNativeTabletStreamingBackend(backendName);
}

function clampSignedUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function normalizeTiltComponent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clampSignedUnit(value / 90);
}

function normalizeRotationDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
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
  return normalizeRotationDegrees(twist!);
}

function resolveTabletRotation(
  point: RawInputPoint | null | undefined,
  fallbackRotation: number
): number {
  if (!point || !Number.isFinite(point.rotation)) return fallbackRotation;
  return normalizeRotationDegrees(point.rotation!);
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
 * Resolves pressure and tilt data, preferring native tablet backend buffer when active.
 * Respects pressure=0 from backend smoothing.
 */
export function getEffectiveInputData(
  evt: PointerEvent,
  isNativeBackendActive: boolean,
  bufferedPoints: RawInputPoint[],
  currentPoint: RawInputPoint | null,
  fallbackEvent?: PointerEvent
): { pressure: number; tiltX: number; tiltY: number; rotation: number; timestampMs: number } {
  const pointerOrientation = resolvePointerOrientation(evt, fallbackEvent);
  const pointerPressure = resolvePointerPressure(evt, fallbackEvent);
  const pointerTimestampMs = resolvePointerTimestampMs(evt);

  if (!isNativeBackendActive) {
    return {
      pressure: pointerPressure,
      tiltX: pointerOrientation.tiltX,
      tiltY: pointerOrientation.tiltY,
      rotation: pointerOrientation.rotation,
      timestampMs: pointerTimestampMs,
    };
  }

  // Note: Native backend timestamps are not guaranteed to share a time origin with
  // PointerEvent.timeStamp, so we avoid time-based matching here.
  // Use the most recent native sample we have for this event batch.
  if (bufferedPoints.length > 0) {
    const pt = bufferedPoints[bufferedPoints.length - 1]!;
    return {
      pressure: pt.pressure,
      tiltX: normalizeTiltComponent(pt.tilt_x),
      tiltY: normalizeTiltComponent(pt.tilt_y),
      rotation: resolveTabletRotation(pt, pointerOrientation.rotation),
      timestampMs: resolveNativeTimestampMs(pt, pointerTimestampMs),
    };
  }

  // 2. Fallback: Use currentPoint (last known input) if available
  if (currentPoint) {
    return {
      pressure: currentPoint.pressure,
      tiltX: normalizeTiltComponent(currentPoint.tilt_x),
      tiltY: normalizeTiltComponent(currentPoint.tilt_y),
      rotation: resolveTabletRotation(currentPoint, pointerOrientation.rotation),
      timestampMs: resolveNativeTimestampMs(currentPoint, pointerTimestampMs),
    };
  }

  // 3. Ultimate Fallback: Use PointerEvent data
  return {
    // Mouse/touch often report pressure=0; use 0.5 as a reasonable default.
    // In native streaming mode, treat pen pressure as unknown (0) when we can't match tablet samples.
    pressure: getNativeBackendPressureFallback(evt),
    tiltX: pointerOrientation.tiltX,
    tiltY: pointerOrientation.tiltY,
    rotation: pointerOrientation.rotation,
    timestampMs: pointerTimestampMs,
  };
}
