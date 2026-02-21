import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { detectPlatformKind } from '@/utils/platform';
import { logTabletTrace } from '@/utils/tabletTrace';

function resolveDefaultRequestedBackend(): BackendType {
  const platformKind = detectPlatformKind();
  if (platformKind === 'windows') return 'wintab';
  if (platformKind === 'macos') return 'macnative';
  return 'pointerevent';
}

const DEFAULT_REQUESTED_BACKEND: BackendType = resolveDefaultRequestedBackend();

// Types matching Rust backend
export type TabletStatus = 'Disconnected' | 'Connected' | 'Error';
export type BackendType = 'wintab' | 'macnative' | 'pointerevent';
export type InputBackpressureMode = 'lossless' | 'latency_capped';

export interface TabletInfo {
  name: string;
  backend: string;
  supports_pressure: boolean;
  supports_tilt: boolean;
  pressure_range: [number, number];
}

export interface InputQueueMetrics {
  enqueued: number;
  dequeued: number;
  dropped: number;
  max_depth: number;
  current_depth: number;
  latency_p50_us: number;
  latency_p95_us: number;
  latency_p99_us: number;
  latency_last_us: number;
}

export interface TabletV3Diagnostics {
  phase_transition_error_count: number;
  host_time_non_monotonic_count: number;
  stroke_tail_drop_count: number;
  native_down_without_seed_count: number;
  coord_out_of_view_count: number;
  seq_rewind_recovery_fail_count: number;
  pressure_clamp_count: number;
  pressure_total_count: number;
}

export interface TabletStatusResponse {
  status: TabletStatus;
  backend: string;
  requested_backend: string;
  active_backend: string;
  backpressure_mode: InputBackpressureMode;
  queue_metrics: InputQueueMetrics;
  v3_diagnostics: TabletV3Diagnostics;
  info: TabletInfo | null;
}

interface TabletStatusStatePatch {
  status: TabletStatus;
  backend: string;
  requestedBackend: string;
  activeBackend: string;
  backpressureMode: InputBackpressureMode;
  queueMetrics: InputQueueMetrics;
  v3Diagnostics: TabletV3Diagnostics;
  info: TabletInfo | null;
}

export type InputSource = 'wintab' | 'pointerevent' | 'macnative';
export type InputPhase = 'hover' | 'down' | 'move' | 'up';

export interface NativeTabletEventV3 {
  seq: number;
  stroke_id: number;
  pointer_id: number;
  device_id: string;
  source: InputSource;
  phase: InputPhase;
  x_px: number;
  y_px: number;
  pressure_0_1: number;
  tilt_x_deg: number;
  tilt_y_deg: number;
  rotation_deg: number;
  host_time_us: number;
  device_time_us?: number | null;
}

export interface RawInputPoint {
  x: number;
  y: number;
  pressure: number;
  tilt_x: number;
  tilt_y: number;
  rotation: number;
  timestamp_ms: number;
  host_time_us: number;
  device_time_us: number;
}

/**
 * Normalized sample used by frontend:
 * - keeps V3 canonical fields
 * - adds compat aliases (`x/y/pressure/tilt_x/tilt_y/rotation/timestamp_ms`)
 */
export interface TabletInputPoint
  extends Omit<NativeTabletEventV3, 'device_time_us'>, RawInputPoint {
  device_time_us: number;
}

export type TabletEventV3 =
  | { Input: NativeTabletEventV3 }
  | 'ProximityEnter'
  | 'ProximityLeave'
  | { StatusChanged: TabletStatus };

interface TabletEmitterBatchMetricsV1 {
  backend: string;
  emit_poll_time_us: number;
  emit_completed_time_us: number;
  emitted_event_count: number;
  input_event_count: number;
  first_source: string | null;
  last_source: string | null;
  min_seq: number | null;
  max_seq: number | null;
  first_stroke_id: number | null;
  last_stroke_id: number | null;
  first_pointer_id: number | null;
  last_pointer_id: number | null;
  min_host_time_us: number | null;
  max_host_time_us: number | null;
  oldest_input_latency_us: number | null;
  newest_input_latency_us: number | null;
}

const POINT_BUFFER_SIZE = 512;

// Shared sample buffer (kept outside Zustand to avoid high-frequency re-rendering).
let pointBuffer: TabletInputPoint[] = [];
let pointBufferEpoch = 0;
let nativeTraceStrokeActive = false;
const SEQ_REWIND_RESET_THRESHOLD = 32;
const SEQ_REWIND_LOW_SEQ_MAX = 8;

function bumpPointBufferEpoch(): number {
  pointBufferEpoch += 1;
  if (!Number.isSafeInteger(pointBufferEpoch) || pointBufferEpoch < 0) {
    pointBufferEpoch = 1;
  }
  return pointBufferEpoch;
}

function sliceTailPoints<T>(points: T[], limit: number): T[] {
  return limit > 0 ? points.slice(-limit) : [];
}

function shouldResetBufferForSeqRewind(
  latest: TabletInputPoint,
  incoming: TabletInputPoint
): boolean {
  if (incoming.seq >= latest.seq) return false;
  const seqDelta = latest.seq - incoming.seq;
  if (seqDelta < SEQ_REWIND_RESET_THRESHOLD) return false;
  // Stream restart after backend switch/restart usually begins with down and low seq.
  return incoming.phase === 'down' || incoming.seq <= SEQ_REWIND_LOW_SEQ_MAX;
}

function addPointToBuffer(point: TabletInputPoint): {
  seqRewindReset: boolean;
  bufferEpoch: number;
} {
  let seqRewindReset = false;
  const latest = pointBuffer[pointBuffer.length - 1];
  if (latest && point.seq <= latest.seq) {
    if (!shouldResetBufferForSeqRewind(latest, point)) {
      return { seqRewindReset: false, bufferEpoch: pointBufferEpoch };
    }
    logTabletTrace('frontend.buffer.seq_rewind_reset', {
      latest_seq: latest.seq,
      latest_stroke_id: latest.stroke_id,
      latest_pointer_id: latest.pointer_id,
      latest_source: latest.source,
      incoming_seq: point.seq,
      incoming_stroke_id: point.stroke_id,
      incoming_pointer_id: point.pointer_id,
      incoming_source: point.source,
      incoming_phase: point.phase,
    });
    pointBuffer = [];
    bumpPointBufferEpoch();
    seqRewindReset = true;
  }

  pointBuffer.push(point);
  if (pointBuffer.length > POINT_BUFFER_SIZE) {
    pointBuffer = pointBuffer.slice(pointBuffer.length - POINT_BUFFER_SIZE);
  }
  return { seqRewindReset, bufferEpoch: pointBufferEpoch };
}

/**
 * Cursor-based non-destructive read.
 * Multiple consumers can read without stealing each other's samples.
 */
export function readPointBufferSince(
  lastSeq: number,
  limit: number = POINT_BUFFER_SIZE
): { points: TabletInputPoint[]; nextSeq: number; bufferEpoch: number } {
  if (pointBuffer.length === 0) {
    return { points: [], nextSeq: lastSeq, bufferEpoch: pointBufferEpoch };
  }

  const latest = pointBuffer[pointBuffer.length - 1];
  if (latest && latest.seq < lastSeq) {
    const sliced = sliceTailPoints(pointBuffer, limit);
    const tail = sliced[sliced.length - 1];
    logTabletTrace('frontend.buffer.cursor_rewind_rebase', {
      read_cursor_seq: lastSeq,
      latest_buffer_seq: latest.seq,
      returned_points: sliced.length,
      buffer_size: pointBuffer.length,
    });
    return {
      points: sliced,
      nextSeq: tail ? tail.seq : latest.seq,
      bufferEpoch: pointBufferEpoch,
    };
  }

  const startIndex = pointBuffer.findIndex((point) => point.seq > lastSeq);
  if (startIndex < 0) {
    return { points: [], nextSeq: lastSeq, bufferEpoch: pointBufferEpoch };
  }

  const points = pointBuffer.slice(startIndex);
  const sliced = sliceTailPoints(points, limit);
  const tail = sliced[sliced.length - 1];
  return {
    points: sliced,
    nextSeq: tail ? tail.seq : lastSeq,
    bufferEpoch: pointBufferEpoch,
  };
}

export function getLatestPoint(): TabletInputPoint | null {
  return pointBuffer.length > 0 ? (pointBuffer[pointBuffer.length - 1] ?? null) : null;
}

export function clearPointBuffer(): void {
  pointBuffer = [];
  bumpPointBufferEpoch();
}

export function getPointBufferEpoch(): number {
  return pointBufferEpoch;
}

function toTabletStatusStatePatch(response: TabletStatusResponse): TabletStatusStatePatch {
  return {
    status: response.status,
    backend: response.backend,
    requestedBackend: response.requested_backend,
    activeBackend: response.active_backend,
    backpressureMode: response.backpressure_mode,
    queueMetrics: response.queue_metrics,
    v3Diagnostics: response.v3_diagnostics,
    info: response.info,
  };
}

interface TabletState {
  status: TabletStatus;
  backend: string;
  requestedBackend: string;
  activeBackend: string;
  backpressureMode: InputBackpressureMode;
  queueMetrics: InputQueueMetrics;
  v3Diagnostics: TabletV3Diagnostics;
  bufferEpoch: number;
  info: TabletInfo | null;
  isInitialized: boolean;
  isStreaming: boolean;

  currentPoint: TabletInputPoint | null;
  inProximity: boolean;
  unlisten: UnlistenFn | null;

  init: (options?: {
    backend?: BackendType;
    pollingRate?: number;
    pressureCurve?: string;
    backpressureMode?: InputBackpressureMode;
  }) => Promise<void>;
  switchBackend: (
    backend: BackendType,
    options?: {
      pollingRate?: number;
      pressureCurve?: string;
      backpressureMode?: InputBackpressureMode;
    }
  ) => Promise<boolean>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  refresh: () => Promise<void>;
  cleanup: () => void;

  _setPoint: (point: TabletInputPoint) => void;
  _setProximity: (inProximity: boolean) => void;
}

const EMPTY_QUEUE_METRICS: InputQueueMetrics = {
  enqueued: 0,
  dequeued: 0,
  dropped: 0,
  max_depth: 0,
  current_depth: 0,
  latency_p50_us: 0,
  latency_p95_us: 0,
  latency_p99_us: 0,
  latency_last_us: 0,
};

const EMPTY_V3_DIAGNOSTICS: TabletV3Diagnostics = {
  phase_transition_error_count: 0,
  host_time_non_monotonic_count: 0,
  stroke_tail_drop_count: 0,
  native_down_without_seed_count: 0,
  coord_out_of_view_count: 0,
  seq_rewind_recovery_fail_count: 0,
  pressure_clamp_count: 0,
  pressure_total_count: 0,
};

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampSignedTiltDeg(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-90, Math.min(90, value));
}

function normalizeRotationDeg(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
}

function normalizeInputSource(value: string): InputSource {
  if (value === 'wintab' || value === 'win_tab') return 'wintab';
  if (value === 'macnative' || value === 'mac_native') return 'macnative';
  if (value === 'pointerevent' || value === 'pointer_event') return 'pointerevent';
  return 'pointerevent';
}

function normalizeDeviceTimeUs(value: number | null | undefined, hostTimeUs: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return hostTimeUs;
  return Math.max(0, Math.round(value));
}

function normalizeTabletInputPoint(payload: NativeTabletEventV3): TabletInputPoint {
  const hostTimeUs = Math.max(0, Math.round(payload.host_time_us));
  const deviceTimeUs = normalizeDeviceTimeUs(payload.device_time_us, hostTimeUs);
  const pressure = clampUnit(payload.pressure_0_1);
  const tiltXDeg = clampSignedTiltDeg(payload.tilt_x_deg);
  const tiltYDeg = clampSignedTiltDeg(payload.tilt_y_deg);
  const rotationDeg = normalizeRotationDeg(payload.rotation_deg);
  const source = normalizeInputSource(payload.source as unknown as string);
  const xPx = Number.isFinite(payload.x_px) ? payload.x_px : 0;
  const yPx = Number.isFinite(payload.y_px) ? payload.y_px : 0;
  return {
    ...payload,
    source,
    host_time_us: hostTimeUs,
    device_time_us: deviceTimeUs,
    x_px: xPx,
    y_px: yPx,
    pressure_0_1: pressure,
    tilt_x_deg: tiltXDeg,
    tilt_y_deg: tiltYDeg,
    rotation_deg: rotationDeg,
    x: xPx,
    y: yPx,
    pressure,
    tilt_x: tiltXDeg,
    tilt_y: tiltYDeg,
    rotation: rotationDeg,
    timestamp_ms: hostTimeUs / 1000,
  };
}

export const useTabletStore = create<TabletState>((set, get) => ({
  status: 'Disconnected',
  backend: 'none',
  requestedBackend: DEFAULT_REQUESTED_BACKEND,
  activeBackend: 'none',
  backpressureMode: 'lossless',
  queueMetrics: { ...EMPTY_QUEUE_METRICS },
  v3Diagnostics: { ...EMPTY_V3_DIAGNOSTICS },
  bufferEpoch: getPointBufferEpoch(),
  info: null,
  isInitialized: false,
  isStreaming: false,
  currentPoint: null,
  inProximity: false,
  unlisten: null,

  init: async (options = {}) => {
    try {
      const response = await invoke<TabletStatusResponse>('init_tablet', {
        backend: options.backend,
        pollingRate: options.pollingRate,
        pressureCurve: options.pressureCurve,
        backpressureMode: options.backpressureMode,
      });

      set({
        ...toTabletStatusStatePatch(response),
        isInitialized: true,
        bufferEpoch: getPointBufferEpoch(),
      });
    } catch (error) {
      console.error('[Tablet] Init failed:', error);
      set({
        status: 'Error',
        isInitialized: false,
      });
    }
  },

  switchBackend: async (backend, options = {}) => {
    const before = get();
    logTabletTrace('frontend.backend.switch.request', {
      requested_backend: backend,
      before_backend: before.backend,
      before_requested_backend: before.requestedBackend,
      before_active_backend: before.activeBackend,
      before_status: before.status,
      before_streaming: before.isStreaming,
      before_in_proximity: before.inProximity,
      has_current_point: !!before.currentPoint,
      current_point_phase: before.currentPoint?.phase ?? null,
      current_point_pointer_id: before.currentPoint?.pointer_id ?? null,
    });
    try {
      const response = await invoke<TabletStatusResponse>('switch_tablet_backend', {
        backend,
        pollingRate: options.pollingRate,
        pressureCurve: options.pressureCurve,
        backpressureMode: options.backpressureMode,
      });

      set({
        ...toTabletStatusStatePatch(response),
        isInitialized: true,
        currentPoint: null,
        inProximity: false,
        bufferEpoch: getPointBufferEpoch(),
      });
      clearPointBuffer();
      nativeTraceStrokeActive = false;
      set({ bufferEpoch: getPointBufferEpoch() });
      logTabletTrace('frontend.backend.switch.success', {
        requested_backend: backend,
        response_backend: response.backend,
        response_requested_backend: response.requested_backend,
        response_active_backend: response.active_backend,
        response_status: response.status,
        point_buffer_cleared: true,
      });
      return true;
    } catch (error) {
      console.error('[Tablet] Switch backend failed:', error);
      logTabletTrace('frontend.backend.switch.failed', {
        requested_backend: backend,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  },

  start: async () => {
    const state = get();
    if (!state.isInitialized) {
      console.warn('[Tablet] Not initialized, call init() first');
      return;
    }
    if (state.isStreaming) {
      return;
    }

    try {
      const unlistenV3 = await listen<TabletEventV3>('tablet-event-v3', (event) => {
        const payload = event.payload;

        if (typeof payload === 'object' && payload !== null && 'Input' in payload) {
          const point = normalizeTabletInputPoint(payload.Input);
          if (point.phase === 'down') {
            nativeTraceStrokeActive = true;
            logTabletTrace('frontend.recv.native_v3', {
              seq: point.seq,
              stroke_id: point.stroke_id,
              pointer_id: point.pointer_id,
              phase: point.phase,
              source: point.source,
              x_px: point.x_px,
              y_px: point.y_px,
              pressure_0_1: point.pressure_0_1,
              host_time_us: point.host_time_us,
              device_time_us: point.device_time_us,
            });
          } else if (point.phase === 'move' && nativeTraceStrokeActive && point.seq % 8 === 0) {
            logTabletTrace('frontend.recv.native_v3', {
              seq: point.seq,
              stroke_id: point.stroke_id,
              pointer_id: point.pointer_id,
              phase: point.phase,
              source: point.source,
              x_px: point.x_px,
              y_px: point.y_px,
              pressure_0_1: point.pressure_0_1,
              host_time_us: point.host_time_us,
              device_time_us: point.device_time_us,
            });
          } else if (point.phase === 'up') {
            if (nativeTraceStrokeActive) {
              logTabletTrace('frontend.recv.native_v3', {
                seq: point.seq,
                stroke_id: point.stroke_id,
                pointer_id: point.pointer_id,
                phase: point.phase,
                source: point.source,
                x_px: point.x_px,
                y_px: point.y_px,
                pressure_0_1: point.pressure_0_1,
                host_time_us: point.host_time_us,
                device_time_us: point.device_time_us,
              });
            }
            nativeTraceStrokeActive = false;
          }
          const addResult = addPointToBuffer(point);
          if (addResult.seqRewindReset) {
            set({ bufferEpoch: addResult.bufferEpoch });
          }
          get()._setPoint(point);
        } else if (payload === 'ProximityEnter') {
          logTabletTrace('frontend.recv.proximity_enter', {});
          get()._setProximity(true);
        } else if (payload === 'ProximityLeave') {
          logTabletTrace('frontend.recv.proximity_leave', {});
          nativeTraceStrokeActive = false;
          get()._setProximity(false);
          clearPointBuffer();
          set({ currentPoint: null, bufferEpoch: getPointBufferEpoch() });
        } else if (typeof payload === 'object' && payload !== null && 'StatusChanged' in payload) {
          logTabletTrace('frontend.recv.status_changed', {
            status: payload.StatusChanged,
          });
          set({ status: payload.StatusChanged });
        }
      });

      const unlistenEmitterMetrics = await listen<TabletEmitterBatchMetricsV1>(
        'tablet-emitter-metrics-v1',
        (event) => {
          const payload = event.payload;
          if (!payload || typeof payload !== 'object') {
            return;
          }
          logTabletTrace('frontend.recv.emitter_batch_v1', {
            backend: payload.backend,
            emit_poll_time_us: payload.emit_poll_time_us,
            emit_completed_time_us: payload.emit_completed_time_us,
            emitted_event_count: payload.emitted_event_count,
            input_event_count: payload.input_event_count,
            first_source: payload.first_source,
            last_source: payload.last_source,
            min_seq: payload.min_seq,
            max_seq: payload.max_seq,
            first_stroke_id: payload.first_stroke_id,
            last_stroke_id: payload.last_stroke_id,
            first_pointer_id: payload.first_pointer_id,
            last_pointer_id: payload.last_pointer_id,
            min_host_time_us: payload.min_host_time_us,
            max_host_time_us: payload.max_host_time_us,
            oldest_input_latency_us: payload.oldest_input_latency_us,
            newest_input_latency_us: payload.newest_input_latency_us,
          });
        }
      );

      const unlisten: UnlistenFn = () => {
        unlistenV3();
        unlistenEmitterMetrics();
      };

      set({ unlisten });
      await invoke('start_tablet');
      await get().refresh();
      set({ isStreaming: true });
    } catch (error) {
      console.error('[Tablet] Start failed:', error);
    }
  },

  stop: async () => {
    const state = get();
    if (!state.isStreaming) {
      return;
    }

    try {
      await invoke('stop_tablet');

      if (state.unlisten) {
        state.unlisten();
      }

      clearPointBuffer();
      nativeTraceStrokeActive = false;
      set({
        isStreaming: false,
        unlisten: null,
        currentPoint: null,
        bufferEpoch: getPointBufferEpoch(),
      });
    } catch (error) {
      console.error('[Tablet] Stop failed:', error);
    }
  },

  refresh: async () => {
    try {
      const response = await invoke<TabletStatusResponse>('get_tablet_status');
      set(toTabletStatusStatePatch(response));
    } catch (error) {
      console.error('[Tablet] Refresh failed:', error);
    }
  },

  cleanup: () => {
    const state = get();
    if (state.unlisten) {
      state.unlisten();
    }
    clearPointBuffer();
    nativeTraceStrokeActive = false;
    set({
      unlisten: null,
      isStreaming: false,
      currentPoint: null,
      bufferEpoch: getPointBufferEpoch(),
    });
  },

  _setPoint: (point) => set({ currentPoint: point }),
  _setProximity: (inProximity) => set({ inProximity }),
}));

export async function pushPointerEvent(
  x: number,
  y: number,
  pressure: number,
  tiltX: number,
  tiltY: number,
  options?: {
    rotation?: number;
    pointerId?: number;
    phase?: InputPhase;
    deviceTimeUs?: number;
  }
): Promise<void> {
  try {
    logTabletTrace('frontend.push.pointerevent', {
      x,
      y,
      pressure,
      tilt_x: tiltX,
      tilt_y: tiltY,
      rotation: options?.rotation ?? 0,
      pointer_id: options?.pointerId ?? 0,
      phase: options?.phase ?? 'move',
      device_time_us: options?.deviceTimeUs ?? null,
    });
    await invoke('push_pointer_event', {
      payload: {
        x,
        y,
        pressure,
        tiltX,
        tiltY,
        rotation: options?.rotation,
        pointerId: options?.pointerId,
        phase: options?.phase,
        deviceTimeUs: options?.deviceTimeUs,
      },
    });
  } catch (error) {
    console.error('[Tablet] Push pointer event failed:', error);
  }
}
