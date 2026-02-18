import { useCallback, useEffect, useRef, type RefObject, type MutableRefObject } from 'react';
import { readPointBufferSince, useTabletStore, type TabletInputPoint } from '@/stores/tablet';
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
  phase: 'down' | 'move' | 'up' | 'hover';
  hostTimeUs: number;
  deviceTimeUs: number;
  pointIndex: number;
}

type QueuedPointPhase = QueuedPoint['phase'];
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

function normalizeQueuedPhase(phase: unknown): QueuedPointPhase {
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

function toNonReleasePointerEvent(event: PointerEvent): PointerEvent {
  return {
    ...event,
    type: 'pointermove',
  } as PointerEvent;
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
  nativePoint: { x: number; y: number },
  rect: DOMRect,
  mapping: NativePointMapping
): { x: number; y: number } {
  const client_x = nativePoint.x * mapping.native_to_client_scale_x + mapping.client_offset_x;
  const client_y = nativePoint.y * mapping.native_to_client_scale_y + mapping.client_offset_y;
  return clientToCanvasPoint(canvas, client_x, client_y, rect);
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
  const strokeNativeMappingRef = useRef<NativePointMapping | null>(null);
  const strokeGeometrySourceRef = useRef<StrokeGeometrySource>('unset');
  const lastNativeMappedCanvasPointRef = useRef<{ x: number; y: number } | null>(null);

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
      strokeNativeMappingRef.current = null;
      strokeGeometrySourceRef.current = 'unset';
      lastNativeMappedCanvasPointRef.current = null;
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
      strokeNativeMappingRef.current = null;
      strokeGeometrySourceRef.current = 'unset';
      lastNativeMappedCanvasPointRef.current = null;
    },
    [clearActivePointerId, tryReleasePointerCapture]
  );

  const resolveStrokeNativeMapping = useCallback(
    (
      canvas: HTMLCanvasElement,
      rect: DOMRect,
      anchorEvent: Pick<PointerEvent, 'clientX' | 'clientY'>,
      anchorNativePoint: { x: number; y: number } | null
    ): NativePointMapping => {
      const existing = strokeNativeMappingRef.current;
      if (existing) {
        return existing;
      }
      const computed = resolveNativePointMapping(canvas, rect, anchorEvent, anchorNativePoint);
      strokeNativeMappingRef.current = computed;
      return computed;
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

      const tabletState = useTabletStore.getState();
      const isNativeBackendActive = isNativeTabletStreamingState(tabletState);
      const shouldUseNativeBackend = isNativeBackendActive && nativeEvent.isTrusted;
      const { points: bufferedPointsRaw, nextSeq } = shouldUseNativeBackend
        ? readPointBufferSince(nativeSeqCursorRef.current)
        : { points: [], nextSeq: nativeSeqCursorRef.current };
      if (shouldUseNativeBackend) {
        nativeSeqCursorRef.current = nextSeq;
      }
      const bufferedPoints = shouldUseNativeBackend
        ? selectRecentNativeStrokePoints(bufferedPointsRaw)
        : bufferedPointsRaw;
      const preferNativeGeometry = strokeGeometrySourceRef.current === 'native';

      if (preferNativeGeometry && shouldUseNativeBackend && bufferedPoints.length > 0) {
        const anchorNativePoint = bufferedPoints[bufferedPoints.length - 1] ?? null;
        const nativeMapping = resolveStrokeNativeMapping(
          canvas,
          rect,
          lastEvent,
          anchorNativePoint
        );
        const inputEvent = toNonReleasePointerEvent(nativeEvent);

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
          lastNativeMappedCanvasPointRef.current = { x: canvasX, y: canvasY };
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
            inputEvent,
            true,
            bufferedPoints,
            tabletState.currentPoint,
            nativeEvent,
            nativePoint
          );

          const idx = pointIndexRef.current++;
          latencyProfilerRef.current.markInputReceived(idx, nativeEvent);

          const queuedPhase: QueuedPointPhase = nativePhase === 'down' ? 'down' : 'move';
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
              phase: queuedPhase,
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
              phase: queuedPhase,
              hostTimeUs,
              deviceTimeUs,
              pointIndex: idx,
            });
            window.__strokeDiagnostics?.onPointBuffered();
          }
        }
        return;
      }
      if (preferNativeGeometry) {
        return;
      }

      for (const evt of coalescedEvents) {
        const { x: canvasX, y: canvasY } = pointerEventToCanvasPoint(canvas, evt, rect);
        const { pressure, tiltX, tiltY, rotation, timestampMs, source, hostTimeUs, deviceTimeUs } =
          getEffectiveInputData(
            evt,
            false,
            bufferedPoints,
            tabletState.currentPoint,
            nativeEvent,
            null
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
            phase: 'move',
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
            phase: 'move',
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
      resolveStrokeNativeMapping,
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

      if (isStrokeTool(currentTool) && isDrawingRef.current) {
        const canvas = canvasRef.current;
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const tabletState = useTabletStore.getState();
          const isNativeBackendActive = isNativeTabletStreamingState(tabletState);
          const shouldUseNativeBackend = isNativeBackendActive && nativeEvent.isTrusted;
          const preferNativeGeometry = strokeGeometrySourceRef.current === 'native';
          const { points: bufferedPointsRaw, nextSeq } = shouldUseNativeBackend
            ? readPointBufferSince(nativeSeqCursorRef.current)
            : { points: [], nextSeq: nativeSeqCursorRef.current };
          if (shouldUseNativeBackend) {
            nativeSeqCursorRef.current = nextSeq;
          }
          const bufferedPoints = shouldUseNativeBackend
            ? selectRecentNativeStrokePoints(bufferedPointsRaw)
            : bufferedPointsRaw;
          const queuedTailPoints: QueuedPoint[] = [];

          if (preferNativeGeometry && shouldUseNativeBackend && bufferedPoints.length > 0) {
            const anchorNativePoint = bufferedPoints[bufferedPoints.length - 1] ?? null;
            const nativeMapping = resolveStrokeNativeMapping(
              canvas,
              rect,
              nativeEvent,
              anchorNativePoint
            );
            const moveEvent = toNonReleasePointerEvent(nativeEvent);

            for (const nativePoint of bufferedPoints) {
              const nativePhase = normalizeQueuedPhase((nativePoint as { phase?: unknown }).phase);
              if (nativePhase === 'hover') {
                continue;
              }
              const inputEvent = nativePhase === 'up' ? nativeEvent : moveEvent;
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
                inputEvent,
                true,
                bufferedPoints,
                tabletState.currentPoint,
                nativeEvent,
                nativePoint
              );
              const { x: canvasX, y: canvasY } = nativePointToCanvasPoint(
                canvas,
                nativePoint,
                rect,
                nativeMapping
              );
              lastNativeMappedCanvasPointRef.current = { x: canvasX, y: canvasY };
              const phase: QueuedPointPhase =
                nativePhase === 'up' ? 'up' : nativePhase === 'down' ? 'down' : 'move';
              const idx = pointIndexRef.current++;
              latencyProfilerRef.current.markInputReceived(idx, nativeEvent);
              queuedTailPoints.push({
                x: canvasX,
                y: canvasY,
                pressure,
                tiltX,
                tiltY,
                rotation,
                timestampMs,
                source,
                phase,
                hostTimeUs,
                deviceTimeUs,
                pointIndex: idx,
              });
            }
          }

          const hasUpPoint = queuedTailPoints.some((point) => point.phase === 'up');
          if (!hasUpPoint) {
            const nativePoint = bufferedPoints[bufferedPoints.length - 1] ?? null;
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
              nativeEvent,
              preferNativeGeometry && shouldUseNativeBackend,
              bufferedPoints,
              tabletState.currentPoint,
              nativeEvent,
              nativePoint
            );
            const lastQueuedPoint = queuedTailPoints[queuedTailPoints.length - 1] ?? null;
            const fallbackCanvasPoint = (() => {
              if (lastQueuedPoint) {
                return { x: lastQueuedPoint.x, y: lastQueuedPoint.y };
              }
              if (preferNativeGeometry) {
                if (lastNativeMappedCanvasPointRef.current) {
                  return {
                    x: lastNativeMappedCanvasPointRef.current.x,
                    y: lastNativeMappedCanvasPointRef.current.y,
                  };
                }
                if (lastInputPosRef.current) {
                  return { x: lastInputPosRef.current.x, y: lastInputPosRef.current.y };
                }
              }
              if (shouldUseNativeBackend && nativePoint) {
                const nativeMapping = resolveStrokeNativeMapping(
                  canvas,
                  rect,
                  nativeEvent,
                  nativePoint
                );
                return nativePointToCanvasPoint(canvas, nativePoint, rect, nativeMapping);
              }
              return pointerEventToCanvasPoint(canvas, nativeEvent, rect);
            })();
            const idx = pointIndexRef.current++;
            latencyProfilerRef.current.markInputReceived(idx, nativeEvent);
            queuedTailPoints.push({
              x: fallbackCanvasPoint.x,
              y: fallbackCanvasPoint.y,
              pressure,
              tiltX,
              tiltY,
              rotation,
              timestampMs,
              source,
              phase: 'up',
              hostTimeUs,
              deviceTimeUs,
              pointIndex: idx,
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
      isDrawingRef,
      strokeStateRef,
      pendingPointsRef,
      inputQueueRef,
      pointIndexRef,
      latencyProfilerRef,
      resolveStrokeNativeMapping,
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
      let shouldUseNativeStrokeBuffer = false;
      let nativeBufferedPointsForStroke: TabletInputPoint[] = [];
      if (pe.pointerType === 'pen') {
        pressure = pe.pressure > 0 ? pe.pressure : 0;
      } else if (pe.pressure > 0) {
        pressure = pe.pressure;
      }
      if (isStrokeTool(currentTool)) {
        const tabletState = useTabletStore.getState();
        const isNativeBackendActive = isNativeTabletStreamingState(tabletState);
        const shouldUseNativeBackend = isNativeBackendActive && pe.isTrusted;
        const { points: bufferedPointsRaw, nextSeq } = shouldUseNativeBackend
          ? readPointBufferSince(nativeSeqCursorRef.current)
          : { points: [], nextSeq: nativeSeqCursorRef.current };
        if (shouldUseNativeBackend) {
          nativeSeqCursorRef.current = nextSeq;
        }
        const bufferedPoints = shouldUseNativeBackend
          ? selectRecentNativeStrokePoints(bufferedPointsRaw)
          : bufferedPointsRaw;
        shouldUseNativeStrokeBuffer = shouldUseNativeBackend;
        nativeBufferedPointsForStroke = bufferedPoints;
        const preferredStartPoint =
          bufferedPoints.find(
            (point) => normalizeQueuedPhase((point as { phase?: unknown }).phase) !== 'hover'
          ) ??
          bufferedPoints[bufferedPoints.length - 1] ??
          null;
        const effectiveInput = getEffectiveInputData(
          pe,
          shouldUseNativeBackend,
          bufferedPoints,
          tabletState.currentPoint,
          pe,
          preferredStartPoint
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
      strokeGeometrySourceRef.current = shouldUseNativeStrokeBuffer ? 'native' : 'pointer';

      onBeforeCanvasMutation?.();

      isDrawingRef.current = true;
      let strokeSeedPoints: Array<Omit<QueuedPoint, 'pointIndex'>> = [
        {
          x: constrainedDown.x,
          y: constrainedDown.y,
          pressure,
          tiltX,
          tiltY,
          rotation,
          timestampMs,
          source,
          phase: 'down',
          hostTimeUs,
          deviceTimeUs,
        },
      ];

      if (shouldUseNativeStrokeBuffer && nativeBufferedPointsForStroke.length > 0) {
        const rect = canvas.getBoundingClientRect();
        const anchorNativePoint =
          nativeBufferedPointsForStroke[nativeBufferedPointsForStroke.length - 1] ?? null;
        const nativeMapping = resolveStrokeNativeMapping(canvas, rect, pe, anchorNativePoint);
        const moveEvent = toNonReleasePointerEvent(pe);
        const nativeSeedPoints: Array<Omit<QueuedPoint, 'pointIndex'>> = [];
        for (const nativePoint of nativeBufferedPointsForStroke) {
          const nativePhase = normalizeQueuedPhase((nativePoint as { phase?: unknown }).phase);
          if (nativePhase === 'hover' || nativePhase === 'up') {
            continue;
          }
          const inputEvent = nativePhase === 'down' ? pe : moveEvent;
          const {
            pressure: nativePressure,
            tiltX: nativeTiltX,
            tiltY: nativeTiltY,
            rotation: nativeRotation,
            timestampMs: nativeTimestampMs,
            source: nativeSource,
            hostTimeUs: nativeHostTimeUs,
            deviceTimeUs: nativeDeviceTimeUs,
          } = getEffectiveInputData(
            inputEvent,
            true,
            nativeBufferedPointsForStroke,
            useTabletStore.getState().currentPoint,
            pe,
            nativePoint
          );
          const mapped = nativePointToCanvasPoint(canvas, nativePoint, rect, nativeMapping);
          const constrained = constrainShiftLinePoint(mapped.x, mapped.y);
          nativeSeedPoints.push({
            x: constrained.x,
            y: constrained.y,
            pressure: nativePressure,
            tiltX: nativeTiltX,
            tiltY: nativeTiltY,
            rotation: nativeRotation,
            timestampMs: nativeTimestampMs,
            source: nativeSource,
            phase: nativePhase === 'down' ? 'down' : 'move',
            hostTimeUs: nativeHostTimeUs,
            deviceTimeUs: nativeDeviceTimeUs,
          });
        }
        if (nativeSeedPoints.length > 0) {
          if (nativeSeedPoints[0]!.phase !== 'down') {
            nativeSeedPoints[0] = { ...nativeSeedPoints[0]!, phase: 'down' };
          }
          strokeSeedPoints = nativeSeedPoints;
          const tail = nativeSeedPoints[nativeSeedPoints.length - 1]!;
          lastInputPosRef.current = { x: tail.x, y: tail.y };
          lastNativeMappedCanvasPointRef.current = { x: tail.x, y: tail.y };
        }
      } else if (strokeGeometrySourceRef.current === 'native') {
        lastNativeMappedCanvasPointRef.current = { x: constrainedDown.x, y: constrainedDown.y };
      }

      strokeStateRef.current = 'starting';
      pendingPointsRef.current = strokeSeedPoints.map((point, index) => {
        const idx = pointIndexRef.current++;
        latencyProfilerRef.current.markInputReceived(idx, pe);
        return {
          ...point,
          phase: index === 0 ? 'down' : point.phase,
          pointIndex: idx,
        };
      });
      pendingEndRef.current = false;
      for (let i = 0; i < pendingPointsRef.current.length; i += 1) {
        window.__strokeDiagnostics?.onPointBuffered();
      }

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
      resolveStrokeNativeMapping,
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
