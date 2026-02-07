import { useCallback, type RefObject, type MutableRefObject } from 'react';
import { useTabletStore, drainPointBuffer } from '@/stores/tablet';
import { ToolType } from '@/stores/tool';
import { Layer } from '@/stores/document';
import { LatencyProfiler } from '@/benchmark';
import { StrokeBuffer, Point as BufferPoint } from '@/utils/interpolation';
import { LayerRenderer } from '@/utils/layerRenderer';
import { getEffectiveInputData } from './inputUtils';
import { clientToCanvasPoint } from './canvasGeometry';
import type { RawInputPoint } from '@/stores/tablet';

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
  drawPoints: (points: RawInputPoint[]) => void;
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
  updateShiftLineCursor: (x: number, y: number) => void;
  lockShiftLine: (point: { x: number; y: number }) => void;
  constrainShiftLinePoint: (x: number, y: number) => { x: number; y: number };
  usingRawInput: MutableRefObject<boolean>;
  isDrawingRef: MutableRefObject<boolean>;
  strokeBufferRef: MutableRefObject<StrokeBuffer>;
  strokeStateRef: MutableRefObject<string>;
  pendingPointsRef: MutableRefObject<QueuedPoint[]>;
  inputQueueRef: MutableRefObject<QueuedPoint[]>;
  pointIndexRef: MutableRefObject<number>;
  pendingEndRef: MutableRefObject<boolean>;
  lastInputPosRef: MutableRefObject<{ x: number; y: number } | null>;
  latencyProfilerRef: MutableRefObject<LatencyProfiler>;
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
  drawPoints,
  finishCurrentStroke,
  isSelectionToolActive,
  handleSelectionPointerDown,
  handleSelectionPointerMove,
  handleSelectionPointerUp,
  handleMovePointerDown,
  handleMovePointerMove,
  handleMovePointerUp,
  updateShiftLineCursor,
  lockShiftLine,
  constrainShiftLinePoint,
  usingRawInput,
  isDrawingRef,
  strokeBufferRef,
  strokeStateRef,
  pendingPointsRef,
  inputQueueRef,
  pointIndexRef,
  pendingEndRef,
  lastInputPosRef,
  latencyProfilerRef,
}: UsePointerHandlersParams) {
  const trySetPointerCapture = useCallback((target: Element, event: React.PointerEvent) => {
    const native = event.nativeEvent as PointerEvent;
    if (!native.isTrusted) return;
    try {
      (target as Element & { setPointerCapture(pointerId: number): void }).setPointerCapture(
        event.pointerId
      );
    } catch {
      // Ignore invalid pointer capture on platform/browser edge cases.
    }
  }, []);

  const tryReleasePointerCapture = useCallback((target: Element, event: React.PointerEvent) => {
    const native = event.nativeEvent as PointerEvent;
    if (!native.isTrusted) return;
    try {
      (
        target as Element & { releasePointerCapture(pointerId: number): void }
      ).releasePointerCapture(event.pointerId);
    } catch {
      // Ignore invalid pointer release on platform/browser edge cases.
    }
  }, []);

  // Pick color from canvas at given coordinates
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

  // Handle pointer down events
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;

      // Ensure the canvas container receives focus so modifier-key behaviors
      // (e.g. Shift line mode) only activate when the canvas is active.
      if (!container.contains(document.activeElement)) {
        container.focus({ preventScroll: true });
      }

      // Handle Panning (Space key)
      if (spacePressed) {
        setIsPanning(true);
        panStartRef.current = { x: e.clientX, y: e.clientY };
        return;
      }

      // Handle Zoom tool
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
        trySetPointerCapture(container, e);
        return;
      }

      // Prepare input data (pressure/tilt), preferring WinTab buffer if active.
      // Important: For pen, do NOT default pressure to 0.5 at pointerdown,
      // otherwise the first dab can become noticeably too heavy (especially with Build-up enabled).
      const pe = e.nativeEvent as PointerEvent;
      let pressure = 0.5;
      if (pe.pointerType === 'pen') {
        pressure = pe.pressure > 0 ? pe.pressure : 0;
      } else if (pe.pressure > 0) {
        pressure = pe.pressure;
      }
      if (currentTool === 'brush' || currentTool === 'eraser') {
        const tabletState = useTabletStore.getState();
        const isWinTabActive =
          tabletState.isStreaming &&
          typeof tabletState.backend === 'string' &&
          tabletState.backend.toLowerCase() === 'wintab';
        // Synthetic replay events are not trusted; keep captured pressure instead of
        // overriding with live WinTab stream.
        const shouldUseWinTab = isWinTabActive && pe.isTrusted;
        if (shouldUseWinTab) {
          // Use buffered WinTab points when available; avoid using currentPoint at pointerdown
          // because it can be stale (previous stroke), causing an overly heavy first dab.
          const bufferedPoints = drainPointBuffer();
          if (bufferedPoints.length > 0) {
            pressure = bufferedPoints[bufferedPoints.length - 1]!.pressure;
          } else {
            // No fresh WinTab sample yet.
            if (pe.pointerType === 'pen') {
              pressure = 0;
            }
          }
        }
      }

      const canvas = canvasRef.current;
      if (!canvas) return;

      const { x: canvasX, y: canvasY } = pointerEventToCanvasPoint(canvas, e);

      updateShiftLineCursor(canvasX, canvasY);

      // Handle Eyedropper
      if (currentTool === 'eyedropper') {
        void pickColorAt(canvasX, canvasY);
        return;
      }

      // Handle Selection Tools (rect select / lasso)
      if (isSelectionToolActive) {
        const handled = handleSelectionPointerDown(canvasX, canvasY, e.nativeEvent);
        if (handled) {
          trySetPointerCapture(canvas, e);
          return;
        }
      }

      if (currentTool === 'move') {
        const handled = handleMovePointerDown(canvasX, canvasY, e.nativeEvent);
        if (handled) {
          trySetPointerCapture(canvas, e);
          return;
        }
      }

      // Check Layer Validation
      const activeLayer = layers.find((l) => l.id === activeLayerId);
      if (!activeLayerId || !activeLayer?.visible) return;

      let constrainedDown = { x: canvasX, y: canvasY };
      if (currentTool === 'brush' || currentTool === 'eraser') {
        lockShiftLine({ x: canvasX, y: canvasY });
        constrainedDown = constrainShiftLinePoint(canvasX, canvasY);
        lastInputPosRef.current = { x: constrainedDown.x, y: constrainedDown.y };
      }

      // Start Drawing
      trySetPointerCapture(canvas, e);
      usingRawInput.current = false;

      if (currentTool !== 'brush' && currentTool !== 'eraser') {
        return;
      }

      // Brush Tool: Use State Machine Logic
      if (currentTool === 'brush') {
        isDrawingRef.current = true;
        strokeBufferRef.current?.reset();
        const idx = pointIndexRef.current++;
        latencyProfilerRef.current.markInputReceived(idx, e.nativeEvent as PointerEvent);

        strokeStateRef.current = 'starting';
        pendingPointsRef.current = [{ x: canvasX, y: canvasY, pressure, pointIndex: idx }];
        pendingEndRef.current = false;

        // 先抓撤销基线，再初始化 GPU 笔触。
        // 避免 beforeImage 过旧导致一次撤销回退多笔。
        window.__strokeDiagnostics?.onStrokeStart();
        void (async () => {
          await captureBeforeImage();
          await initializeBrushStroke();
        })();
        return;
      }

      // Eraser/Other Tools: Legacy Logic
      isDrawingRef.current = true;
      strokeBufferRef.current?.reset();
      void captureBeforeImage();
      const point: BufferPoint = {
        x: constrainedDown.x,
        y: constrainedDown.y,
        pressure,
        tiltX: e.tiltX ?? 0,
        tiltY: e.tiltY ?? 0,
      };

      const interpolatedPoints = strokeBufferRef.current?.addPoint(point) ?? [];
      if (interpolatedPoints.length > 0) {
        drawPoints(
          interpolatedPoints.map((p) => ({
            ...p,
            tilt_x: p.tiltX ?? 0,
            tilt_y: p.tiltY ?? 0,
            timestamp_ms: 0,
          }))
        );
      }
    },
    [
      spacePressed,
      currentTool,
      scale,
      pickColorAt,
      layers,
      activeLayerId,
      captureBeforeImage,
      initializeBrushStroke,
      drawPoints,
      finishCurrentStroke,
      setIsPanning,
      isSelectionToolActive,
      handleSelectionPointerDown,
      handleMovePointerDown,
      updateShiftLineCursor,
      lockShiftLine,
      constrainShiftLinePoint,
      containerRef,
      canvasRef,
      panStartRef,
      isZoomingRef,
      zoomStartRef,
      isDrawingRef,
      strokeBufferRef,
      strokeStateRef,
      pendingPointsRef,
      pointIndexRef,
      pendingEndRef,
      lastInputPosRef,
      latencyProfilerRef,
      trySetPointerCapture,
      usingRawInput,
    ]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      // 获取所有合并事件（包括被浏览器合并的中间事件）
      // 在 Release 模式下，浏览器会更激进地合并事件，导致采样点不足
      const nativeEvent = e.nativeEvent as PointerEvent;
      const sampledEvents = nativeEvent.getCoalescedEvents?.();
      // Synthetic replay events can report an empty coalesced list.
      const coalescedEvents =
        sampledEvents && sampledEvents.length > 0 ? sampledEvents : [nativeEvent];

      // 平移模式：只使用最后一个事件
      if (isPanning && panStartRef.current) {
        const lastEvent = coalescedEvents[coalescedEvents.length - 1] ?? e.nativeEvent;
        const deltaX = lastEvent.clientX - panStartRef.current.x;
        const deltaY = lastEvent.clientY - panStartRef.current.y;
        pan(deltaX, deltaY);
        panStartRef.current = { x: lastEvent.clientX, y: lastEvent.clientY };
        // Note: cursor position is updated by native event listener
        return;
      }

      // Zoom logic
      if (isZoomingRef.current && zoomStartRef.current) {
        const lastEvent = coalescedEvents[coalescedEvents.length - 1] ?? e.nativeEvent;
        const deltaX = lastEvent.clientX - zoomStartRef.current.x;

        // Scrubby zoom: 100px drag doubles/halves scale
        const zoomFactor = 1 + deltaX * 0.01;
        const newScale = zoomStartRef.current.startScale * zoomFactor;

        // Retrieve container rect to convert initial mouse to container coords
        // Zoom anchored to the initial click position
        const container = containerRef.current;
        if (container) {
          const rect = container.getBoundingClientRect();
          const initialClickX = zoomStartRef.current.x - rect.left;
          const initialClickY = zoomStartRef.current.y - rect.top;
          setScale(newScale, initialClickX, initialClickY);
        }

        return;
      }

      // Selection tool move handling
      if (isSelectionToolActive) {
        const lastEvent = coalescedEvents[coalescedEvents.length - 1] ?? e.nativeEvent;
        const canvas = canvasRef.current;
        if (canvas) {
          const { x: canvasX, y: canvasY } = pointerEventToCanvasPoint(canvas, lastEvent);
          handleSelectionPointerMove(canvasX, canvasY, lastEvent);
        }
        return;
      }

      if (currentTool === 'move') {
        const lastEvent = coalescedEvents[coalescedEvents.length - 1] ?? e.nativeEvent;
        const canvas = canvasRef.current;
        if (canvas) {
          const { x: canvasX, y: canvasY } = pointerEventToCanvasPoint(canvas, lastEvent);
          if (handleMovePointerMove(canvasX, canvasY, lastEvent)) {
            return;
          }
        }
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const lastEvent = coalescedEvents[coalescedEvents.length - 1] ?? e.nativeEvent;
      const mappedHoverPoint = pointerEventToCanvasPoint(canvas, lastEvent, rect);
      updateShiftLineCursor(mappedHoverPoint.x, mappedHoverPoint.y);

      // Note: cursor position is updated by native event listener for zero-lag

      // 绘画模式
      if (!isDrawingRef.current) return;

      if (currentTool !== 'brush' && currentTool !== 'eraser') return;

      // Q1 Optimization: Skip brush input if pointerrawupdate is handling it
      // pointerrawupdate provides lower-latency input (1-3ms improvement)
      if (currentTool === 'brush' && usingRawInput.current) {
        return;
      }

      const tabletState = useTabletStore.getState();
      const isWinTabActive =
        tabletState.isStreaming &&
        typeof tabletState.backend === 'string' &&
        tabletState.backend.toLowerCase() === 'wintab';
      // Replay events should consume recorded pressure/tilt and must not be polluted
      // by current tablet stream state.
      const shouldUseWinTab = isWinTabActive && (e.nativeEvent as PointerEvent).isTrusted;
      // Drain input buffer once per frame/event-batch (outside the loop)
      const bufferedPoints = shouldUseWinTab ? drainPointBuffer() : [];

      // 遍历所有合并事件，恢复完整输入轨迹
      for (const evt of coalescedEvents) {
        // 始终使用 PointerEvent 的坐标（它们是准确的屏幕坐标）
        const { x: canvasX, y: canvasY } = pointerEventToCanvasPoint(canvas, evt, rect);

        // Resolve input pressure/tilt (handling WinTab buffering if active)
        const { pressure, tiltX, tiltY } = getEffectiveInputData(
          evt,
          shouldUseWinTab,
          bufferedPoints,
          tabletState.currentPoint
        );

        const idx = pointIndexRef.current++;
        // Note: evt is PointerEvent here
        latencyProfilerRef.current.markInputReceived(idx, evt as PointerEvent);

        // For brush tool, use state machine + input buffering
        if (currentTool === 'brush') {
          const state = strokeStateRef.current;
          if (state === 'starting') {
            // Buffer points during 'starting' phase, replay after beginStroke completes
            pendingPointsRef.current.push({ x: canvasX, y: canvasY, pressure, pointIndex: idx });
            window.__strokeDiagnostics?.onPointBuffered(); // Telemetry: Buffered point
          } else if (state === 'active') {
            inputQueueRef.current.push({ x: canvasX, y: canvasY, pressure, pointIndex: idx });
            window.__strokeDiagnostics?.onPointBuffered();
          }
          // Ignore in 'idle' or 'finishing' state
          continue;
        }

        // For eraser, use the legacy stroke buffer
        const constrained = constrainShiftLinePoint(canvasX, canvasY);
        lastInputPosRef.current = { x: constrained.x, y: constrained.y };
        const point: BufferPoint = {
          x: constrained.x,
          y: constrained.y,
          pressure,
          tiltX,
          tiltY,
        };

        const interpolatedPoints = strokeBufferRef.current?.addPoint(point) ?? [];
        if (interpolatedPoints.length > 0) {
          drawPoints(
            interpolatedPoints.map((p) => ({
              ...p,
              tilt_x: p.tiltX ?? 0,
              tilt_y: p.tiltY ?? 0,
              timestamp_ms: 0,
            }))
          );
        }
      }
    },
    [
      isPanning,
      pan,
      drawPoints,
      setScale,
      currentTool,
      usingRawInput,
      isSelectionToolActive,
      handleSelectionPointerMove,
      handleMovePointerMove,
      updateShiftLineCursor,
      constrainShiftLinePoint,
      containerRef,
      canvasRef,
      panStartRef,
      isZoomingRef,
      zoomStartRef,
      isDrawingRef,
      strokeBufferRef,
      strokeStateRef,
      pendingPointsRef,
      inputQueueRef,
      pointIndexRef,
      lastInputPosRef,
      latencyProfilerRef,
    ]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      // 结束平移
      if (isPanning) {
        setIsPanning(false);
        panStartRef.current = null;
        return;
      }

      // Finish zooming
      if (isZoomingRef.current) {
        isZoomingRef.current = false;
        zoomStartRef.current = null;
        const container = containerRef.current;
        if (container) {
          tryReleasePointerCapture(container, e);
        }
        return;
      }

      // Finish selection
      if (isSelectionToolActive) {
        const canvas = canvasRef.current;
        if (canvas) {
          const { x: canvasX, y: canvasY } = pointerEventToCanvasPoint(canvas, e);
          handleSelectionPointerUp(canvasX, canvasY);
          tryReleasePointerCapture(canvas, e);
        }
        return;
      }

      if (currentTool === 'move') {
        const canvas = canvasRef.current;
        if (canvas) {
          const { x: canvasX, y: canvasY } = pointerEventToCanvasPoint(canvas, e);
          handleMovePointerUp(canvasX, canvasY, e.nativeEvent);
          tryReleasePointerCapture(canvas, e);
        }
        return;
      }

      // 结束绘画
      const canvas = canvasRef.current;
      if (canvas) {
        tryReleasePointerCapture(canvas, e);
      }
      usingRawInput.current = false;

      // 完成当前笔触
      void finishCurrentStroke();
    },
    [
      isPanning,
      setIsPanning,
      finishCurrentStroke,
      isSelectionToolActive,
      handleSelectionPointerUp,
      currentTool,
      handleMovePointerUp,
      containerRef,
      canvasRef,
      panStartRef,
      isZoomingRef,
      zoomStartRef,
      tryReleasePointerCapture,
      usingRawInput,
    ]
  );

  return { handlePointerDown, handlePointerMove, handlePointerUp };
}
