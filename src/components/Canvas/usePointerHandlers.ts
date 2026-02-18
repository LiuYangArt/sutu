import { useCallback, useEffect, useRef, type RefObject, type MutableRefObject } from 'react';
import { readPointBufferSince, useTabletStore } from '@/stores/tablet';
import { ToolType } from '@/stores/tool';
import { Layer } from '@/stores/document';
import { LatencyProfiler } from '@/benchmark/LatencyProfiler';
import { LayerRenderer } from '@/utils/layerRenderer';
import { getEffectiveInputData, isNativeTabletStreamingState } from './inputUtils';
import { clientToCanvasPoint } from './canvasGeometry';

function pointerEventToCanvasPoint(
  canvas: HTMLCanvasElement,
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
  rect?: DOMRect
): { x: number; y: number } {
  return clientToCanvasPoint(canvas, event.clientX, event.clientY, rect);
}

interface QueuedPoint {
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  rotation: number;
  timestampMs: number;
  source: 'wintab' | 'macnative' | 'pointerevent';
  hostTimeUs: number;
  deviceTimeUs: number;
  pointIndex: number;
}

interface UsePointerHandlersParams {
  containerRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  layerRendererRef: RefObject<LayerRenderer | null>;
  useGpuDisplay: boolean;
  sampleGpuPixelColor?: (canvasX: number, canvasY: number) => Promise<string | null>;
  currentTool: ToolType;
  scale: number;
  spacePressed: boolean;
  isPanning: boolean;
  setIsPanning: (isPanning: boolean) => void;
  panStartRef: MutableRefObject<{ x: number; y: number } | null>;
  pan: (deltaX: number, deltaY: number) => void;
  isZoomingRef: MutableRefObject<boolean>;
  zoomStartRef: MutableRefObject<{ x: number; y: number; startScale: number } | null>;
  setScale: (scale: number, centerX?: number, centerY?: number) => void;
  setBrushColor: (color: string) => void;
  width: number;
  height: number;
  layers: Layer[];
  activeLayerId: string | null;
  captureBeforeImage: () => Promise<void>;
  initializeBrushStroke: () => Promise<void>;
  finishCurrentStroke: () => Promise<void>;
  isSelectionToolActive: boolean;
  handleSelectionPointerDown: (
    canvasX: number,
    canvasY: number,
    e: PointerEvent | React.PointerEvent
  ) => boolean;
  handleSelectionPointerMove: (
    canvasX: number,
    canvasY: number,
    e: PointerEvent | React.PointerEvent
  ) => void;
  handleSelectionPointerUp: (canvasX: number, canvasY: number) => void;
  handleMovePointerDown: (
    canvasX: number,
    canvasY: number,
    e: PointerEvent | React.PointerEvent
  ) => boolean;
  handleMovePointerMove: (
    canvasX: number,
    canvasY: number,
    e: PointerEvent | React.PointerEvent
  ) => boolean;
  handleMovePointerUp: (
    canvasX: number,
    canvasY: number,
    e: PointerEvent | React.PointerEvent
  ) => boolean;
  handleGradientPointerDown?: (
    canvasX: number,
    canvasY: number,
    e: PointerEvent | React.PointerEvent
  ) => boolean;
  handleGradientPointerMove?: (
    canvasX: number,
    canvasY: number,
    e: PointerEvent | React.PointerEvent
  ) => void;
  handleGradientPointerUp?: (
    canvasX: number,
    canvasY: number,
    e: PointerEvent | React.PointerEvent
  ) => void;
  updateShiftLineCursor: (x: number, y: number) => void;
  lockShiftLine: (point: { x: number; y: number }) => void;
  constrainShiftLinePoint: (x: number, y: number) => { x: number; y: number };
  usingRawInput: MutableRefObject<boolean>;
  isDrawingRef: MutableRefObject<boolean>;
  strokeStateRef: MutableRefObject<string>;
  pendingPointsRef: MutableRefObject<QueuedPoint[]>;
  inputQueueRef: MutableRefObject<QueuedPoint[]>;
  pointIndexRef: MutableRefObject<number>;
  pendingEndRef: MutableRefObject<boolean>;
  lastInputPosRef: MutableRefObject<{ x: number; y: number } | null>;
  latencyProfilerRef: MutableRefObject<LatencyProfiler>;
  onBeforeCanvasMutation?: () => void;
}

function isStrokeTool(tool: ToolType): boolean {
  return tool === 'brush' || tool === 'eraser';
}

function isEventInsideContainer(container: HTMLDivElement | null, event: PointerEvent): boolean {
  if (!container) return false;
  const target = event.target;
  return target instanceof Node ? container.contains(target) : false;
}

export function usePointerHandlers({
  containerRef,
  canvasRef,
  layerRendererRef,
  useGpuDisplay,
  sampleGpuPixelColor,
  currentTool,
  scale,
  spacePressed,
  isPanning,
  setIsPanning,
  panStartRef,
  pan,
  isZoomingRef,
  zoomStartRef,
  setScale,
  setBrushColor,
  width,
  height,
  layers,
  activeLayerId,
  captureBeforeImage,
  initializeBrushStroke,
  finishCurrentStroke,
  isSelectionToolActive,
  handleSelectionPointerDown,
  handleSelectionPointerMove,
  handleSelectionPointerUp,
  handleMovePointerDown,
  handleMovePointerMove,
  handleMovePointerUp,
  handleGradientPointerDown,
  handleGradientPointerMove,
  handleGradientPointerUp,
  updateShiftLineCursor,
  lockShiftLine,
  constrainShiftLinePoint,
  usingRawInput,
  isDrawingRef,
  strokeStateRef,
  pendingPointsRef,
  inputQueueRef,
  pointIndexRef,
  pendingEndRef,
  lastInputPosRef,
  latencyProfilerRef,
  onBeforeCanvasMutation,
}: UsePointerHandlersParams) {
  const nativeSeqCursorRef = useRef(0);
  const activePointerIdRef = useRef<number | null>(null);
  const isPanningRef = useRef(isPanning);

  useEffect(() => {
    isPanningRef.current = isPanning;
  }, [isPanning]);

  const setActivePointerId = useCallback((pointerId: number) => {
    activePointerIdRef.current = pointerId;
  }, []);

  const clearActivePointerId = useCallback((pointerId?: number) => {
    if (typeof pointerId === 'number' && activePointerIdRef.current !== pointerId) {
      return false;
    }
    activePointerIdRef.current = null;
    return true;
  }, []);

  const trySetPointerCapture = useCallback(
    (pointerId: number, isTrusted: boolean) => {
      if (!isTrusted) return;
      const container = containerRef.current;
      if (!container) return;
      try {
        container.setPointerCapture(pointerId);
      } catch {
        // Ignore invalid pointer capture on platform/browser edge cases.
      }
    },
    [containerRef]
  );

  const tryReleasePointerCapture = useCallback(
    (pointerId: number | null) => {
      const container = containerRef.current;
      if (!container || pointerId === null) return;
      try {
        container.releasePointerCapture(pointerId);
      } catch {
        // Ignore invalid pointer release on platform/browser edge cases.
      }
    },
    [containerRef]
  );

  const beginPointerSession = useCallback(
    (pointerId: number, isTrusted: boolean) => {
      setActivePointerId(pointerId);
      trySetPointerCapture(pointerId, isTrusted);
    },
    [setActivePointerId, trySetPointerCapture]
  );

  const endPointerSession = useCallback(
    (pointerId?: number) => {
      const releaseId =
        typeof pointerId === 'number' ? pointerId : (activePointerIdRef.current ?? null);
      tryReleasePointerCapture(releaseId);
      clearActivePointerId(pointerId);
    },
    [clearActivePointerId, tryReleasePointerCapture]
  );

  const pickColorAt = useCallback(
    async (canvasX: number, canvasY: number) => {
      const x = Math.floor(canvasX);
      const y = Math.floor(canvasY);
      if (x < 0 || x >= width || y < 0 || y >= height) return;

      if (useGpuDisplay && sampleGpuPixelColor) {
        const gpuHex = await sampleGpuPixelColor(x, y);
        if (gpuHex) {
          setBrushColor(gpuHex);
          return;
        }
      }

      const compositeCanvas = layerRendererRef.current?.composite();
      const fallbackCanvas = canvasRef.current;
      const sourceCanvas = compositeCanvas ?? fallbackCanvas;
      const ctx = sourceCanvas?.getContext('2d', { willReadFrequently: true });
      if (!sourceCanvas || !ctx) return;

      const pixel = ctx.getImageData(x, y, 1, 1).data;
      const alpha = pixel[3] ?? 0;
      if (alpha <= 0) return;
      const r = pixel[0] ?? 0;
      const g = pixel[1] ?? 0;
      const b = pixel[2] ?? 0;

      const hex = `#${r.toString(16).padStart(2, '0')}${g
        .toString(16)
        .padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      setBrushColor(hex);
    },
    [width, height, useGpuDisplay, sampleGpuPixelColor, setBrushColor, layerRendererRef, canvasRef]
  );

  const processPointerMoveNative = useCallback(
    (nativeEvent: PointerEvent) => {
      const activePointerId = activePointerIdRef.current;
      if (activePointerId !== null && nativeEvent.pointerId !== activePointerId) {
        return;
      }

      const sampledEvents = nativeEvent.getCoalescedEvents?.();
      const coalescedEvents =
        sampledEvents && sampledEvents.length > 0 ? sampledEvents : [nativeEvent];

      if (isPanningRef.current && panStartRef.current) {
        const lastEvent = coalescedEvents[coalescedEvents.length - 1] ?? nativeEvent;
        const deltaX = lastEvent.clientX - panStartRef.current.x;
        const deltaY = lastEvent.clientY - panStartRef.current.y;
        pan(deltaX, deltaY);
        panStartRef.current = { x: lastEvent.clientX, y: lastEvent.clientY };
        return;
      }

      if (isZoomingRef.current && zoomStartRef.current) {
        const lastEvent = coalescedEvents[coalescedEvents.length - 1] ?? nativeEvent;
        const deltaX = lastEvent.clientX - zoomStartRef.current.x;
        const zoomFactor = 1 + deltaX * 0.01;
        const newScale = zoomStartRef.current.startScale * zoomFactor;

        const container = containerRef.current;
        if (container) {
          const rect = container.getBoundingClientRect();
          const initialClickX = zoomStartRef.current.x - rect.left;
          const initialClickY = zoomStartRef.current.y - rect.top;
          setScale(newScale, initialClickX, initialClickY);
        }
        return;
      }

      if (isSelectionToolActive) {
        const lastEvent = coalescedEvents[coalescedEvents.length - 1] ?? nativeEvent;
        const canvas = canvasRef.current;
        if (canvas) {
          const { x: canvasX, y: canvasY } = pointerEventToCanvasPoint(canvas, lastEvent);
          handleSelectionPointerMove(canvasX, canvasY, lastEvent);
        }
        return;
      }

      if (currentTool === 'move') {
        const lastEvent = coalescedEvents[coalescedEvents.length - 1] ?? nativeEvent;
        const canvas = canvasRef.current;
        if (canvas) {
          const { x: canvasX, y: canvasY } = pointerEventToCanvasPoint(canvas, lastEvent);
          if (handleMovePointerMove(canvasX, canvasY, lastEvent)) {
            return;
          }
        }
        return;
      }

      if (currentTool === 'gradient') {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const lastEvent = coalescedEvents[coalescedEvents.length - 1] ?? nativeEvent;
        const { x: canvasX, y: canvasY } = pointerEventToCanvasPoint(canvas, lastEvent);
        handleGradientPointerMove?.(canvasX, canvasY, lastEvent);
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const lastEvent = coalescedEvents[coalescedEvents.length - 1] ?? nativeEvent;
      const mappedHoverPoint = pointerEventToCanvasPoint(canvas, lastEvent, rect);
      updateShiftLineCursor(mappedHoverPoint.x, mappedHoverPoint.y);

      if (!isDrawingRef.current) return;
      if (!isStrokeTool(currentTool)) return;
      if (usingRawInput.current) return;

      const tabletState = useTabletStore.getState();
      const isNativeBackendActive = isNativeTabletStreamingState(tabletState);
      const shouldUseNativeBackend = isNativeBackendActive && nativeEvent.isTrusted;
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
        const { x: canvasX, y: canvasY } = pointerEventToCanvasPoint(canvas, evt, rect);
        const { pressure, tiltX, tiltY, rotation, timestampMs, source, hostTimeUs, deviceTimeUs } =
          getEffectiveInputData(
            evt,
            shouldUseNativeBackend,
            bufferedPoints,
            tabletState.currentPoint,
            nativeEvent,
            nativePoint
          );

        const idx = pointIndexRef.current++;
        latencyProfilerRef.current.markInputReceived(idx, evt);

        const state = strokeStateRef.current;
        if (state === 'starting') {
          pendingPointsRef.current.push({
            x: canvasX,
            y: canvasY,
            pressure,
            tiltX,
            tiltY,
            rotation,
            timestampMs,
            source,
            hostTimeUs,
            deviceTimeUs,
            pointIndex: idx,
          });
          window.__strokeDiagnostics?.onPointBuffered();
        } else if (state === 'active') {
          inputQueueRef.current.push({
            x: canvasX,
            y: canvasY,
            pressure,
            tiltX,
            tiltY,
            rotation,
            timestampMs,
            source,
            hostTimeUs,
            deviceTimeUs,
            pointIndex: idx,
          });
          window.__strokeDiagnostics?.onPointBuffered();
        }
      }
    },
    [
      panStartRef,
      pan,
      isZoomingRef,
      zoomStartRef,
      containerRef,
      setScale,
      isSelectionToolActive,
      canvasRef,
      handleSelectionPointerMove,
      currentTool,
      handleMovePointerMove,
      handleGradientPointerMove,
      updateShiftLineCursor,
      isDrawingRef,
      usingRawInput,
      pointIndexRef,
      latencyProfilerRef,
      strokeStateRef,
      pendingPointsRef,
      inputQueueRef,
    ]
  );

  const processPointerUpNative = useCallback(
    (nativeEvent: PointerEvent) => {
      const activePointerId = activePointerIdRef.current;
      if (activePointerId !== null && nativeEvent.pointerId !== activePointerId) {
        return;
      }

      const withCanvasPoint = (handler: (canvasX: number, canvasY: number) => void): void => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const { x: canvasX, y: canvasY } = pointerEventToCanvasPoint(canvas, nativeEvent);
        handler(canvasX, canvasY);
      };

      if (isPanningRef.current) {
        setIsPanning(false);
        panStartRef.current = null;
        endPointerSession(nativeEvent.pointerId);
        return;
      }

      if (isZoomingRef.current) {
        isZoomingRef.current = false;
        zoomStartRef.current = null;
        endPointerSession(nativeEvent.pointerId);
        return;
      }

      if (isSelectionToolActive) {
        withCanvasPoint((canvasX, canvasY) => handleSelectionPointerUp(canvasX, canvasY));
        endPointerSession(nativeEvent.pointerId);
        return;
      }

      if (currentTool === 'move') {
        withCanvasPoint((canvasX, canvasY) => handleMovePointerUp(canvasX, canvasY, nativeEvent));
        endPointerSession(nativeEvent.pointerId);
        return;
      }

      if (currentTool === 'gradient') {
        withCanvasPoint((canvasX, canvasY) =>
          handleGradientPointerUp?.(canvasX, canvasY, nativeEvent)
        );
        endPointerSession(nativeEvent.pointerId);
        return;
      }

      usingRawInput.current = false;
      endPointerSession(nativeEvent.pointerId);
      void finishCurrentStroke();
    },
    [
      setIsPanning,
      panStartRef,
      isZoomingRef,
      zoomStartRef,
      isSelectionToolActive,
      canvasRef,
      handleSelectionPointerUp,
      currentTool,
      handleMovePointerUp,
      handleGradientPointerUp,
      usingRawInput,
      finishCurrentStroke,
      endPointerSession,
    ]
  );

  const resetPointerSessionOnBlur = useCallback(() => {
    if (activePointerIdRef.current === null) {
      return;
    }

    if (isPanningRef.current) {
      setIsPanning(false);
      panStartRef.current = null;
    }

    if (isZoomingRef.current) {
      isZoomingRef.current = false;
      zoomStartRef.current = null;
    }

    usingRawInput.current = false;
    endPointerSession();
    void finishCurrentStroke();
  }, [
    setIsPanning,
    panStartRef,
    isZoomingRef,
    zoomStartRef,
    usingRawInput,
    endPointerSession,
    finishCurrentStroke,
  ]);

  useEffect(() => {
    const shouldHandleWindowFallbackEvent = (event: PointerEvent): boolean => {
      const activePointerId = activePointerIdRef.current;
      if (activePointerId === null || event.pointerId !== activePointerId) return false;
      if (isEventInsideContainer(containerRef.current, event)) return false;
      return true;
    };

    const handleWindowPointerMove = (event: PointerEvent): void => {
      if (!shouldHandleWindowFallbackEvent(event)) return;
      processPointerMoveNative(event);
    };

    const handleWindowPointerUp = (event: PointerEvent): void => {
      if (!shouldHandleWindowFallbackEvent(event)) return;
      processPointerUpNative(event);
    };

    const handleWindowPointerCancel = (event: PointerEvent): void => {
      if (!shouldHandleWindowFallbackEvent(event)) return;
      processPointerUpNative(event);
    };

    window.addEventListener('pointermove', handleWindowPointerMove, {
      capture: true,
      passive: true,
    });
    window.addEventListener('pointerup', handleWindowPointerUp, {
      capture: true,
      passive: true,
    });
    window.addEventListener('pointercancel', handleWindowPointerCancel, {
      capture: true,
      passive: true,
    });
    window.addEventListener('blur', resetPointerSessionOnBlur);

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove, { capture: true });
      window.removeEventListener('pointerup', handleWindowPointerUp, { capture: true });
      window.removeEventListener('pointercancel', handleWindowPointerCancel, { capture: true });
      window.removeEventListener('blur', resetPointerSessionOnBlur);
    };
  }, [containerRef, processPointerMoveNative, processPointerUpNative, resetPointerSessionOnBlur]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;

      const activePointerId = activePointerIdRef.current;
      if (activePointerId !== null && activePointerId !== e.pointerId) {
        return;
      }

      if (!container.contains(document.activeElement)) {
        container.focus({ preventScroll: true });
      }

      if (spacePressed) {
        beginPointerSession(e.pointerId, (e.nativeEvent as PointerEvent).isTrusted);
        setIsPanning(true);
        panStartRef.current = { x: e.clientX, y: e.clientY };
        return;
      }

      if (currentTool === 'zoom') {
        if (isDrawingRef.current) {
          void finishCurrentStroke();
        }
        isZoomingRef.current = true;
        zoomStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          startScale: scale,
        };
        beginPointerSession(e.pointerId, (e.nativeEvent as PointerEvent).isTrusted);
        return;
      }

      const pe = e.nativeEvent as PointerEvent;
      let pressure = 0.5;
      let tiltX = 0;
      let tiltY = 0;
      let rotation = 0;
      let timestampMs = Number.isFinite(pe.timeStamp) ? pe.timeStamp : performance.now();
      let source: 'wintab' | 'macnative' | 'pointerevent' = 'pointerevent';
      let hostTimeUs = Math.round(timestampMs * 1000);
      let deviceTimeUs = 0;
      if (pe.pointerType === 'pen') {
        pressure = pe.pressure > 0 ? pe.pressure : 0;
      } else if (pe.pressure > 0) {
        pressure = pe.pressure;
      }
      if (isStrokeTool(currentTool)) {
        const tabletState = useTabletStore.getState();
        const isNativeBackendActive = isNativeTabletStreamingState(tabletState);
        const shouldUseNativeBackend = isNativeBackendActive && pe.isTrusted;
        const { points: bufferedPoints, nextSeq } = shouldUseNativeBackend
          ? readPointBufferSince(nativeSeqCursorRef.current)
          : { points: [], nextSeq: nativeSeqCursorRef.current };
        if (shouldUseNativeBackend) {
          nativeSeqCursorRef.current = nextSeq;
        }
        const lastBufferedPoint = bufferedPoints[bufferedPoints.length - 1] ?? null;
        const effectiveInput = getEffectiveInputData(
          pe,
          shouldUseNativeBackend,
          bufferedPoints,
          tabletState.currentPoint,
          pe,
          lastBufferedPoint
        );
        pressure = effectiveInput.pressure;
        tiltX = effectiveInput.tiltX;
        tiltY = effectiveInput.tiltY;
        rotation = effectiveInput.rotation;
        timestampMs = effectiveInput.timestampMs;
        source = effectiveInput.source;
        hostTimeUs = effectiveInput.hostTimeUs;
        deviceTimeUs = effectiveInput.deviceTimeUs;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;

      const { x: canvasX, y: canvasY } = pointerEventToCanvasPoint(canvas, e);

      updateShiftLineCursor(canvasX, canvasY);

      if (currentTool === 'eyedropper') {
        void pickColorAt(canvasX, canvasY);
        return;
      }

      if (isSelectionToolActive) {
        const handled = handleSelectionPointerDown(canvasX, canvasY, pe);
        if (handled) {
          beginPointerSession(e.pointerId, pe.isTrusted);
          return;
        }
      }

      if (currentTool === 'move') {
        const handled = handleMovePointerDown(canvasX, canvasY, pe);
        if (handled) {
          beginPointerSession(e.pointerId, pe.isTrusted);
          return;
        }
      }

      if (currentTool === 'gradient') {
        const handled = handleGradientPointerDown?.(canvasX, canvasY, pe) ?? false;
        if (handled) {
          beginPointerSession(e.pointerId, pe.isTrusted);
        }
        return;
      }

      const activeLayer = layers.find((l) => l.id === activeLayerId);
      if (!activeLayerId || !activeLayer?.visible) return;

      let constrainedDown = { x: canvasX, y: canvasY };
      if (isStrokeTool(currentTool)) {
        lockShiftLine({ x: canvasX, y: canvasY });
        constrainedDown = constrainShiftLinePoint(canvasX, canvasY);
        lastInputPosRef.current = { x: constrainedDown.x, y: constrainedDown.y };
      }

      beginPointerSession(e.pointerId, pe.isTrusted);
      usingRawInput.current = false;

      if (!isStrokeTool(currentTool)) {
        return;
      }

      onBeforeCanvasMutation?.();

      isDrawingRef.current = true;
      const idx = pointIndexRef.current++;
      latencyProfilerRef.current.markInputReceived(idx, pe);

      strokeStateRef.current = 'starting';
      pendingPointsRef.current = [
        {
          x: constrainedDown.x,
          y: constrainedDown.y,
          pressure,
          tiltX,
          tiltY,
          rotation,
          timestampMs,
          source,
          hostTimeUs,
          deviceTimeUs,
          pointIndex: idx,
        },
      ];
      pendingEndRef.current = false;

      window.__strokeDiagnostics?.onStrokeStart();
      void (async () => {
        await captureBeforeImage();
        await initializeBrushStroke();
      })();
    },
    [
      containerRef,
      spacePressed,
      setIsPanning,
      panStartRef,
      currentTool,
      isDrawingRef,
      finishCurrentStroke,
      isZoomingRef,
      zoomStartRef,
      scale,
      canvasRef,
      updateShiftLineCursor,
      pickColorAt,
      isSelectionToolActive,
      handleSelectionPointerDown,
      handleMovePointerDown,
      handleGradientPointerDown,
      layers,
      activeLayerId,
      lockShiftLine,
      constrainShiftLinePoint,
      lastInputPosRef,
      beginPointerSession,
      usingRawInput,
      onBeforeCanvasMutation,
      pointIndexRef,
      latencyProfilerRef,
      strokeStateRef,
      pendingPointsRef,
      pendingEndRef,
      captureBeforeImage,
      initializeBrushStroke,
    ]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      processPointerMoveNative(e.nativeEvent as PointerEvent);
    },
    [processPointerMoveNative]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      processPointerUpNative(e.nativeEvent as PointerEvent);
    },
    [processPointerUpNative]
  );

  const handlePointerCancel = useCallback(
    (e: React.PointerEvent) => {
      processPointerUpNative(e.nativeEvent as PointerEvent);
    },
    [processPointerUpNative]
  );

  return { handlePointerDown, handlePointerMove, handlePointerUp, handlePointerCancel };
}
