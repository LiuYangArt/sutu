import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

// Types matching Rust backend
export type TabletStatus = 'Disconnected' | 'Connected' | 'Error';
export type BackendType = 'wintab' | 'pointerevent' | 'auto';
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

export interface TabletStatusResponse {
  status: TabletStatus;
  backend: string;
  requested_backend: string;
  active_backend: string;
  fallback_reason: string | null;
  backpressure_mode: InputBackpressureMode;
  queue_metrics: InputQueueMetrics;
  info: TabletInfo | null;
}

interface TabletStatusStatePatch {
  status: TabletStatus;
  backend: string;
  requestedBackend: string;
  activeBackend: string;
  fallbackReason: string | null;
  backpressureMode: InputBackpressureMode;
  queueMetrics: InputQueueMetrics;
  info: TabletInfo | null;
}

export type InputSource = 'wintab' | 'pointerevent' | 'win_tab' | 'pointer_event';
export type InputPhase = 'unknown' | 'hover' | 'down' | 'move' | 'up';

export interface RawInputPoint {
  x: number;
  y: number;
  pressure: number;
  tilt_x: number;
  tilt_y: number;
  timestamp_ms: number;
  tiltX?: number;
  tiltY?: number;
}

// Strict V2 tablet sample shape from Rust event payload.
export interface TabletInputPoint extends RawInputPoint {
  seq: number;
  stream_id: number;
  source: InputSource;
  pointer_id: number;
  phase: InputPhase;
  rotation: number;
  host_time_us: number;
  device_time_us: number;
}

export type TabletEventV2 =
  | { Input: TabletInputPoint }
  | 'ProximityEnter'
  | 'ProximityLeave'
  | { StatusChanged: TabletStatus };

const POINT_BUFFER_SIZE = 512;

// Shared sample buffer (kept outside Zustand to avoid high-frequency re-rendering).
let pointBuffer: TabletInputPoint[] = [];

function addPointToBuffer(point: TabletInputPoint): void {
  const latest = pointBuffer[pointBuffer.length - 1];
  if (latest && point.seq <= latest.seq) return;

  pointBuffer.push(point);
  if (pointBuffer.length > POINT_BUFFER_SIZE) {
    pointBuffer = pointBuffer.slice(pointBuffer.length - POINT_BUFFER_SIZE);
  }
}

/**
 * Cursor-based non-destructive read.
 * Multiple consumers can read without stealing each other's samples.
 */
export function readPointBufferSince(
  lastSeq: number,
  limit: number = POINT_BUFFER_SIZE
): { points: TabletInputPoint[]; nextSeq: number } {
  if (pointBuffer.length === 0) {
    return { points: [], nextSeq: lastSeq };
  }

  const startIndex = pointBuffer.findIndex((point) => point.seq > lastSeq);
  if (startIndex < 0) {
    return { points: [], nextSeq: lastSeq };
  }

  const points = pointBuffer.slice(startIndex);
  const sliced = points.length > limit ? points.slice(points.length - limit) : points;
  const tail = sliced[sliced.length - 1];
  return {
    points: sliced,
    nextSeq: tail ? tail.seq : lastSeq,
  };
}

export function getLatestPoint(): TabletInputPoint | null {
  return pointBuffer.length > 0 ? (pointBuffer[pointBuffer.length - 1] ?? null) : null;
}

export function clearPointBuffer(): void {
  pointBuffer = [];
}

function toTabletStatusStatePatch(response: TabletStatusResponse): TabletStatusStatePatch {
  return {
    status: response.status,
    backend: response.backend,
    requestedBackend: response.requested_backend,
    activeBackend: response.active_backend,
    fallbackReason: response.fallback_reason,
    backpressureMode: response.backpressure_mode,
    queueMetrics: response.queue_metrics,
    info: response.info,
  };
}

interface TabletState {
  status: TabletStatus;
  backend: string;
  requestedBackend: string;
  activeBackend: string;
  fallbackReason: string | null;
  backpressureMode: InputBackpressureMode;
  queueMetrics: InputQueueMetrics;
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

export const useTabletStore = create<TabletState>((set, get) => ({
  status: 'Disconnected',
  backend: 'none',
  requestedBackend: 'wintab',
  activeBackend: 'none',
  fallbackReason: null,
  backpressureMode: 'lossless',
  queueMetrics: { ...EMPTY_QUEUE_METRICS },
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
      });
      return true;
    } catch (error) {
      console.error('[Tablet] Switch backend failed:', error);
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
      const unlisten = await listen<TabletEventV2>('tablet-event-v2', (event) => {
        const payload = event.payload;

        if (typeof payload === 'object' && payload !== null && 'Input' in payload) {
          const point = payload.Input;
          addPointToBuffer(point);
          get()._setPoint(point);
        } else if (payload === 'ProximityEnter') {
          get()._setProximity(true);
        } else if (payload === 'ProximityLeave') {
          get()._setProximity(false);
          clearPointBuffer();
          set({ currentPoint: null });
        } else if (typeof payload === 'object' && payload !== null && 'StatusChanged' in payload) {
          set({ status: payload.StatusChanged });
        }
      });

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
      set({
        isStreaming: false,
        unlisten: null,
        currentPoint: null,
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
    set({
      unlisten: null,
      isStreaming: false,
      currentPoint: null,
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
    await invoke('push_pointer_event', {
      x,
      y,
      pressure,
      tiltX,
      tiltY,
      rotation: options?.rotation,
      pointerId: options?.pointerId,
      phase: options?.phase,
      deviceTimeUs: options?.deviceTimeUs,
    });
  } catch (error) {
    console.error('[Tablet] Push pointer event failed:', error);
  }
}
