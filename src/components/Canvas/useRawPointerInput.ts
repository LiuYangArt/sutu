import { useEffect, useRef, MutableRefObject } from 'react';
import { useTabletStore, drainPointBuffer } from '@/stores/tablet';
import { getEffectiveInputData } from './inputUtils';
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

type QueuedPoint = { x: number; y: number; pressure: number; pointIndex: number };

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

      // Only process during active drawing with brush tool
      if (!isDrawingRef.current || currentTool !== 'brush') return;

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
      const isWinTabActive =
        tabletState.isStreaming &&
        typeof tabletState.backend === 'string' &&
        tabletState.backend.toLowerCase() === 'wintab';
      const shouldUseWinTab = isWinTabActive && pe.isTrusted;
      const bufferedPoints = shouldUseWinTab ? drainPointBuffer() : [];

      for (const evt of coalescedEvents) {
        const { x: canvasX, y: canvasY } = clientToCanvasPoint(
          canvas,
          evt.clientX,
          evt.clientY,
          rect
        );

        // Resolve pressure/tilt from WinTab or PointerEvent
        const { pressure } = getEffectiveInputData(
          evt,
          shouldUseWinTab,
          bufferedPoints,
          tabletState.currentPoint
        );

        const idx = pointIndexRef.current++;
        latencyProfiler.markInputReceived(idx, evt);

        const point = { x: canvasX, y: canvasY, pressure, pointIndex: idx };

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
