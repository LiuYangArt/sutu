import { RawInputPoint } from '@/stores/tablet';

type StrictInputSource = 'wintab' | 'macnative' | 'pointerevent';

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

function resolvePointerPressure(evt: PointerEvent): number {
  return clampUnit(evt.pressure);
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

function resolvePointerOrientation(evt: PointerEvent): {
  tiltX: number;
  tiltY: number;
  rotation: number;
} {
  const primaryTilt = getNormalizedTiltFromPointerEvent(evt);
  const primaryRotation = getRotationFromPointerEvent(evt);
  return { tiltX: primaryTilt.tiltX, tiltY: primaryTilt.tiltY, rotation: primaryRotation };
}

function resolveSource(
  isNativeBackendActive: boolean,
  preferredNativePoint?: RawInputPoint | null
): StrictInputSource {
  if (!isNativeBackendActive) return 'pointerevent';
  const source = (preferredNativePoint as { source?: string } | undefined)?.source;
  if (source === 'wintab' || source === 'macnative' || source === 'pointerevent') {
    return source;
  }
  return 'pointerevent';
}

/**
 * Strict input resolution path without synthetic fallback pressure.
 */
export function getEffectiveInputData(
  evt: PointerEvent,
  isNativeBackendActive: boolean,
  bufferedPoints: RawInputPoint[],
  currentPoint: RawInputPoint | null,
  _fallbackEvent?: PointerEvent,
  preferredNativePoint?: RawInputPoint | null
): {
  pressure: number;
  tiltX: number;
  tiltY: number;
  rotation: number;
  timestampMs: number;
  source: StrictInputSource;
  hostTimeUs: number;
  deviceTimeUs: number;
} {
  const pointerOrientation = resolvePointerOrientation(evt);
  const pointerPressure = resolvePointerPressure(evt);
  const pointerTimestampMs = resolvePointerTimestampMs(evt);
  const pointerHostTimeUs = Math.max(0, Math.round(pointerTimestampMs * 1000));

  if (!isNativeBackendActive) {
    return {
      pressure: pointerPressure,
      tiltX: pointerOrientation.tiltX,
      tiltY: pointerOrientation.tiltY,
      rotation: pointerOrientation.rotation,
      timestampMs: pointerTimestampMs,
      source: 'pointerevent',
      hostTimeUs: pointerHostTimeUs,
      deviceTimeUs: 0,
    };
  }

  if (preferredNativePoint) {
    const pointWithTimes = preferredNativePoint as RawInputPoint & {
      host_time_us?: number;
      device_time_us?: number;
    };
    const hostTimeUs = Number.isFinite(pointWithTimes.host_time_us)
      ? Math.max(0, Math.round(pointWithTimes.host_time_us!))
      : pointerHostTimeUs;
    const deviceTimeUs = Number.isFinite(pointWithTimes.device_time_us)
      ? Math.max(0, Math.round(pointWithTimes.device_time_us!))
      : hostTimeUs;

    return {
      pressure: clampUnit(preferredNativePoint.pressure),
      tiltX: normalizeTiltComponent(preferredNativePoint.tilt_x),
      tiltY: normalizeTiltComponent(preferredNativePoint.tilt_y),
      rotation: resolveTabletRotation(preferredNativePoint, pointerOrientation.rotation),
      timestampMs: resolveNativeTimestampMs(preferredNativePoint, pointerTimestampMs),
      source: resolveSource(true, preferredNativePoint),
      hostTimeUs,
      deviceTimeUs,
    };
  }

  if (bufferedPoints.length > 0) {
    const pt = bufferedPoints[bufferedPoints.length - 1]! as RawInputPoint & {
      host_time_us?: number;
      device_time_us?: number;
    };
    const hostTimeUs = Number.isFinite(pt.host_time_us)
      ? Math.max(0, Math.round(pt.host_time_us!))
      : pointerHostTimeUs;
    const deviceTimeUs = Number.isFinite(pt.device_time_us)
      ? Math.max(0, Math.round(pt.device_time_us!))
      : hostTimeUs;

    return {
      pressure: clampUnit(pt.pressure),
      tiltX: normalizeTiltComponent(pt.tilt_x),
      tiltY: normalizeTiltComponent(pt.tilt_y),
      rotation: resolveTabletRotation(pt, pointerOrientation.rotation),
      timestampMs: resolveNativeTimestampMs(pt, pointerTimestampMs),
      source: resolveSource(true, pt),
      hostTimeUs,
      deviceTimeUs,
    };
  }

  if (currentPoint) {
    const pointWithTimes = currentPoint as RawInputPoint & {
      host_time_us?: number;
      device_time_us?: number;
    };
    const hostTimeUs = Number.isFinite(pointWithTimes.host_time_us)
      ? Math.max(0, Math.round(pointWithTimes.host_time_us!))
      : pointerHostTimeUs;
    const deviceTimeUs = Number.isFinite(pointWithTimes.device_time_us)
      ? Math.max(0, Math.round(pointWithTimes.device_time_us!))
      : hostTimeUs;

    return {
      pressure: clampUnit(currentPoint.pressure),
      tiltX: normalizeTiltComponent(currentPoint.tilt_x),
      tiltY: normalizeTiltComponent(currentPoint.tilt_y),
      rotation: resolveTabletRotation(currentPoint, pointerOrientation.rotation),
      timestampMs: resolveNativeTimestampMs(currentPoint, pointerTimestampMs),
      source: resolveSource(true, currentPoint),
      hostTimeUs,
      deviceTimeUs,
    };
  }

  return {
    pressure: pointerPressure,
    tiltX: pointerOrientation.tiltX,
    tiltY: pointerOrientation.tiltY,
    rotation: pointerOrientation.rotation,
    timestampMs: pointerTimestampMs,
    source: 'pointerevent',
    hostTimeUs: pointerHostTimeUs,
    deviceTimeUs: 0,
  };
}
