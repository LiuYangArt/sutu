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

function normalizeQueuedPhase(phase: unknown): QueuedPoint['phase'] {
  if (phase === 'down' || phase === 'move' || phase === 'up' || phase === 'hover') {
    return phase;
  }
  return 'move';
}

function resolveNativePointOffset(
  anchorEvent: Pick<PointerEvent, 'clientX' | 'clientY'>,
  anchorNativePoint: { x: number; y: number } | null
): { x: number; y: number } {
  if (
    !anchorNativePoint ||
    !Number.isFinite(anchorNativePoint.x) ||
    !Number.isFinite(anchorNativePoint.y)
  ) {
    return { x: 0, y: 0 };
  }
  return {
    x: anchorEvent.clientX - anchorNativePoint.x,
    y: anchorEvent.clientY - anchorNativePoint.y,
  };
}

function nativePointToCanvasPoint(
  canvas: HTMLCanvasElement,
  point: TabletInputPoint,
  rect: DOMRect,
  offset: { x: number; y: number }
): { x: number; y: number } {
  return clientToCanvasPoint(canvas, point.x + offset.x, point.y + offset.y, rect);
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

      // Only process during active drawing with brush-like tools
      if (!isDrawingRef.current || (currentTool !== 'brush' && currentTool !== 'eraser')) return;

      const state = strokeStateRef.current;
      if (state !== 'starting' && state !== 'active') return;

      // Mark that raw input is being used
      usingRawInputRef.current = true;

      // Get canvas coordinates
      const rect = canvas.getBoundingClientRect();

      // Process all coalesced events from raw update
      const sampledEvents = pe.getCoalescedEvents?.();
      const coalescedEvents = sampledEvents && sampledEvents.length > 0 ? sampledEvents : [pe];

      // Get tablet state for pressure resolution
      const tabletState = useTabletStore.getState();
      const isNativeBackendActive = isNativeTabletStreamingState(tabletState);
      const shouldUseNativeBackend = isNativeBackendActive && pe.isTrusted;
      const { points: bufferedPoints, nextSeq } = shouldUseNativeBackend
        ? readPointBufferSince(nativeSeqCursorRef.current)
        : { points: [], nextSeq: nativeSeqCursorRef.current };
      if (shouldUseNativeBackend) {
        nativeSeqCursorRef.current = nextSeq;
      }
      if (shouldUseNativeBackend && bufferedPoints.length > 0) {
        const lastEvent = coalescedEvents[coalescedEvents.length - 1] ?? pe;
        const anchorNativePoint = bufferedPoints[bufferedPoints.length - 1] ?? null;
        const nativeOffset = resolveNativePointOffset(lastEvent, anchorNativePoint);
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
            nativeOffset
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
