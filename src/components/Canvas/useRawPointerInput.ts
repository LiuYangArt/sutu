import { useEffect, useRef, MutableRefObject } from 'react';
import { readPointBufferSince, useTabletStore, type InputPhase } from '@/stores/tablet';
import { getEffectiveInputData, isNativeTabletStreamingState } from './inputUtils';
import { clientToCanvasPoint } from './canvasGeometry';
import { recordKritaTailInputRaw } from '@/test/kritaTailTrace/collector';

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
  pointIndex: number;
  inputSeq: number;
  phase: 'down' | 'move' | 'up';
};

function normalizeTracePhase(phase: InputPhase | undefined, fallback: 'down' | 'move' | 'up') {
  if (phase === 'down' || phase === 'move' || phase === 'up') {
    return phase;
  }
  return fallback;
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
  const fallbackSeqRef = useRef(1);

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
      const nativeStartIndex = Math.max(0, bufferedPoints.length - coalescedEvents.length);

      for (let eventIndex = 0; eventIndex < coalescedEvents.length; eventIndex += 1) {
        const evt = coalescedEvents[eventIndex]!;
        const nativePoint =
          shouldUseNativeBackend && bufferedPoints.length > 0
            ? (bufferedPoints[nativeStartIndex + eventIndex] ??
              bufferedPoints[bufferedPoints.length - 1] ??
              null)
            : null;
        const inputSeq =
          nativePoint && Number.isInteger(nativePoint.seq)
            ? nativePoint.seq
            : fallbackSeqRef.current++;
        const phase = normalizeTracePhase(nativePoint?.phase, 'move');
        const { x: canvasX, y: canvasY } = clientToCanvasPoint(
          canvas,
          evt.clientX,
          evt.clientY,
          rect
        );

        // Resolve pressure/tilt from native backend or PointerEvent
        const { pressure, tiltX, tiltY, rotation, timestampMs } = getEffectiveInputData(
          evt,
          shouldUseNativeBackend,
          bufferedPoints,
          tabletState.currentPoint,
          pe,
          nativePoint
        );
        recordKritaTailInputRaw({
          seq: inputSeq,
          seqSource: nativePoint && Number.isInteger(nativePoint.seq) ? 'native' : 'fallback',
          timestampMs,
          x: canvasX,
          y: canvasY,
          pressureRaw: pressure,
          phase,
        });

        const idx = pointIndexRef.current++;
        latencyProfiler.markInputReceived(idx, evt);

        const point = {
          x: canvasX,
          y: canvasY,
          pressure,
          tiltX,
          tiltY,
          rotation,
          timestampMs,
          pointIndex: idx,
          inputSeq,
          phase,
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
