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
interface NativePointMapping {
  native_to_client_scale_x: number;
  native_to_client_scale_y: number;
  client_offset_x: number;
  client_offset_y: number;
}
type StrokeGeometrySource = 'unset' | 'native' | 'pointer';

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

function resolveNativePointMapping(
  canvas: HTMLCanvasElement,
  rect: DOMRect,
  anchorEvent: Pick<PointerEvent, 'clientX' | 'clientY'>,
  anchorNativePoint: { x: number; y: number } | null
): NativePointMapping {
  if (
    !anchorNativePoint ||
    !Number.isFinite(anchorNativePoint.x) ||
    !Number.isFinite(anchorNativePoint.y)
  ) {
    return {
      native_to_client_scale_x: 1,
      native_to_client_scale_y: 1,
      client_offset_x: 0,
      client_offset_y: 0,
    };
  }

  const canvas_to_client_scale_x =
    rect.width > 1e-6 ? Math.max(1e-6, canvas.width / rect.width) : 1;
  const canvas_to_client_scale_y =
    rect.height > 1e-6 ? Math.max(1e-6, canvas.height / rect.height) : 1;
  const ratio_x =
    Math.abs(anchorEvent.clientX) > 8
      ? Math.abs(anchorNativePoint.x / anchorEvent.clientX)
      : Number.NaN;
  const ratio_y =
    Math.abs(anchorEvent.clientY) > 8
      ? Math.abs(anchorNativePoint.y / anchorEvent.clientY)
      : Number.NaN;
  const dpi_scaled_x =
    Number.isFinite(ratio_x) &&
    canvas_to_client_scale_x > 1.05 &&
    Math.abs(ratio_x - canvas_to_client_scale_x) <= Math.max(0.25, canvas_to_client_scale_x * 0.3);
  const dpi_scaled_y =
    Number.isFinite(ratio_y) &&
    canvas_to_client_scale_y > 1.05 &&
    Math.abs(ratio_y - canvas_to_client_scale_y) <= Math.max(0.25, canvas_to_client_scale_y * 0.3);

  const native_to_client_scale_x = dpi_scaled_x ? 1 / canvas_to_client_scale_x : 1;
  const native_to_client_scale_y = dpi_scaled_y ? 1 / canvas_to_client_scale_y : 1;
  const anchor_native_client_x = anchorNativePoint.x * native_to_client_scale_x;
  const anchor_native_client_y = anchorNativePoint.y * native_to_client_scale_y;
  return {
    native_to_client_scale_x,
    native_to_client_scale_y,
    client_offset_x: anchorEvent.clientX - anchor_native_client_x,
    client_offset_y: anchorEvent.clientY - anchor_native_client_y,
  };
}

function nativePointToCanvasPoint(
  canvas: HTMLCanvasElement,
  point: TabletInputPoint,
  rect: DOMRect,
  mapping: NativePointMapping
): { x: number; y: number } {
  const client_x = point.x * mapping.native_to_client_scale_x + mapping.client_offset_x;
  const client_y = point.y * mapping.native_to_client_scale_y + mapping.client_offset_y;
  return clientToCanvasPoint(canvas, client_x, client_y, rect);
}

function toNonReleasePointerEvent(event: PointerEvent): PointerEvent {
  return {
    ...event,
    type: 'pointermove',
  } as PointerEvent;
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
  const strokeNativeMappingRef = useRef<NativePointMapping | null>(null);
  const strokeGeometrySourceRef = useRef<StrokeGeometrySource>('unset');

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;

    // Only enable when pointerrawupdate is supported
    if (!container || !canvas || !supportsPointerRawUpdate) {
      usingRawInputRef.current = false;
      strokeGeometrySourceRef.current = 'unset';
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
        strokeNativeMappingRef.current = null;
        usingRawInputRef.current = false;
        strokeGeometrySourceRef.current = 'unset';
        return;
      }

      const state = strokeStateRef.current;
      if (state !== 'starting' && state !== 'active') {
        strokeNativeMappingRef.current = null;
        usingRawInputRef.current = false;
        strokeGeometrySourceRef.current = 'unset';
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
      if (strokeGeometrySourceRef.current === 'unset') {
        strokeGeometrySourceRef.current = shouldUseNativeBackend ? 'native' : 'pointer';
      }
      const preferNativeGeometry = strokeGeometrySourceRef.current === 'native';
      if (preferNativeGeometry && shouldUseNativeBackend && bufferedPoints.length > 0) {
        const lastEvent = coalescedEvents[coalescedEvents.length - 1] ?? pe;
        const anchorNativePoint = bufferedPoints[bufferedPoints.length - 1] ?? null;
        const nativeMapping = (() => {
          const existing = strokeNativeMappingRef.current;
          if (existing) return existing;
          const computed = resolveNativePointMapping(canvas, rect, lastEvent, anchorNativePoint);
          strokeNativeMappingRef.current = computed;
          return computed;
        })();
        const moveEvent = toNonReleasePointerEvent(pe);

        for (const nativePoint of bufferedPoints) {
          const nativePhase = normalizeQueuedPhase((nativePoint as { phase?: unknown }).phase);
          if (nativePhase === 'hover' || nativePhase === 'up') {
            continue;
          }
          const { x: canvasX, y: canvasY } = nativePointToCanvasPoint(
            canvas,
            nativePoint,
            rect,
            nativeMapping
          );

          const {
            pressure,
            tiltX,
            tiltY,
            rotation,
            timestampMs,
            source,
            hostTimeUs,
            deviceTimeUs,
          } = getEffectiveInputData(
            moveEvent,
            true,
            bufferedPoints,
            tabletState.currentPoint,
            pe,
            nativePoint
          );

          const idx = pointIndexRef.current++;
          latencyProfiler.markInputReceived(idx, pe);
          const point: QueuedPoint = {
            x: canvasX,
            y: canvasY,
            pressure,
            tiltX,
            tiltY,
            rotation,
            timestampMs,
            source,
            phase: nativePhase === 'down' ? 'down' : 'move',
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
        return;
      }
      if (preferNativeGeometry) {
        return;
      }

      for (const evt of coalescedEvents) {
        const { x: canvasX, y: canvasY } = clientToCanvasPoint(
          canvas,
          evt.clientX,
          evt.clientY,
          rect
        );
        const { pressure, tiltX, tiltY, rotation, timestampMs, source, hostTimeUs, deviceTimeUs } =
          getEffectiveInputData(evt, false, bufferedPoints, tabletState.currentPoint, pe, null);

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
      strokeNativeMappingRef.current = null;
      strokeGeometrySourceRef.current = 'unset';
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
