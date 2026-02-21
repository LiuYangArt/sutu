import { useCallback, useEffect, useRef, type RefObject, type MutableRefObject } from 'react';
import { readPointBufferSince, useTabletStore } from '@/stores/tablet';
import { ToolType } from '@/stores/tool';
import { Layer } from '@/stores/document';
import { useUiInteractionStore } from '@/stores/uiInteraction';
import { LatencyProfiler } from '@/benchmark/LatencyProfiler';
import { LayerRenderer } from '@/utils/layerRenderer';
import {
  MacnativeSessionRouterV3,
  createMacnativeSessionCursorV3,
  type MacnativeSessionDiagnosticsDelta,
  type UnifiedPointerEventV3,
} from '@/engine/kritaParityInput/macnativeSessionRouterV3';
import {
  isNativeTabletStreamingState,
  mapNativeWindowPxToCanvasPoint,
  parseNativeTabletSample,
  parsePointerEventSample,
  resolveStreamingBackendName,
  resolveNativeStrokePoints,
} from './inputUtils';
import { clientToCanvasPoint } from './canvasGeometry';
import { logTabletTrace } from '@/utils/tabletTrace';

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
  phase: 'down' | 'move' | 'up' | 'hover';
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

function normalizeBackendSessionKey(backendName: string | null): string {
  if (typeof backendName !== 'string' || backendName.length <= 0) {
    return 'none';
  }
  return backendName.toLowerCase();
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
  const DOM_POINTER_ACTIVITY_TIMEOUT_MS = 24;
  const DUPLICATE_POINTERDOWN_IGNORE_WINDOW_MS = 120;
  const nativeRouterRef = useRef<MacnativeSessionRouterV3>(new MacnativeSessionRouterV3());
  const nativeSessionCursorRef = useRef(createMacnativeSessionCursorV3());
  const activePointerIdRef = useRef<number | null>(null);
  const activeSessionBackendRef = useRef<string | null>(null);
  const sessionStartedWithoutTrustedDownRef = useRef<boolean>(false);
  const lastTrustedPointerDownAtMsRef = useRef<number>(-Infinity);
  const nonCanvasPointerIdsRef = useRef<Set<number>>(new Set());
  const isPanningRef = useRef(isPanning);
  const finishingStrokePromiseRef = useRef<Promise<void> | null>(null);
  const nativeMissingInputStreakRef = useRef(0);
  // Only track DOM contact-session activity; hover moves must not suppress native pump.
  const lastDomPointerActivityMsRef = useRef(0);

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
      const tabletState = useTabletStore.getState();
      activeSessionBackendRef.current = normalizeBackendSessionKey(
        resolveStreamingBackendName(tabletState.activeBackend, tabletState.backend)
      );
      if (isTrusted) {
        lastTrustedPointerDownAtMsRef.current =
          typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
      }
      sessionStartedWithoutTrustedDownRef.current = !isTrusted;
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
      const didClear = clearActivePointerId(pointerId);
      if (didClear) {
        activeSessionBackendRef.current = null;
        sessionStartedWithoutTrustedDownRef.current = false;
      }
    },
    [clearActivePointerId, tryReleasePointerCapture]
  );

  const requestFinishCurrentStroke = useCallback((): Promise<void> => {
    if (finishingStrokePromiseRef.current) {
      return finishingStrokePromiseRef.current;
    }
    const pending = (async () => {
      try {
        await finishCurrentStroke();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[Pointer] finishCurrentStroke failed', error);
      }
    })().finally(() => {
      if (finishingStrokePromiseRef.current === pending) {
        finishingStrokePromiseRef.current = null;
      }
    });
    finishingStrokePromiseRef.current = pending;
    return pending;
  }, [finishCurrentStroke]);

  const getNowMs = useCallback((): number => {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }, []);

  const markDomPointerActivity = useCallback(() => {
    lastDomPointerActivityMsRef.current = getNowMs();
  }, [getNowMs]);

  const applyNativeRouterDiagnosticsDelta = useCallback(
    (delta: MacnativeSessionDiagnosticsDelta, stage: string) => {
      if (delta.mixed_source_reject_count > 0) {
        logTabletTrace('frontend.anomaly.native_mixed_source_reject', {
          stage,
          count: delta.mixed_source_reject_count,
        });
      }
      if (delta.native_down_without_seed_count > 0) {
        logTabletTrace('frontend.anomaly.native_down_without_seed', {
          stage,
          count: delta.native_down_without_seed_count,
        });
      }
      if (delta.stroke_tail_drop_count > 0) {
        logTabletTrace('frontend.anomaly.native_stroke_tail_drop', {
          stage,
          count: delta.stroke_tail_drop_count,
        });
      }
      if (delta.seq_rewind_recovery_fail_count > 0) {
        logTabletTrace('frontend.anomaly.native_seq_rewind_recovery_fail', {
          stage,
          count: delta.seq_rewind_recovery_fail_count,
        });
      }
    },
    []
  );

  const consumeNativeRoutedPoints = useCallback(
    (
      stage: string
    ): {
      rawPoints: ReturnType<typeof readPointBufferSince>['points'];
      events: UnifiedPointerEventV3[];
      cursor: ReturnType<typeof createMacnativeSessionCursorV3>;
      bufferEpoch: number;
    } => {
      const readCursor = nativeSessionCursorRef.current.seq;
      const readResult = readPointBufferSince(readCursor);
      const effectiveBufferEpoch =
        typeof readResult.bufferEpoch === 'number' && Number.isFinite(readResult.bufferEpoch)
          ? readResult.bufferEpoch
          : nativeSessionCursorRef.current.bufferEpoch;
      const routeResult = nativeRouterRef.current.route({
        points: readResult.points,
        cursor: nativeSessionCursorRef.current,
        bufferEpoch: effectiveBufferEpoch,
      });
      nativeSessionCursorRef.current = routeResult.nextCursor;
      applyNativeRouterDiagnosticsDelta(routeResult.diagnosticsDelta, stage);
      return {
        rawPoints: readResult.points,
        events: routeResult.events,
        cursor: routeResult.nextCursor,
        bufferEpoch: effectiveBufferEpoch,
      };
    },
    [applyNativeRouterDiagnosticsDelta]
  );

  const flushNativePointBuffer = useCallback(() => {
    consumeNativeRoutedPoints('flush');
  }, [consumeNativeRoutedPoints]);

  const resetNativeSessionRouter = useCallback(() => {
    const bufferEpoch = nativeSessionCursorRef.current.bufferEpoch;
    nativeRouterRef.current.reset();
    nativeSessionCursorRef.current = createMacnativeSessionCursorV3({
      seq: 0,
      bufferEpoch,
      activeStrokeId: null,
    });
  }, []);

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
      if (useUiInteractionStore.getState().isCanvasInputLocked && !isDrawingRef.current) {
        return;
      }
      const activePointerId = activePointerIdRef.current;
      if (activePointerId !== null && nativeEvent.pointerId !== activePointerId) {
        return;
      }
      const hasKnownDomStrokeSession = activePointerId !== null || isDrawingRef.current;
      if (hasKnownDomStrokeSession) {
        markDomPointerActivity();
      }

      if (hasKnownDomStrokeSession) {
        logTabletTrace('frontend.pointermove.dom', {
          pointer_id: nativeEvent.pointerId,
          active_pointer_id: activePointerId,
          client_x: nativeEvent.clientX,
          client_y: nativeEvent.clientY,
          pressure: nativeEvent.pressure,
          tilt_x_deg: nativeEvent.tiltX,
          tilt_y_deg: nativeEvent.tiltY,
          twist_deg: nativeEvent.twist,
          event_type: nativeEvent.type,
          is_trusted: nativeEvent.isTrusted,
        });
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
      if (activePointerId !== null || isDrawingRef.current) {
        logTabletTrace('frontend.pointermove.dom_canvas', {
          pointer_id: nativeEvent.pointerId,
          active_pointer_id: activePointerId,
          mapped_canvas_x: mappedHoverPoint.x,
          mapped_canvas_y: mappedHoverPoint.y,
          pressure: lastEvent.pressure,
          buttons: lastEvent.buttons,
          pointer_type: lastEvent.pointerType,
        });
      }
      updateShiftLineCursor(mappedHoverPoint.x, mappedHoverPoint.y);

      if (!isDrawingRef.current) return;
      if (!isStrokeTool(currentTool)) return;
      if (usingRawInput.current) return;

      const tabletState = useTabletStore.getState();
      const isNativeBackendActive = isNativeTabletStreamingState(tabletState);
      const shouldUseNativeBackend = isNativeBackendActive && nativeEvent.isTrusted;
      if (shouldUseNativeBackend) {
        const nativeBatch = consumeNativeRoutedPoints('pointermove');
        const resolvedNativePoints = nativeBatch.events;
        if (resolvedNativePoints.length === 0) {
          const hasPointerContact =
            (typeof nativeEvent.pressure === 'number' && nativeEvent.pressure > 0) ||
            nativeEvent.buttons !== 0;
          nativeMissingInputStreakRef.current = hasPointerContact
            ? nativeMissingInputStreakRef.current + 1
            : 0;
          logTabletTrace('frontend.pointermove.native_empty', {
            pointer_id: nativeEvent.pointerId,
            active_pointer_id: activePointerId,
            read_cursor_seq: nativeBatch.cursor.seq,
            buffer_epoch: nativeBatch.bufferEpoch,
            buffered_native_points: nativeBatch.rawPoints.length,
            missing_streak: nativeMissingInputStreakRef.current,
            pointer_contact: hasPointerContact,
            mapped_canvas_x: mappedHoverPoint.x,
            mapped_canvas_y: mappedHoverPoint.y,
            pressure: nativeEvent.pressure,
            buttons: nativeEvent.buttons,
          });
          if (nativeMissingInputStreakRef.current >= 3) {
            logTabletTrace('frontend.anomaly.native_missing_with_pointer', {
              pointer_id: nativeEvent.pointerId,
              active_pointer_id: activePointerId,
              missing_streak: nativeMissingInputStreakRef.current,
              mapped_canvas_x: mappedHoverPoint.x,
              mapped_canvas_y: mappedHoverPoint.y,
              pressure: nativeEvent.pressure,
              buttons: nativeEvent.buttons,
            });
          }
          return;
        }
        nativeMissingInputStreakRef.current = 0;

        let firstNativeConsumed: {
          seq: number;
          strokeId: number;
          phase: string;
          xPx: number;
          yPx: number;
          mappedX: number;
          mappedY: number;
        } | null = null;
        let lastNativeConsumed: {
          seq: number;
          strokeId: number;
          phase: string;
          xPx: number;
          yPx: number;
          mappedX: number;
          mappedY: number;
        } | null = null;
        for (const nativePoint of resolvedNativePoints) {
          const normalized = parseNativeTabletSample(nativePoint);
          if (normalized.phase === 'hover') continue;

          const mapped = mapNativeWindowPxToCanvasPoint(
            canvas,
            rect,
            normalized.xPx,
            normalized.yPx,
            normalized.source
          );
          const idx = pointIndexRef.current++;
          latencyProfilerRef.current.markInputReceived(idx, nativeEvent);
          const queuedPoint: QueuedPoint = {
            x: mapped.x,
            y: mapped.y,
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

          logTabletTrace('frontend.pointermove.native_consume', {
            pointer_id: nativeEvent.pointerId,
            native_pointer_id: nativePoint.pointer_id,
            seq: nativePoint.seq,
            stroke_id: nativePoint.stroke_id,
            phase: normalized.phase,
            source: normalized.source,
            x_px: normalized.xPx,
            y_px: normalized.yPx,
            mapped_canvas_x: mapped.x,
            mapped_canvas_y: mapped.y,
            pressure_0_1: normalized.pressure,
            host_time_us: normalized.hostTimeUs,
            device_time_us: normalized.deviceTimeUs,
          });
          const consumed = {
            seq: nativePoint.seq,
            strokeId: nativePoint.stroke_id,
            phase: normalized.phase,
            xPx: normalized.xPx,
            yPx: normalized.yPx,
            mappedX: mapped.x,
            mappedY: mapped.y,
          };
          if (!firstNativeConsumed) {
            firstNativeConsumed = consumed;
          }
          lastNativeConsumed = consumed;

          const state = strokeStateRef.current;
          if (state === 'starting') {
            pendingPointsRef.current.push(queuedPoint);
            window.__strokeDiagnostics?.onPointBuffered();
          } else if (state === 'active') {
            inputQueueRef.current.push(queuedPoint);
            window.__strokeDiagnostics?.onPointBuffered();
          }
        }
        if (firstNativeConsumed && lastNativeConsumed) {
          logTabletTrace('frontend.pointermove.compare', {
            pointer_id: nativeEvent.pointerId,
            pointer_canvas_x: mappedHoverPoint.x,
            pointer_canvas_y: mappedHoverPoint.y,
            native_first_seq: firstNativeConsumed.seq,
            native_first_stroke_id: firstNativeConsumed.strokeId,
            native_first_phase: firstNativeConsumed.phase,
            native_first_canvas_x: firstNativeConsumed.mappedX,
            native_first_canvas_y: firstNativeConsumed.mappedY,
            native_last_seq: lastNativeConsumed.seq,
            native_last_stroke_id: lastNativeConsumed.strokeId,
            native_last_phase: lastNativeConsumed.phase,
            native_last_canvas_x: lastNativeConsumed.mappedX,
            native_last_canvas_y: lastNativeConsumed.mappedY,
            delta_last_x: lastNativeConsumed.mappedX - mappedHoverPoint.x,
            delta_last_y: lastNativeConsumed.mappedY - mappedHoverPoint.y,
          });
        }
        return;
      }

      for (let eventIndex = 0; eventIndex < coalescedEvents.length; eventIndex += 1) {
        const evt = coalescedEvents[eventIndex]!;
        const { x: canvasX, y: canvasY } = pointerEventToCanvasPoint(canvas, evt, rect);
        const normalized = parsePointerEventSample(evt);
        const idx = pointIndexRef.current++;
        latencyProfilerRef.current.markInputReceived(idx, evt);
        const queuedPoint: QueuedPoint = {
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

        logTabletTrace('frontend.pointermove.pointerevent_consume', {
          pointer_id: evt.pointerId,
          phase: normalized.phase,
          source: normalized.source,
          client_x: evt.clientX,
          client_y: evt.clientY,
          mapped_canvas_x: canvasX,
          mapped_canvas_y: canvasY,
          pressure_0_1: normalized.pressure,
          host_time_us: normalized.hostTimeUs,
          device_time_us: normalized.deviceTimeUs,
        });

        const state = strokeStateRef.current;
        if (state === 'starting') {
          pendingPointsRef.current.push(queuedPoint);
          window.__strokeDiagnostics?.onPointBuffered();
        } else if (state === 'active') {
          inputQueueRef.current.push(queuedPoint);
          window.__strokeDiagnostics?.onPointBuffered();
        }
      }
    },
    [
      markDomPointerActivity,
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
      consumeNativeRoutedPoints,
      pointIndexRef,
      latencyProfilerRef,
      strokeStateRef,
      pendingPointsRef,
      inputQueueRef,
    ]
  );

  const processPointerUpNative = useCallback(
    (nativeEvent: PointerEvent) => {
      if (useUiInteractionStore.getState().isCanvasInputLocked && !isDrawingRef.current) {
        return;
      }
      markDomPointerActivity();
      const activePointerId = activePointerIdRef.current;
      if (activePointerId !== null && nativeEvent.pointerId !== activePointerId) {
        return;
      }

      logTabletTrace('frontend.pointerup.dom', {
        pointer_id: nativeEvent.pointerId,
        active_pointer_id: activePointerId,
        client_x: nativeEvent.clientX,
        client_y: nativeEvent.clientY,
        pressure: nativeEvent.pressure,
        tilt_x_deg: nativeEvent.tiltX,
        tilt_y_deg: nativeEvent.tiltY,
        twist_deg: nativeEvent.twist,
        event_type: nativeEvent.type,
        is_trusted: nativeEvent.isTrusted,
      });

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

      if (isStrokeTool(currentTool) && isDrawingRef.current) {
        const canvas = canvasRef.current;
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const tabletState = useTabletStore.getState();
          const isNativeBackendActive = isNativeTabletStreamingState(tabletState);
          const shouldUseNativeBackend = isNativeBackendActive && nativeEvent.isTrusted;
          const queuedTailPoints: QueuedPoint[] = [];
          if (shouldUseNativeBackend) {
            const nativeBatch = consumeNativeRoutedPoints('pointerup');
            const resolvedNativePoints = nativeBatch.events;
            for (const nativePoint of resolvedNativePoints) {
              const normalized = parseNativeTabletSample(nativePoint);
              if (normalized.phase === 'hover') continue;
              const mapped = mapNativeWindowPxToCanvasPoint(
                canvas,
                rect,
                normalized.xPx,
                normalized.yPx,
                normalized.source
              );
              const idx = pointIndexRef.current++;
              latencyProfilerRef.current.markInputReceived(idx, nativeEvent);
              queuedTailPoints.push({
                x: mapped.x,
                y: mapped.y,
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
              });
              logTabletTrace('frontend.pointerup.native_consume', {
                pointer_id: nativeEvent.pointerId,
                native_pointer_id: nativePoint.pointer_id,
                seq: nativePoint.seq,
                stroke_id: nativePoint.stroke_id,
                phase: normalized.phase,
                source: normalized.source,
                x_px: normalized.xPx,
                y_px: normalized.yPx,
                mapped_canvas_x: mapped.x,
                mapped_canvas_y: mapped.y,
                pressure_0_1: normalized.pressure,
                host_time_us: normalized.hostTimeUs,
                device_time_us: normalized.deviceTimeUs,
              });
            }
          } else {
            const normalized = parsePointerEventSample(nativeEvent);
            const mapped = pointerEventToCanvasPoint(canvas, nativeEvent, rect);
            const idx = pointIndexRef.current++;
            latencyProfilerRef.current.markInputReceived(idx, nativeEvent);
            queuedTailPoints.push({
              x: mapped.x,
              y: mapped.y,
              pressure: normalized.pressure,
              tiltX: normalized.tiltX,
              tiltY: normalized.tiltY,
              rotation: normalized.rotation,
              timestampMs: normalized.timestampMs,
              source: normalized.source,
              phase: 'up',
              hostTimeUs: normalized.hostTimeUs,
              deviceTimeUs: normalized.deviceTimeUs,
              pointIndex: idx,
            });
            logTabletTrace('frontend.pointerup.pointerevent_consume', {
              pointer_id: nativeEvent.pointerId,
              phase: 'up',
              source: normalized.source,
              client_x: nativeEvent.clientX,
              client_y: nativeEvent.clientY,
              mapped_canvas_x: mapped.x,
              mapped_canvas_y: mapped.y,
              pressure_0_1: normalized.pressure,
              host_time_us: normalized.hostTimeUs,
              device_time_us: normalized.deviceTimeUs,
            });
          }

          const state = strokeStateRef.current;
          if (state === 'starting') {
            pendingPointsRef.current.push(...queuedTailPoints);
            for (let i = 0; i < queuedTailPoints.length; i += 1) {
              window.__strokeDiagnostics?.onPointBuffered();
            }
          } else if (state === 'active' || state === 'finishing') {
            inputQueueRef.current.push(...queuedTailPoints);
            for (let i = 0; i < queuedTailPoints.length; i += 1) {
              window.__strokeDiagnostics?.onPointBuffered();
            }
          }
        }
      }

      usingRawInput.current = false;
      nativeMissingInputStreakRef.current = 0;
      endPointerSession(nativeEvent.pointerId);
      void requestFinishCurrentStroke();
    },
    [
      markDomPointerActivity,
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
      requestFinishCurrentStroke,
      endPointerSession,
      isDrawingRef,
      strokeStateRef,
      pendingPointsRef,
      inputQueueRef,
      pointIndexRef,
      latencyProfilerRef,
      consumeNativeRoutedPoints,
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
    nativeMissingInputStreakRef.current = 0;
    resetNativeSessionRouter();
    endPointerSession();
    void requestFinishCurrentStroke();
  }, [
    setIsPanning,
    panStartRef,
    isZoomingRef,
    zoomStartRef,
    usingRawInput,
    resetNativeSessionRouter,
    endPointerSession,
    requestFinishCurrentStroke,
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

  useEffect(() => {
    const isInsideCanvasContainer = (target: EventTarget | null): boolean => {
      const container = containerRef.current;
      if (!container) return false;
      return target instanceof Node ? container.contains(target) : false;
    };

    const acquireNonCanvasLock = (pointerId: number): void => {
      if (nonCanvasPointerIdsRef.current.has(pointerId)) return;
      nonCanvasPointerIdsRef.current.add(pointerId);
      useUiInteractionStore.getState().acquireCanvasInputLock();
    };

    const releaseNonCanvasLock = (pointerId: number): void => {
      if (!nonCanvasPointerIdsRef.current.delete(pointerId)) return;
      useUiInteractionStore.getState().releaseCanvasInputLock();
    };

    const releaseAllNonCanvasLocks = (): void => {
      const lockCount = nonCanvasPointerIdsRef.current.size;
      if (lockCount <= 0) return;
      nonCanvasPointerIdsRef.current.clear();
      const store = useUiInteractionStore.getState();
      for (let i = 0; i < lockCount; i += 1) {
        store.releaseCanvasInputLock();
      }
    };

    const handleGlobalPointerDownCapture = (event: PointerEvent): void => {
      if (isInsideCanvasContainer(event.target)) return;
      acquireNonCanvasLock(event.pointerId);
      markDomPointerActivity();
      flushNativePointBuffer();
    };

    const handleGlobalPointerEndCapture = (event: PointerEvent): void => {
      releaseNonCanvasLock(event.pointerId);
      markDomPointerActivity();
      flushNativePointBuffer();
    };

    const handleWindowBlur = (): void => {
      releaseAllNonCanvasLocks();
      markDomPointerActivity();
      flushNativePointBuffer();
    };

    window.addEventListener('pointerdown', handleGlobalPointerDownCapture, {
      capture: true,
      passive: true,
    });
    window.addEventListener('pointerup', handleGlobalPointerEndCapture, {
      capture: true,
      passive: true,
    });
    window.addEventListener('pointercancel', handleGlobalPointerEndCapture, {
      capture: true,
      passive: true,
    });
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('pointerdown', handleGlobalPointerDownCapture, {
        capture: true,
      });
      window.removeEventListener('pointerup', handleGlobalPointerEndCapture, {
        capture: true,
      });
      window.removeEventListener('pointercancel', handleGlobalPointerEndCapture, {
        capture: true,
      });
      window.removeEventListener('blur', handleWindowBlur);
      releaseAllNonCanvasLocks();
    };
  }, [containerRef, markDomPointerActivity, flushNativePointBuffer]);

  const processPointerDownNative = useCallback(
    async (pe: PointerEvent) => {
      markDomPointerActivity();
      if (useUiInteractionStore.getState().isCanvasInputLocked) {
        logTabletTrace('frontend.pointerdown.blocked_input_lock', {
          pointer_id: pe.pointerId,
          client_x: pe.clientX,
          client_y: pe.clientY,
          is_trusted: pe.isTrusted,
          stroke_state: strokeStateRef.current,
          is_drawing: isDrawingRef.current,
        });
        return;
      }
      nativeMissingInputStreakRef.current = 0;
      const wantsStrokeInput = isStrokeTool(currentTool);
      const tabletStateSnapshot = useTabletStore.getState();
      const currentBackendSessionKey = normalizeBackendSessionKey(
        resolveStreamingBackendName(tabletStateSnapshot.activeBackend, tabletStateSnapshot.backend)
      );
      const activeSessionBackend = activeSessionBackendRef.current;
      const sameBackendDuplicateSession =
        activeSessionBackend !== null && activeSessionBackend === currentBackendSessionKey;
      const duplicatePointerDownAgeMs = getNowMs() - lastTrustedPointerDownAtMsRef.current;
      const shouldIgnoreDuplicatePointerDown =
        sameBackendDuplicateSession &&
        (duplicatePointerDownAgeMs <= DUPLICATE_POINTERDOWN_IGNORE_WINDOW_MS ||
          sessionStartedWithoutTrustedDownRef.current);
      const isActiveDuplicatePointerDown =
        wantsStrokeInput &&
        pe.isTrusted &&
        isDrawingRef.current &&
        activePointerIdRef.current === pe.pointerId &&
        isNativeTabletStreamingState(tabletStateSnapshot);
      if (isActiveDuplicatePointerDown) {
        if (shouldIgnoreDuplicatePointerDown) {
          logTabletTrace('frontend.pointerdown.duplicate_ignored', {
            pointer_id: pe.pointerId,
            stroke_state: strokeStateRef.current,
            duplicate_age_ms: duplicatePointerDownAgeMs,
            duplicate_ignore_window_ms: DUPLICATE_POINTERDOWN_IGNORE_WINDOW_MS,
            session_backend: activeSessionBackend,
            current_backend: currentBackendSessionKey,
            session_started_without_trusted_down: sessionStartedWithoutTrustedDownRef.current,
          });
          return;
        }
        logTabletTrace('frontend.pointerdown.duplicate_force_restart', {
          pointer_id: pe.pointerId,
          stroke_state: strokeStateRef.current,
          duplicate_age_ms: duplicatePointerDownAgeMs,
          duplicate_ignore_window_ms: DUPLICATE_POINTERDOWN_IGNORE_WINDOW_MS,
          session_backend: activeSessionBackend,
          current_backend: currentBackendSessionKey,
          session_started_without_trusted_down: sessionStartedWithoutTrustedDownRef.current,
        });
      }
      if (wantsStrokeInput) {
        if (finishingStrokePromiseRef.current) {
          await finishingStrokePromiseRef.current;
        }
        if (isDrawingRef.current || strokeStateRef.current === 'finishing') {
          await requestFinishCurrentStroke();
        }
      }

      const container = containerRef.current;
      if (!container) {
        logTabletTrace('frontend.pointerdown.blocked_no_container', {
          pointer_id: pe.pointerId,
          is_trusted: pe.isTrusted,
        });
        return;
      }

      const activePointerId = activePointerIdRef.current;
      if (activePointerId !== null && activePointerId !== pe.pointerId) {
        const shouldResetSessionForBackendSwitch =
          activeSessionBackend !== null && activeSessionBackend !== currentBackendSessionKey;
        if (!shouldResetSessionForBackendSwitch) {
          logTabletTrace('frontend.pointerdown.blocked_active_pointer_mismatch', {
            pointer_id: pe.pointerId,
            active_pointer_id: activePointerId,
            previous_backend: activeSessionBackend,
            current_backend: currentBackendSessionKey,
            stroke_state: strokeStateRef.current,
            is_drawing: isDrawingRef.current,
          });
          return;
        }
        logTabletTrace('frontend.pointerdown.backend_switch_session_reset', {
          stale_pointer_id: activePointerId,
          incoming_pointer_id: pe.pointerId,
          previous_backend: activeSessionBackend,
          current_backend: currentBackendSessionKey,
        });
        usingRawInput.current = false;
        nativeMissingInputStreakRef.current = 0;
        sessionStartedWithoutTrustedDownRef.current = false;
        resetNativeSessionRouter();
        endPointerSession(activePointerId);
      }

      if (!container.contains(document.activeElement)) {
        container.focus({ preventScroll: true });
      }

      if (spacePressed) {
        beginPointerSession(pe.pointerId, pe.isTrusted);
        setIsPanning(true);
        panStartRef.current = { x: pe.clientX, y: pe.clientY };
        return;
      }

      if (currentTool === 'zoom') {
        if (isDrawingRef.current) {
          await requestFinishCurrentStroke();
        }
        isZoomingRef.current = true;
        zoomStartRef.current = {
          x: pe.clientX,
          y: pe.clientY,
          startScale: scale,
        };
        beginPointerSession(pe.pointerId, pe.isTrusted);
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) {
        logTabletTrace('frontend.pointerdown.blocked_no_canvas', {
          pointer_id: pe.pointerId,
          is_trusted: pe.isTrusted,
          stroke_state: strokeStateRef.current,
        });
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const pointerCanvasPoint = pointerEventToCanvasPoint(canvas, pe, rect);

      const { x: canvasX, y: canvasY } = pointerCanvasPoint;
      logTabletTrace('frontend.pointerdown.dom', {
        pointer_id: pe.pointerId,
        client_x: pe.clientX,
        client_y: pe.clientY,
        mapped_canvas_x: canvasX,
        mapped_canvas_y: canvasY,
        pressure: pe.pressure,
        tilt_x_deg: pe.tiltX,
        tilt_y_deg: pe.tiltY,
        twist_deg: pe.twist,
        event_type: pe.type,
        is_trusted: pe.isTrusted,
        backend: tabletStateSnapshot.backend,
        active_backend: tabletStateSnapshot.activeBackend,
        is_streaming: tabletStateSnapshot.isStreaming,
      });

      updateShiftLineCursor(canvasX, canvasY);

      if (currentTool === 'eyedropper') {
        void pickColorAt(canvasX, canvasY);
        return;
      }

      if (isSelectionToolActive) {
        const handled = handleSelectionPointerDown(canvasX, canvasY, pe);
        if (handled) {
          beginPointerSession(pe.pointerId, pe.isTrusted);
          return;
        }
      }

      if (currentTool === 'move') {
        const handled = handleMovePointerDown(canvasX, canvasY, pe);
        if (handled) {
          beginPointerSession(pe.pointerId, pe.isTrusted);
          return;
        }
      }

      if (currentTool === 'gradient') {
        const handled = handleGradientPointerDown?.(canvasX, canvasY, pe) ?? false;
        if (handled) {
          beginPointerSession(pe.pointerId, pe.isTrusted);
        }
        return;
      }

      const activeLayer = layers.find((l) => l.id === activeLayerId);
      if (!activeLayerId || !activeLayer?.visible) {
        logTabletTrace('frontend.pointerdown.blocked_inactive_layer', {
          pointer_id: pe.pointerId,
          active_layer_id: activeLayerId,
          has_active_layer: !!activeLayer,
          active_layer_visible: activeLayer?.visible ?? false,
          current_tool: currentTool,
          is_trusted: pe.isTrusted,
        });
        return;
      }

      const tabletState = tabletStateSnapshot;
      const isNativeBackendActive = isNativeTabletStreamingState(tabletState);
      const shouldUseNativeBackend =
        isStrokeTool(currentTool) && isNativeBackendActive && pe.isTrusted;
      const strokeSeedPoints: Array<Omit<QueuedPoint, 'pointIndex'>> = [];
      if (isStrokeTool(currentTool)) {
        if (shouldUseNativeBackend) {
          const nativeBatch = consumeNativeRoutedPoints('pointerdown.seed');
          const resolvedNativePoints = resolveNativeStrokePoints(nativeBatch.events, null);
          for (const nativePoint of resolvedNativePoints) {
            const normalized = parseNativeTabletSample(nativePoint);
            if (normalized.phase === 'hover') continue;
            const mapped = mapNativeWindowPxToCanvasPoint(
              canvas,
              rect,
              normalized.xPx,
              normalized.yPx,
              normalized.source
            );
            strokeSeedPoints.push({
              x: mapped.x,
              y: mapped.y,
              pressure: normalized.pressure,
              tiltX: normalized.tiltX,
              tiltY: normalized.tiltY,
              rotation: normalized.rotation,
              timestampMs: normalized.timestampMs,
              source: normalized.source,
              phase: normalized.phase,
              hostTimeUs: normalized.hostTimeUs,
              deviceTimeUs: normalized.deviceTimeUs,
            });
            logTabletTrace('frontend.pointerdown.native_seed', {
              pointer_id: pe.pointerId,
              native_pointer_id: nativePoint.pointer_id,
              seq: nativePoint.seq,
              stroke_id: nativePoint.stroke_id,
              phase: normalized.phase,
              source: normalized.source,
              x_px: normalized.xPx,
              y_px: normalized.yPx,
              mapped_canvas_x: mapped.x,
              mapped_canvas_y: mapped.y,
              pressure_0_1: normalized.pressure,
              host_time_us: normalized.hostTimeUs,
              device_time_us: normalized.deviceTimeUs,
            });
          }
          if (strokeSeedPoints.length === 0) {
            logTabletTrace('frontend.pointerdown.native_seed_empty', {
              pointer_id: pe.pointerId,
              read_cursor_seq: nativeBatch.cursor.seq,
              buffer_epoch: nativeBatch.bufferEpoch,
              buffered_native_points: nativeBatch.rawPoints.length,
            });
          }
        } else {
          const normalized = parsePointerEventSample(pe);
          strokeSeedPoints.push({
            x: pointerCanvasPoint.x,
            y: pointerCanvasPoint.y,
            pressure: normalized.pressure,
            tiltX: normalized.tiltX,
            tiltY: normalized.tiltY,
            rotation: normalized.rotation,
            timestampMs: normalized.timestampMs,
            source: normalized.source,
            phase: 'down',
            hostTimeUs: normalized.hostTimeUs,
            deviceTimeUs: normalized.deviceTimeUs,
          });
          logTabletTrace('frontend.pointerdown.pointerevent_seed', {
            pointer_id: pe.pointerId,
            phase: 'down',
            source: normalized.source,
            client_x: pe.clientX,
            client_y: pe.clientY,
            mapped_canvas_x: pointerCanvasPoint.x,
            mapped_canvas_y: pointerCanvasPoint.y,
            pressure_0_1: normalized.pressure,
            host_time_us: normalized.hostTimeUs,
            device_time_us: normalized.deviceTimeUs,
          });
        }
      }

      let constrainedDown = { x: canvasX, y: canvasY };
      if (isStrokeTool(currentTool)) {
        const preferredDownPoint =
          strokeSeedPoints.find((point) => point.phase === 'down') ?? strokeSeedPoints[0];
        const downX = preferredDownPoint?.x ?? canvasX;
        const downY = preferredDownPoint?.y ?? canvasY;
        lockShiftLine({ x: downX, y: downY });
        constrainedDown = constrainShiftLinePoint(downX, downY);
        lastInputPosRef.current = { x: constrainedDown.x, y: constrainedDown.y };
      }

      beginPointerSession(pe.pointerId, pe.isTrusted);
      usingRawInput.current = false;

      if (!isStrokeTool(currentTool)) {
        return;
      }

      onBeforeCanvasMutation?.();

      isDrawingRef.current = true;
      const fallbackTimestampMs = Number.isFinite(pe.timeStamp) ? pe.timeStamp : performance.now();
      const constrainedSeedPoints =
        strokeSeedPoints.length > 0
          ? strokeSeedPoints.map((point, index) => {
              if (index === 0) {
                return { ...point, x: constrainedDown.x, y: constrainedDown.y };
              }
              const constrained = constrainShiftLinePoint(point.x, point.y);
              return {
                ...point,
                x: constrained.x,
                y: constrained.y,
              };
            })
          : shouldUseNativeBackend
            ? []
            : [
                {
                  x: constrainedDown.x,
                  y: constrainedDown.y,
                  pressure: 0,
                  tiltX: 0,
                  tiltY: 0,
                  rotation: 0,
                  timestampMs: fallbackTimestampMs,
                  source: 'pointerevent' as const,
                  phase: 'down' as const,
                  hostTimeUs: Math.max(0, Math.round(fallbackTimestampMs * 1000)),
                  deviceTimeUs: 0,
                },
              ];

      strokeStateRef.current = 'starting';
      pendingPointsRef.current = constrainedSeedPoints.map((point) => {
        const idx = pointIndexRef.current++;
        latencyProfilerRef.current.markInputReceived(idx, pe);
        return {
          ...point,
          pointIndex: idx,
        };
      });
      pendingEndRef.current = false;
      for (let i = 0; i < pendingPointsRef.current.length; i += 1) {
        window.__strokeDiagnostics?.onPointBuffered();
      }

      window.__strokeDiagnostics?.onStrokeStart();
      await captureBeforeImage();
      await initializeBrushStroke();
    },
    [
      markDomPointerActivity,
      containerRef,
      spacePressed,
      setIsPanning,
      panStartRef,
      currentTool,
      isDrawingRef,
      strokeStateRef,
      getNowMs,
      requestFinishCurrentStroke,
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
      consumeNativeRoutedPoints,
      resetNativeSessionRouter,
      usingRawInput,
      onBeforeCanvasMutation,
      pointIndexRef,
      latencyProfilerRef,
      pendingPointsRef,
      pendingEndRef,
      captureBeforeImage,
      initializeBrushStroke,
      endPointerSession,
    ]
  );

  useEffect(() => {
    let rafId = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;

      const canvasInputLocked = useUiInteractionStore.getState().isCanvasInputLocked;
      if (canvasInputLocked && !isDrawingRef.current) {
        flushNativePointBuffer();
        rafId = requestAnimationFrame(tick);
        return;
      }

      const tabletState = useTabletStore.getState();
      const nativeBackendActive =
        isStrokeTool(currentTool) && isNativeTabletStreamingState(tabletState);
      const domInactiveForMs = getNowMs() - lastDomPointerActivityMsRef.current;
      const shouldPumpNative =
        nativeBackendActive && domInactiveForMs >= DOM_POINTER_ACTIVITY_TIMEOUT_MS;

      if (shouldPumpNative) {
        const nativeBatch = consumeNativeRoutedPoints('native_pump');
        if (nativeBatch.events.length > 0) {
          const canvas = canvasRef.current;
          if (canvas) {
            const rect = canvas.getBoundingClientRect();
            const resolvedNativePoints = nativeBatch.events;
            for (const nativePoint of resolvedNativePoints) {
              const normalized = parseNativeTabletSample(nativePoint);
              if (normalized.phase === 'hover') continue;

              const mapped = mapNativeWindowPxToCanvasPoint(
                canvas,
                rect,
                normalized.xPx,
                normalized.yPx,
                normalized.source
              );

              if (!isDrawingRef.current) {
                if (normalized.phase !== 'down') {
                  continue;
                }

                const activeLayer = layers.find((l) => l.id === activeLayerId);
                if (!activeLayerId || !activeLayer?.visible) {
                  logTabletTrace('frontend.native_pump.stroke_skip', {
                    reason: 'active_layer_unavailable',
                    pointer_id: nativePoint.pointer_id,
                    stroke_id: nativePoint.stroke_id,
                    phase: normalized.phase,
                  });
                  continue;
                }

                const constrainedDown = constrainShiftLinePoint(mapped.x, mapped.y);
                lockShiftLine({ x: constrainedDown.x, y: constrainedDown.y });
                lastInputPosRef.current = { x: constrainedDown.x, y: constrainedDown.y };

                beginPointerSession(nativePoint.pointer_id, false);
                usingRawInput.current = false;
                onBeforeCanvasMutation?.();

                isDrawingRef.current = true;
                strokeStateRef.current = 'starting';
                pendingEndRef.current = false;

                const idx = pointIndexRef.current++;
                pendingPointsRef.current = [
                  {
                    x: constrainedDown.x,
                    y: constrainedDown.y,
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
                  },
                ];
                window.__strokeDiagnostics?.onPointBuffered();
                window.__strokeDiagnostics?.onStrokeStart();

                logTabletTrace('frontend.native_pump.stroke_start', {
                  pointer_id: nativePoint.pointer_id,
                  stroke_id: nativePoint.stroke_id,
                  seq: nativePoint.seq,
                  phase: normalized.phase,
                  mapped_canvas_x: constrainedDown.x,
                  mapped_canvas_y: constrainedDown.y,
                  pressure_0_1: normalized.pressure,
                  dom_inactive_ms: domInactiveForMs,
                });

                void (async () => {
                  await captureBeforeImage();
                  await initializeBrushStroke();
                })();
                continue;
              }

              const idx = pointIndexRef.current++;
              const queuedPoint: QueuedPoint = {
                x: mapped.x,
                y: mapped.y,
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

              const state = strokeStateRef.current;
              if (state === 'starting') {
                pendingPointsRef.current.push(queuedPoint);
                window.__strokeDiagnostics?.onPointBuffered();
              } else if (state === 'active' || state === 'finishing') {
                inputQueueRef.current.push(queuedPoint);
                window.__strokeDiagnostics?.onPointBuffered();
              }

              logTabletTrace('frontend.native_pump.consume', {
                pointer_id: nativePoint.pointer_id,
                stroke_id: nativePoint.stroke_id,
                seq: nativePoint.seq,
                phase: normalized.phase,
                mapped_canvas_x: mapped.x,
                mapped_canvas_y: mapped.y,
                pressure_0_1: normalized.pressure,
                stroke_state: strokeStateRef.current,
              });

              if (normalized.phase === 'up') {
                usingRawInput.current = false;
                nativeMissingInputStreakRef.current = 0;
                endPointerSession(nativePoint.pointer_id);
                void requestFinishCurrentStroke();
              }
            }
          }
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [
    currentTool,
    getNowMs,
    canvasRef,
    layers,
    activeLayerId,
    constrainShiftLinePoint,
    lockShiftLine,
    lastInputPosRef,
    beginPointerSession,
    usingRawInput,
    onBeforeCanvasMutation,
    isDrawingRef,
    strokeStateRef,
    pendingEndRef,
    pointIndexRef,
    pendingPointsRef,
    inputQueueRef,
    endPointerSession,
    requestFinishCurrentStroke,
    captureBeforeImage,
    initializeBrushStroke,
    consumeNativeRoutedPoints,
    flushNativePointBuffer,
  ]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      void processPointerDownNative(e.nativeEvent as PointerEvent).catch((error) => {
        // eslint-disable-next-line no-console
        console.error('[Pointer] pointerdown processing failed', error);
      });
    },
    [processPointerDownNative]
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
