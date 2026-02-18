import { useEffect, useRef, MutableRefObject } from 'react';
import { readPointBufferSince, useTabletStore, type TabletInputPoint } from '@/stores/tablet';
import { getEffectiveInputData, isNativeTabletStreamingState } from './inputUtils';
import { clientToCanvasPoint } from './canvasGeometry';

/**
 * Q1 Optimization: Use pointerrawupdate event for lower-latency input.
 *
 * pointerrawupdate fires at the hardware polling rate (up to 1000Hz for gaming mice/tablets)
 * before the browser coalesces events into pointermove. This reduces input latency by 1-3ms.
 *
 * @see https://w3c.github.io/pointerevents/#the-pointerrawupdate-event
 */

// Check if pointerrawupdate is supported (non-standard, mainly Chromium)
export const supportsPointerRawUpdate =
  typeof window !== 'undefined' && 'onpointerrawupdate' in window;

type QueuedPoint = {
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  rotation: number;
  timestampMs: number;
  source: 'wintab' | 'macnative' | 'pointerevent';
  phase: 'down' | 'move' | 'up' | 'hover';
  hostTimeUs: number;
  deviceTimeUs: number;
  pointIndex: number;
};
const MAX_NATIVE_RECENT_POINTS = 64;
const MAX_NATIVE_RECENT_WINDOW_US = 120_000;
const MAX_NATIVE_CONSECUTIVE_GAP_US = 40_000;

function normalizeQueuedPhase(phase: unknown): QueuedPoint['phase'] {
  if (phase === 'down' || phase === 'move' || phase === 'up' || phase === 'hover') {
    return phase;
  }
  return 'move';
}

function resolveNativePointTimeUs(point: TabletInputPoint): number {
  if (Number.isFinite(point.host_time_us)) {
    return Math.max(0, Math.round(point.host_time_us));
  }
  if (Number.isFinite(point.timestamp_ms)) {
    return Math.max(0, Math.round(point.timestamp_ms * 1000));
  }
  return 0;
}

function selectRecentNativeStrokePoints(points: TabletInputPoint[]): TabletInputPoint[] {
  if (points.length === 0) return [];

  let contactStart = 0;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const phase = normalizeQueuedPhase((points[i] as { phase?: unknown }).phase);
    if (phase === 'hover' || phase === 'up') {
      contactStart = i + 1;
      break;
    }
  }

  const contactSlice = points.slice(contactStart);
  const source = contactSlice.length > 0 ? contactSlice : points;
  if (source.length === 0) return [];

  const tailTimeUs = resolveNativePointTimeUs(source[source.length - 1]!);
  let start = source.length - 1;
  for (let i = source.length - 2; i >= 0; i -= 1) {
    const current = source[i]!;
    const next = source[i + 1]!;
    const currentTimeUs = resolveNativePointTimeUs(current);
    const nextTimeUs = resolveNativePointTimeUs(next);
    if (tailTimeUs - currentTimeUs > MAX_NATIVE_RECENT_WINDOW_US) {
      break;
    }
    if (nextTimeUs > currentTimeUs && nextTimeUs - currentTimeUs > MAX_NATIVE_CONSECUTIVE_GAP_US) {
      break;
    }
    start = i;
  }

  const recent = source.slice(start);
  if (recent.length <= MAX_NATIVE_RECENT_POINTS) {
    return recent;
  }
  return recent.slice(recent.length - MAX_NATIVE_RECENT_POINTS);
}

interface RawPointerInputConfig {
  containerRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  isDrawingRef: MutableRefObject<boolean>;
  currentTool: string;
  strokeStateRef: MutableRefObject<string>;
  pendingPointsRef: MutableRefObject<QueuedPoint[]>;
  inputQueueRef: MutableRefObject<QueuedPoint[]>;
  pointIndexRef: MutableRefObject<number>;
  latencyProfiler: { markInputReceived: (idx: number, evt: PointerEvent) => void };
  onPointBuffered?: () => void;
}

/**
 * Hook to handle pointerrawupdate events for drawing input.
 * Falls back gracefully when not supported - the existing pointermove handler continues to work.
 */
export function useRawPointerInput({
  containerRef,
  canvasRef,
  isDrawingRef,
  currentTool,
  strokeStateRef,
  pendingPointsRef,
  inputQueueRef,
  pointIndexRef,
  latencyProfiler,
  onPointBuffered,
}: RawPointerInputConfig) {
  // Track if we're using raw input (for diagnostics)
  const usingRawInputRef = useRef(false);
  const nativeSeqCursorRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;

    // Only enable when pointerrawupdate is supported
    if (!container || !canvas || !supportsPointerRawUpdate) {
      usingRawInputRef.current = false;
      return;
    }

    const handleRawUpdate = (e: Event) => {
      // Cast to PointerEvent (pointerrawupdate is a PointerEvent)
      const pe = e as PointerEvent;

      // Get tablet state for pressure resolution and keep native cursor fresh
      const tabletState = useTabletStore.getState();
      const isNativeBackendActive = isNativeTabletStreamingState(tabletState);
      const shouldUseNativeBackend = isNativeBackendActive && pe.isTrusted;
      const { points: bufferedPointsRaw, nextSeq } = shouldUseNativeBackend
        ? readPointBufferSince(nativeSeqCursorRef.current)
        : { points: [], nextSeq: nativeSeqCursorRef.current };
      if (shouldUseNativeBackend) {
        nativeSeqCursorRef.current = nextSeq;
      }

      // Only process during active drawing with brush-like tools
      if (!isDrawingRef.current || (currentTool !== 'brush' && currentTool !== 'eraser')) {
        usingRawInputRef.current = false;
        return;
      }

      const state = strokeStateRef.current;
      if (state !== 'starting' && state !== 'active') {
        usingRawInputRef.current = false;
        return;
      }

      // Mark that raw input is being used
      usingRawInputRef.current = true;

      // Get canvas coordinates
      const rect = canvas.getBoundingClientRect();

      // Process all coalesced events from raw update
      const sampledEvents = pe.getCoalescedEvents?.();
      const coalescedEvents = sampledEvents && sampledEvents.length > 0 ? sampledEvents : [pe];

      const bufferedPoints = shouldUseNativeBackend
        ? selectRecentNativeStrokePoints(bufferedPointsRaw)
        : bufferedPointsRaw;
      const nativeStartIndex = Math.max(0, bufferedPoints.length - coalescedEvents.length);

      for (let eventIndex = 0; eventIndex < coalescedEvents.length; eventIndex += 1) {
        const evt = coalescedEvents[eventIndex]!;
        const nativePoint =
          shouldUseNativeBackend && bufferedPoints.length > 0
            ? (bufferedPoints[nativeStartIndex + eventIndex] ??
              bufferedPoints[bufferedPoints.length - 1] ??
              null)
            : null;
        const { x: canvasX, y: canvasY } = clientToCanvasPoint(
          canvas,
          evt.clientX,
          evt.clientY,
          rect
        );
        const { pressure, tiltX, tiltY, rotation, timestampMs, source, hostTimeUs, deviceTimeUs } =
          getEffectiveInputData(
            evt,
            shouldUseNativeBackend,
            bufferedPoints,
            tabletState.currentPoint,
            pe,
            nativePoint
          );

        const idx = pointIndexRef.current++;
        latencyProfiler.markInputReceived(idx, evt);

        const point: QueuedPoint = {
          x: canvasX,
          y: canvasY,
          pressure,
          tiltX,
          tiltY,
          rotation,
          timestampMs,
          source,
          phase: 'move' as const,
          hostTimeUs,
          deviceTimeUs,
          pointIndex: idx,
        };

        if (state === 'starting') {
          pendingPointsRef.current.push(point);
        } else if (state === 'active') {
          inputQueueRef.current.push(point);
        }

        onPointBuffered?.();
      }
    };

    // Register using string type to avoid TypeScript issues with non-standard event
    container.addEventListener('pointerrawupdate', handleRawUpdate, { passive: true });

    return () => {
      container.removeEventListener('pointerrawupdate', handleRawUpdate);
      usingRawInputRef.current = false;
    };
  }, [
    containerRef,
    canvasRef,
    isDrawingRef,
    currentTool,
    strokeStateRef,
    pendingPointsRef,
    inputQueueRef,
    pointIndexRef,
    latencyProfiler,
    onPointBuffered,
  ]);

  return { usingRawInput: usingRawInputRef, supportsRawInput: supportsPointerRawUpdate };
}
