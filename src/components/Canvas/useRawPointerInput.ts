import { useCallback, useEffect, useRef, MutableRefObject, RefObject } from 'react';
import { useTabletStore } from '@/stores/tablet';
import { isNativeTabletStreamingState, parsePointerEventSample } from './inputUtils';
import { clientToCanvasPoint } from './canvasGeometry';

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

interface RawPointerInputConfig {
  containerRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  isDrawingRef: MutableRefObject<boolean>;
  currentTool: string;
  usingRawInputRef?: MutableRefObject<boolean>;
  pointerIngressHandlerRef?: MutableRefObject<((events: PointerEvent[]) => void) | null>;
  strokeStateRef: MutableRefObject<string>;
  pendingPointsRef: MutableRefObject<QueuedPoint[]>;
  inputQueueRef: MutableRefObject<QueuedPoint[]>;
  pointIndexRef: MutableRefObject<number>;
  latencyProfiler: { markInputReceived: (idx: number, evt: PointerEvent) => void };
  onPointBuffered?: () => void;
}

function isPointerEventMode(): boolean {
  const tabletState = useTabletStore.getState();
  const nativeStreaming = isNativeTabletStreamingState(tabletState);
  if (nativeStreaming) return false;
  const activeBackend = (tabletState.activeBackend ?? '').toLowerCase();
  const backend = (tabletState.backend ?? '').toLowerCase();
  return activeBackend === 'pointerevent' || backend === 'pointerevent';
}

/**
 * Hook to handle pointerrawupdate events for lower-latency PointerEvent mode.
 * WinTab/MacNative modes are intentionally disabled to avoid mixed-source sampling.
 */
export function useRawPointerInput({
  containerRef,
  canvasRef,
  isDrawingRef,
  currentTool,
  usingRawInputRef,
  pointerIngressHandlerRef,
  strokeStateRef,
  pendingPointsRef,
  inputQueueRef,
  pointIndexRef,
  latencyProfiler,
  onPointBuffered,
}: RawPointerInputConfig) {
  const internalUsingRawInputRef = useRef(false);
  const resolvedUsingRawInputRef = usingRawInputRef ?? internalUsingRawInputRef;

  const setUsingRawInput = useCallback(
    (value: boolean): void => {
      resolvedUsingRawInputRef.current = value;
    },
    [resolvedUsingRawInputRef]
  );

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;

    if (!container || !canvas || !supportsPointerRawUpdate) {
      setUsingRawInput(false);
      return;
    }

    const handleRawUpdate = (e: Event) => {
      const pe = e as PointerEvent;
      if (!isPointerEventMode()) {
        setUsingRawInput(false);
        return;
      }
      if (!isDrawingRef.current || (currentTool !== 'brush' && currentTool !== 'eraser')) {
        setUsingRawInput(false);
        return;
      }

      const state = strokeStateRef.current;
      if (state !== 'starting' && state !== 'active') {
        setUsingRawInput(false);
        return;
      }

      const sampledEvents = pe.getCoalescedEvents?.();
      const coalescedEvents = sampledEvents && sampledEvents.length > 0 ? sampledEvents : [pe];
      const ingressHandler = pointerIngressHandlerRef?.current;
      if (ingressHandler) {
        setUsingRawInput(true);
        ingressHandler(coalescedEvents);
        return;
      }

      setUsingRawInput(true);
      const rect = canvas.getBoundingClientRect();

      for (let eventIndex = 0; eventIndex < coalescedEvents.length; eventIndex += 1) {
        const evt = coalescedEvents[eventIndex]!;
        const { x: canvasX, y: canvasY } = clientToCanvasPoint(
          canvas,
          evt.clientX,
          evt.clientY,
          rect
        );
        const normalized = parsePointerEventSample(evt);
        const idx = pointIndexRef.current++;
        latencyProfiler.markInputReceived(idx, evt);

        const point: QueuedPoint = {
          x: canvasX,
          y: canvasY,
          pressure: normalized.pressure,
          tiltX: normalized.tiltX,
          tiltY: normalized.tiltY,
          rotation: normalized.rotation,
          timestampMs: normalized.timestampMs,
          source: normalized.source,
          phase: normalized.phase,
          hostTimeUs: normalized.hostTimeUs,
          deviceTimeUs: normalized.deviceTimeUs,
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

    container.addEventListener('pointerrawupdate', handleRawUpdate, { passive: true });
    return () => {
      container.removeEventListener('pointerrawupdate', handleRawUpdate);
      setUsingRawInput(false);
    };
  }, [
    containerRef,
    canvasRef,
    isDrawingRef,
    usingRawInputRef,
    pointerIngressHandlerRef,
    currentTool,
    strokeStateRef,
    pendingPointsRef,
    inputQueueRef,
    pointIndexRef,
    latencyProfiler,
    onPointBuffered,
    setUsingRawInput,
  ]);

  return { usingRawInput: resolvedUsingRawInputRef, supportsRawInput: supportsPointerRawUpdate };
}
