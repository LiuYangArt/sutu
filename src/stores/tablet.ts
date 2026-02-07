import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

// Types matching Rust backend
export type TabletStatus = 'Disconnected' | 'Connected' | 'Error';
export type BackendType = 'wintab' | 'pointerevent' | 'auto';

export interface TabletInfo {
  name: string;
  backend: string;
  supports_pressure: boolean;
  supports_tilt: boolean;
  pressure_range: [number, number];
}

export interface TabletStatusResponse {
  status: TabletStatus;
  backend: string;
  info: TabletInfo | null;
}

export interface RawInputPoint {
  x: number;
  y: number;
  pressure: number;
  tilt_x: number;
  tilt_y: number;
  timestamp_ms: number;
}

export type TabletEvent =
  | { Input: RawInputPoint }
  | 'ProximityEnter'
  | 'ProximityLeave'
  | { StatusChanged: TabletStatus };

// Ring buffer size - stores recent WinTab points for matching
const POINT_BUFFER_SIZE = 128;

// Ring buffer for WinTab points - stored outside Zustand for performance
// This avoids triggering React re-renders on every WinTab event
let pointBuffer: RawInputPoint[] = [];
let bufferWriteIndex = 0;

/**
 * Add a point to the ring buffer (called from Tauri event listener)
 */
function addPointToBuffer(point: RawInputPoint): void {
  if (pointBuffer.length < POINT_BUFFER_SIZE) {
    pointBuffer.push(point);
  } else {
    pointBuffer[bufferWriteIndex] = point;
  }
  bufferWriteIndex = (bufferWriteIndex + 1) % POINT_BUFFER_SIZE;
}

/**
 * Get all buffered points and clear the buffer
 * This is the primary method for consuming WinTab data
 */
export function drainPointBuffer(): RawInputPoint[] {
  const points = pointBuffer;
  pointBuffer = [];
  bufferWriteIndex = 0;
  return points;
}

/**
 * Get the most recent point without clearing the buffer
 */
export function getLatestPoint(): RawInputPoint | null {
  if (pointBuffer.length === 0) return null;
  // The most recent point is at (bufferWriteIndex - 1)
  const index = (bufferWriteIndex - 1 + pointBuffer.length) % pointBuffer.length;
  return pointBuffer[index] ?? null;
}

/**
 * Clear the point buffer (call on stroke end)
 */
export function clearPointBuffer(): void {
  pointBuffer = [];
  bufferWriteIndex = 0;
}

interface TabletState {
  // Status
  status: TabletStatus;
  backend: string;
  info: TabletInfo | null;
  isInitialized: boolean;
  isStreaming: boolean;

  // Current input state (for backward compatibility)
  currentPoint: RawInputPoint | null;
  inProximity: boolean;

  // Event listener
  unlisten: UnlistenFn | null;

  // Actions
  init: (options?: {
    backend?: BackendType;
    pollingRate?: number;
    pressureCurve?: string;
  }) => Promise<void>;
  switchBackend: (
    backend: BackendType,
    options?: {
      pollingRate?: number;
      pressureCurve?: string;
    }
  ) => Promise<boolean>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  refresh: () => Promise<void>;
  cleanup: () => void;

  // Internal
  _setPoint: (point: RawInputPoint) => void;
  _setProximity: (inProximity: boolean) => void;
}

export const useTabletStore = create<TabletState>((set, get) => ({
  // Initial state
  status: 'Disconnected',
  backend: 'none',
  info: null,
  isInitialized: false,
  isStreaming: false,
  currentPoint: null,
  inProximity: false,
  unlisten: null,

  // Initialize tablet backend
  init: async (options = {}) => {
    try {
      const response = await invoke<TabletStatusResponse>('init_tablet', {
        backend: options.backend,
        pollingRate: options.pollingRate,
        pressureCurve: options.pressureCurve,
      });

      set({
        status: response.status,
        backend: response.backend,
        info: response.info,
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

  // Switch active backend without app restart
  switchBackend: async (backend, options = {}) => {
    try {
      const response = await invoke<TabletStatusResponse>('switch_tablet_backend', {
        backend,
        pollingRate: options.pollingRate,
        pressureCurve: options.pressureCurve,
      });

      set({
        status: response.status,
        backend: response.backend,
        info: response.info,
        isInitialized: true,
      });
      return true;
    } catch (error) {
      console.error('[Tablet] Switch backend failed:', error);
      return false;
    }
  },

  // Start streaming tablet events
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
      // Setup event listener
      const unlisten = await listen<TabletEvent>('tablet-event', (event) => {
        const payload = event.payload;

        if (typeof payload === 'object' && 'Input' in payload) {
          const point = payload.Input;
          // Add to ring buffer (high-frequency, no React re-render)
          addPointToBuffer(point);
          // Also update currentPoint for backward compatibility
          get()._setPoint(point);
        } else if (payload === 'ProximityEnter') {
          // console.log('[Tablet] Proximity enter');
          get()._setProximity(true);
        } else if (payload === 'ProximityLeave') {
          // console.log('[Tablet] Proximity leave');
          get()._setProximity(false);
          // Clear buffer and currentPoint on proximity leave
          clearPointBuffer();
          set({ currentPoint: null });
        } else if (typeof payload === 'object' && 'StatusChanged' in payload) {
          set({ status: payload.StatusChanged });
        }
      });

      set({ unlisten });

      // Start backend
      await invoke('start_tablet');

      set({ isStreaming: true });
    } catch (error) {
      console.error('[Tablet] Start failed:', error);
    }
  },

  // Stop streaming
  stop: async () => {
    const state = get();

    if (!state.isStreaming) {
      return;
    }

    try {
      await invoke('stop_tablet');

      // Cleanup listener
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

  // Refresh status
  refresh: async () => {
    try {
      const response = await invoke<TabletStatusResponse>('get_tablet_status');
      set({
        status: response.status,
        backend: response.backend,
        info: response.info,
      });
    } catch (error) {
      console.error('[Tablet] Refresh failed:', error);
    }
  },

  // Cleanup on unmount
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

  // Internal setters
  _setPoint: (point) => set({ currentPoint: point }),
  _setProximity: (inProximity) => set({ inProximity }),
}));

// Hook for pushing PointerEvent data to backend (fallback mode)
export async function pushPointerEvent(
  x: number,
  y: number,
  pressure: number,
  tiltX: number,
  tiltY: number
): Promise<void> {
  try {
    await invoke('push_pointer_event', {
      x,
      y,
      pressure,
      tiltX,
      tiltY,
    });
  } catch (error) {
    console.error('[Tablet] Push pointer event failed:', error);
  }
}
