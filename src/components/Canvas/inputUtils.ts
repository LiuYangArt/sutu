import type { TabletInputPoint } from '@/stores/tablet';

type StrictInputSource = 'wintab' | 'macnative' | 'pointerevent';

export interface PointerInputSample {
  pressure: number;
  tiltX: number;
  tiltY: number;
  rotation: number;
  timestampMs: number;
  source: 'pointerevent';
  hostTimeUs: number;
  deviceTimeUs: number;
  phase: 'hover' | 'down' | 'move' | 'up';
}

export interface NativeInputSample {
  xPx: number;
  yPx: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  rotation: number;
  timestampMs: number;
  source: StrictInputSource;
  hostTimeUs: number;
  deviceTimeUs: number;
  phase: 'hover' | 'down' | 'move' | 'up';
}

export interface TabletStreamingBackendStateLike {
  backend: string | null | undefined;
  activeBackend: string | null | undefined;
  isStreaming: boolean;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
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

function resolvePointerTimestampMs(evt: PointerEvent): number {
  if (Number.isFinite(evt.timeStamp) && evt.timeStamp >= 0) {
    return evt.timeStamp;
  }
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function resolveNativeSource(source: string): StrictInputSource {
  if (source === 'wintab' || source === 'win_tab') return 'wintab';
  if (source === 'macnative' || source === 'mac_native') return 'macnative';
  if (source === 'pointerevent' || source === 'pointer_event') return 'pointerevent';
  return 'pointerevent';
}

function resolveHostTimeUs(value: number, fallbackTimestampMs: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  return Math.max(0, Math.round(fallbackTimestampMs * 1000));
}

function resolveDeviceTimeUs(value: number | null | undefined, hostTimeUs: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  return hostTimeUs;
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

function toPointerPhase(evtType: string): PointerInputSample['phase'] {
  if (evtType === 'pointerdown') return 'down';
  if (evtType === 'pointerup' || evtType === 'pointercancel') return 'up';
  return 'move';
}

export function isNativeTabletStreamingBackend(activeBackend: string | null | undefined): boolean {
  if (typeof activeBackend !== 'string') return false;
  const normalized = activeBackend.toLowerCase();
  return normalized === 'wintab' || normalized === 'macnative';
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

export function parsePointerEventSample(evt: PointerEvent): PointerInputSample {
  const timestampMs = resolvePointerTimestampMs(evt);
  const { tiltX, tiltY } = getNormalizedTiltFromPointerEvent(evt);
  const phase = toPointerPhase(evt.type);
  return {
    pressure: phase === 'up' ? 0 : clampUnit(evt.pressure),
    tiltX,
    tiltY,
    rotation: getRotationFromPointerEvent(evt),
    timestampMs,
    source: 'pointerevent',
    hostTimeUs: Math.max(0, Math.round(timestampMs * 1000)),
    deviceTimeUs: 0,
    phase,
  };
}

export function parseNativeTabletSample(point: TabletInputPoint): NativeInputSample {
  const hostTimeUs = resolveHostTimeUs(point.host_time_us, point.timestamp_ms);
  const deviceTimeUs = resolveDeviceTimeUs(point.device_time_us, hostTimeUs);
  const phase =
    point.phase === 'hover' || point.phase === 'down' || point.phase === 'up'
      ? point.phase
      : 'move';
  return {
    xPx: Number.isFinite(point.x_px) ? point.x_px : 0,
    yPx: Number.isFinite(point.y_px) ? point.y_px : 0,
    pressure: phase === 'up' ? 0 : clampUnit(point.pressure_0_1),
    tiltX: normalizeTiltComponent(point.tilt_x_deg),
    tiltY: normalizeTiltComponent(point.tilt_y_deg),
    rotation: normalizeRotationDegrees(point.rotation_deg),
    timestampMs: hostTimeUs / 1000,
    source: resolveNativeSource(point.source),
    hostTimeUs,
    deviceTimeUs,
    phase,
  };
}

export function mapNativeWindowPxToCanvasPoint(
  canvas: HTMLCanvasElement,
  rect: { left: number; top: number; width: number; height: number },
  xPx: number,
  yPx: number
): { x: number; y: number } {
  const rectWidth =
    Number.isFinite(rect.width) && rect.width > 0 ? rect.width : Math.max(1, canvas.width);
  const rectHeight =
    Number.isFinite(rect.height) && rect.height > 0 ? rect.height : Math.max(1, canvas.height);
  const scaleX = canvas.width / rectWidth;
  const scaleY = canvas.height / rectHeight;
  return {
    x: (xPx - rect.left) * scaleX,
    y: (yPx - rect.top) * scaleY,
  };
}

export function resolveNativeStrokePoints(
  bufferedPoints: TabletInputPoint[],
  currentPoint: TabletInputPoint | null
): TabletInputPoint[] {
  const sourcePoints =
    bufferedPoints.length > 0 ? bufferedPoints : currentPoint ? [currentPoint] : [];
  if (sourcePoints.length === 0) return [];

  const nonHoverPoints = sourcePoints.filter((point) => point.phase !== 'hover');
  if (nonHoverPoints.length === 0) return [];

  let latestStrokeId = -Infinity;
  for (const point of nonHoverPoints) {
    const strokeId = Number.isFinite(point.stroke_id) ? point.stroke_id : -Infinity;
    if (strokeId > latestStrokeId) {
      latestStrokeId = strokeId;
    }
  }
  const latestStrokePoints = nonHoverPoints.filter((point) => point.stroke_id === latestStrokeId);
  if (latestStrokePoints.length === 0) return [];

  // PointerDown seed must start from the current stroke's explicit Down point.
  // If Down has not arrived yet, return empty and wait for follow-up native samples.
  const firstDownIndex = latestStrokePoints.findIndex((point) => point.phase === 'down');
  if (firstDownIndex < 0) {
    return [];
  }

  const currentStrokeSeed = latestStrokePoints
    .slice(firstDownIndex)
    .filter((point) => point.phase === 'down' || point.phase === 'move');
  return currentStrokeSeed;
}
