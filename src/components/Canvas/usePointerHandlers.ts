import { useCallback, useEffect, useRef, type RefObject, type MutableRefObject } from 'react';
import {
  readPointBufferSince,
  useTabletStore,
  type InputPhase,
  type TabletInputPoint,
} from '@/stores/tablet';
import { ToolType } from '@/stores/tool';
import { Layer } from '@/stores/document';
import { LatencyProfiler } from '@/benchmark/LatencyProfiler';
import { LayerRenderer } from '@/utils/layerRenderer';
import { getEffectiveInputData, isNativeTabletStreamingState } from './inputUtils';
import { clientToCanvasPoint } from './canvasGeometry';
import { recordKritaTailInputRaw } from '@/test/kritaTailTrace/collector';

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
  pointIndex: number;
  inputSeq: number;
  phase: 'down' | 'move' | 'up';
  traceSource?: 'normal' | 'pointerup_fallback';
  fallbackPressurePolicy?: 'none' | 'last_nonzero' | 'event_raw' | 'zero';
}

function normalizeTracePhase(phase: InputPhase | undefined, fallback: 'down' | 'move' | 'up') {
  if (phase === 'down' || phase === 'move' || phase === 'up') {
    return phase;
  }
  return fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
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
  const fallbackSeqRef = useRef(1);
  const activePointerIdRef = useRef<number | null>(null);
  const isPanningRef = useRef(isPanning);
  const pointerUpFinalizeTokenRef = useRef(0);
  const pointerupFinalizeInFlightRef = useRef(false);
  const lastNonZeroPressureRef = useRef<number | null>(null);

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

  const bumpPointerFinalizeToken = useCallback(() => {
    pointerUpFinalizeTokenRef.current += 1;
    return pointerUpFinalizeTokenRef.current;
  }, []);

  const beginPointerSession = useCallback(
    (pointerId: number, isTrusted: boolean) => {
      bumpPointerFinalizeToken();
      pointerupFinalizeInFlightRef.current = false;
      setActivePointerId(pointerId);
      trySetPointerCapture(pointerId, isTrusted);
    },
    [bumpPointerFinalizeToken, setActivePointerId, trySetPointerCapture]
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

  const rememberNonZeroPressure = useCallback((pressure: number) => {
    if (pressure > 0) {
      lastNonZeroPressureRef.current = clamp01(pressure);
    }
  }, []);

  const queueStrokePoint = useCallback(
    (point: QueuedPoint) => {
      rememberNonZeroPressure(point.pressure);
      const state = strokeStateRef.current;
      if (state === 'starting') {
        pendingPointsRef.current.push(point);
        window.__strokeDiagnostics?.onPointBuffered();
        return;
      }
      if (state === 'active') {
        inputQueueRef.current.push(point);
        window.__strokeDiagnostics?.onPointBuffered();
      }
    },
    [inputQueueRef, pendingPointsRef, rememberNonZeroPressure, strokeStateRef]
  );

  const queueNativeSampleForStroke = useCallback(
    (
      point: TabletInputPoint,
      fallbackEvent: PointerEvent,
      shouldUseNativeBackend: boolean,
      fallbackPhase: 'down' | 'move' | 'up' = 'move',
      phaseOverride?: 'down' | 'move' | 'up',
      canvasPositionOverride?: { x: number; y: number } | null
    ) => {
      const seqSource: 'native' | 'fallback' = Number.isInteger(point.seq) ? 'native' : 'fallback';
      const inputSeq = seqSource === 'native' ? point.seq : fallbackSeqRef.current++;
      const phase = phaseOverride ?? normalizeTracePhase(point.phase, fallbackPhase);
      const resolvedCanvasX = Number.isFinite(canvasPositionOverride?.x)
        ? Number(canvasPositionOverride!.x)
        : point.x;
      const resolvedCanvasY = Number.isFinite(canvasPositionOverride?.y)
        ? Number(canvasPositionOverride!.y)
        : point.y;
      const effective = getEffectiveInputData(
        fallbackEvent,
        shouldUseNativeBackend,
        [point],
        useTabletStore.getState().currentPoint,
        fallbackEvent,
        point
      );

      recordKritaTailInputRaw({
        seq: inputSeq,
        seqSource,
        timestampMs: effective.timestampMs,
        x: resolvedCanvasX,
        y: resolvedCanvasY,
        pressureRaw: effective.pressure,
        phase,
      });

      queueStrokePoint({
        x: resolvedCanvasX,
        y: resolvedCanvasY,
        pressure: effective.pressure,
        tiltX: effective.tiltX,
        tiltY: effective.tiltY,
        rotation: effective.rotation,
        timestampMs: effective.timestampMs,
        pointIndex: pointIndexRef.current++,
        inputSeq,
        phase,
      });
      latencyProfilerRef.current.markInputReceived(pointIndexRef.current - 1, fallbackEvent);

      return {
        seq: inputSeq,
        pressure: effective.pressure,
        phase,
      };
    },
    [latencyProfilerRef, pointIndexRef, queueStrokePoint]
  );

  const resolvePointerupFallbackPressure = useCallback(
    (nativeEvent: PointerEvent): { pressure: number; policy: 'last_nonzero' | 'event_raw' | 'zero' } => {
      const lastNonZero = lastNonZeroPressureRef.current;
      if (typeof lastNonZero === 'number' && lastNonZero > 0) {
        return {
          pressure: clamp01(lastNonZero),
          policy: 'last_nonzero',
        };
      }

      const eventRaw = clamp01(nativeEvent.pressure);
      if (eventRaw > 0) {
        return {
          pressure: eventRaw,
          policy: 'event_raw',
        };
      }

      return {
        pressure: 0,
        policy: 'zero',
      };
    },
    []
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
      if (pointerupFinalizeInFlightRef.current) return;

      const hasContactEvent = coalescedEvents.some(
        (evt) => (evt.buttons & 1) === 1 || evt.pressure > 0
      );
      if (!hasContactEvent) {
        return;
      }

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
        const seqSource: 'native' | 'fallback' =
          nativePoint && Number.isInteger(nativePoint.seq) ? 'native' : 'fallback';
        const inputSeq =
          seqSource === 'native' ? (nativePoint!.seq as number) : fallbackSeqRef.current++;
        const phase = normalizeTracePhase(nativePoint?.phase, 'move');
        const { x: canvasX, y: canvasY } = pointerEventToCanvasPoint(canvas, evt, rect);
        const { pressure, tiltX, tiltY, rotation, timestampMs } = getEffectiveInputData(
          evt,
          shouldUseNativeBackend,
          bufferedPoints,
          tabletState.currentPoint,
          nativeEvent,
          nativePoint
        );
        recordKritaTailInputRaw({
          seq: inputSeq,
          seqSource,
          timestampMs,
          x: canvasX,
          y: canvasY,
          pressureRaw: pressure,
          phase,
        });

        const idx = pointIndexRef.current++;
        latencyProfilerRef.current.markInputReceived(idx, evt);

        queueStrokePoint({
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
        });
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
      queueStrokePoint,
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

      const resolveFallbackUpCanvasPoint = (): { x: number; y: number } | null => {
        const queueTail = inputQueueRef.current[inputQueueRef.current.length - 1] ?? null;
        if (queueTail && Number.isFinite(queueTail.x) && Number.isFinite(queueTail.y)) {
          return { x: queueTail.x, y: queueTail.y };
        }
        const pendingTail = pendingPointsRef.current[pendingPointsRef.current.length - 1] ?? null;
        if (pendingTail && Number.isFinite(pendingTail.x) && Number.isFinite(pendingTail.y)) {
          return { x: pendingTail.x, y: pendingTail.y };
        }
        const lastInput = lastInputPosRef.current;
        if (lastInput && Number.isFinite(lastInput.x) && Number.isFinite(lastInput.y)) {
          return { x: lastInput.x, y: lastInput.y };
        }
        const canvas = canvasRef.current;
        if (!canvas) return null;
        return pointerEventToCanvasPoint(canvas, nativeEvent);
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

      if (isStrokeTool(currentTool)) {
        const finalizeToken = bumpPointerFinalizeToken();
        const pointerId = nativeEvent.pointerId;
        pointerupFinalizeInFlightRef.current = true;

        const runPointerupFinalize = async (): Promise<void> => {
          const tabletState = useTabletStore.getState();
          const isNativeBackendActive = isNativeTabletStreamingState(tabletState);
          const shouldUseNativeBackend = isNativeBackendActive && nativeEvent.isTrusted;
          const upSeqSnapshot = nativeSeqCursorRef.current;
          let currentCursor = upSeqSnapshot;
          let hasNativeTerminalPoint = false;
          let reachedTerminalBoundary = false;

          const consumeNativeTailPoints = (): void => {
            if (reachedTerminalBoundary) {
              return;
            }
            const { points, nextSeq } = readPointBufferSince(currentCursor);
            const newPoints = points.filter(
              (point) => Number.isInteger(point.seq) && point.seq > currentCursor
            );
            if (newPoints.length === 0) {
              currentCursor = Math.max(currentCursor, nextSeq);
              return;
            }

            let consumedTailSeq = currentCursor;
            let consumedTerminalSeq: number | null = null;
            for (const point of newPoints) {
              const tailAnchorPoint = resolveFallbackUpCanvasPoint();
              const isTerminalLikePoint =
                point.phase === 'up' || point.phase === 'hover' || point.pressure <= 0;
              const consumed = queueNativeSampleForStroke(
                point,
                nativeEvent,
                shouldUseNativeBackend,
                'move',
                isTerminalLikePoint ? 'up' : undefined,
                tailAnchorPoint
              );
              consumedTailSeq = point.seq;
              if (consumed.phase === 'up') {
                hasNativeTerminalPoint = true;
                reachedTerminalBoundary = true;
                consumedTerminalSeq = point.seq;
                break;
              }
            }

            if (consumedTerminalSeq !== null) {
              currentCursor = Math.max(currentCursor, consumedTerminalSeq);
            } else {
              currentCursor = Math.max(currentCursor, consumedTailSeq, nextSeq);
            }
          };

          if (shouldUseNativeBackend) {
            consumeNativeTailPoints();

            for (let attempt = 0; attempt < 2; attempt += 1) {
              await new Promise<void>((resolve) => setTimeout(resolve, 4));
              if (pointerUpFinalizeTokenRef.current !== finalizeToken) {
                return;
              }
              consumeNativeTailPoints();
            }
            nativeSeqCursorRef.current = currentCursor;
          }

          if (pointerUpFinalizeTokenRef.current !== finalizeToken) {
            return;
          }

          if (shouldUseNativeBackend && !hasNativeTerminalPoint) {
            const fallback = resolvePointerupFallbackPressure(nativeEvent);
            const fallbackPoint = resolveFallbackUpCanvasPoint();
            if (fallbackPoint) {
              const canvasX = fallbackPoint.x;
              const canvasY = fallbackPoint.y;
              const seq = fallbackSeqRef.current++;
              const eventDerived = getEffectiveInputData(
                nativeEvent,
                false,
                [],
                useTabletStore.getState().currentPoint,
                nativeEvent
              );
              const timestampMs =
                Number.isFinite(nativeEvent.timeStamp) && nativeEvent.timeStamp >= 0
                  ? nativeEvent.timeStamp
                  : eventDerived.timestampMs;
              recordKritaTailInputRaw({
                seq,
                seqSource: 'fallback',
                timestampMs,
                x: canvasX,
                y: canvasY,
                pressureRaw: fallback.pressure,
                phase: 'up',
              });

              const pointIndex = pointIndexRef.current++;
              latencyProfilerRef.current.markInputReceived(pointIndex, nativeEvent);
              queueStrokePoint({
                x: canvasX,
                y: canvasY,
                pressure: fallback.pressure,
                tiltX: eventDerived.tiltX,
                tiltY: eventDerived.tiltY,
                rotation: eventDerived.rotation,
                timestampMs,
                pointIndex,
                inputSeq: seq,
                phase: 'up',
                traceSource: 'pointerup_fallback',
                fallbackPressurePolicy: fallback.policy,
              });
            }
          }

          if (pointerUpFinalizeTokenRef.current !== finalizeToken) {
            return;
          }
          await finishCurrentStroke();
        };

        void (async () => {
          try {
            await runPointerupFinalize();
          } finally {
            if (pointerUpFinalizeTokenRef.current !== finalizeToken) {
              return;
            }
            usingRawInput.current = false;
            pointerupFinalizeInFlightRef.current = false;
            endPointerSession(pointerId);
          }
        })();
        return;
      }

      usingRawInput.current = false;
      pointerupFinalizeInFlightRef.current = false;
      endPointerSession(nativeEvent.pointerId);
    },
    [
      setIsPanning,
      panStartRef,
      isZoomingRef,
      zoomStartRef,
      isSelectionToolActive,
      canvasRef,
      inputQueueRef,
      pendingPointsRef,
      lastInputPosRef,
      handleSelectionPointerUp,
      currentTool,
      handleMovePointerUp,
      handleGradientPointerUp,
      bumpPointerFinalizeToken,
      queueNativeSampleForStroke,
      resolvePointerupFallbackPressure,
      pointIndexRef,
      latencyProfilerRef,
      queueStrokePoint,
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

      bumpPointerFinalizeToken();
      usingRawInput.current = false;
      pointerupFinalizeInFlightRef.current = false;
      endPointerSession();
      void finishCurrentStroke();
    }, [
    bumpPointerFinalizeToken,
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
      let inputSeq = fallbackSeqRef.current++;
      let inputSeqSource: 'native' | 'fallback' = 'fallback';
      let inputPhase: 'down' | 'move' | 'up' = 'down';
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
        if (shouldUseNativeBackend) {
          if (lastBufferedPoint) {
            pressure = lastBufferedPoint.pressure;
            timestampMs = lastBufferedPoint.timestamp_ms;
            if (Number.isInteger(lastBufferedPoint.seq)) {
              inputSeq = lastBufferedPoint.seq;
              inputSeqSource = 'native';
            } else {
              inputSeq = fallbackSeqRef.current++;
              inputSeqSource = 'fallback';
            }
            inputPhase = normalizeTracePhase(lastBufferedPoint.phase, 'down');
          } else if (pe.pointerType === 'pen') {
            window.__strokeDiagnostics?.onStartPressureFallback();
            pressure = 0;
          }
        }
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
        recordKritaTailInputRaw({
          seq: inputSeq,
          seqSource: inputSeqSource,
          timestampMs,
          x: constrainedDown.x,
          y: constrainedDown.y,
          pressureRaw: pressure,
          phase: inputPhase,
        });
      }

      beginPointerSession(e.pointerId, pe.isTrusted);
      usingRawInput.current = false;

      if (!isStrokeTool(currentTool)) {
        return;
      }

      lastNonZeroPressureRef.current = null;
      rememberNonZeroPressure(pressure);
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
          pointIndex: idx,
          inputSeq,
          phase: inputPhase,
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
      rememberNonZeroPressure,
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
