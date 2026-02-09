import { useCallback, useEffect, useRef, type RefObject, type MutableRefObject } from 'react';
import { applyPressureCurve, PressureCurve, ToolType } from '@/stores/tool';
import { clearPointBuffer, useTabletStore, type RawInputPoint } from '@/stores/tablet';
import { useDocumentStore } from '@/stores/document';
import { LatencyProfiler, LagometerMonitor, FPSCounter } from '@/benchmark';
import { BrushRenderConfig } from './useBrushRenderer';
import { LayerRenderer } from '@/utils/layerRenderer';
import { StrokeBuffer } from '@/utils/interpolation';
import type { GpuStrokeCommitResult, RenderBackend } from '@/gpu';

const MAX_POINTS_PER_FRAME = 80;
// Photoshop Build-up (Airbrush) rate tuning:
// Use a timer-driven stamp rate so buildup works for both mouse + tablet stationary holds.
// 5Hz (~200ms) is closer to PS feel than 60Hz (which accumulates too fast).
const TARGET_BUILDUP_DABS_PER_SEC = 5;
const BUILDUP_INTERVAL_MS = 1000 / TARGET_BUILDUP_DABS_PER_SEC;
const MAX_BUILDUP_DABS_PER_FRAME = 1;

interface QueuedPoint {
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  rotation: number;
  pointIndex: number;
}

interface DebugRect {
  rect: { left: number; top: number; right: number; bottom: number };
  label: string;
  color: string;
}

function isBrushStrokeState(state: string): boolean {
  return state === 'active' || state === 'finishing';
}

interface UseStrokeProcessorParams {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  layerRendererRef: RefObject<LayerRenderer | null>;
  width: number;
  height: number;
  scale: number;
  activeLayerId: string | null;
  currentTool: ToolType;
  currentSize: number;
  brushColor: string;
  brushOpacity: number;
  pressureCurve: PressureCurve;
  brushHardness: number;
  wetEdge: number;
  wetEdgeEnabled: boolean;
  brushBackend: RenderBackend;
  useGpuDisplay: boolean;
  renderGpuFrame: (showScratch: boolean) => void;
  commitStrokeGpu?: () => Promise<GpuStrokeCommitResult>;
  getBrushConfig: () => BrushRenderConfig;
  getShiftLineGuide: () => {
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null;
  constrainShiftLinePoint: (x: number, y: number) => { x: number; y: number };
  onShiftLineStrokeEnd: (lastDabPos?: { x: number; y: number } | null) => void;
  isDrawingRef: MutableRefObject<boolean>;
  strokeBufferRef: MutableRefObject<StrokeBuffer>;
  strokeStateRef: MutableRefObject<string>;
  pendingPointsRef: MutableRefObject<QueuedPoint[]>;
  inputQueueRef: MutableRefObject<QueuedPoint[]>;
  lastRenderedPosRef: MutableRefObject<{ x: number; y: number } | null>;
  lastInputPosRef: MutableRefObject<{ x: number; y: number } | null>;
  needsRenderRef: MutableRefObject<boolean>;
  pendingEndRef: MutableRefObject<boolean>;
  lagometerRef: MutableRefObject<LagometerMonitor>;
  fpsCounterRef: MutableRefObject<FPSCounter>;
  latencyProfilerRef: MutableRefObject<LatencyProfiler>;
  beginBrushStroke: (hardness: number, wetEdge: number) => Promise<void>;
  processBrushPoint: (
    x: number,
    y: number,
    pressure: number,
    config: BrushRenderConfig,
    pointIndex?: number,
    dynamics?: { tiltX?: number; tiltY?: number; rotation?: number }
  ) => void;
  endBrushStroke: (ctx: CanvasRenderingContext2D) => Promise<void>;
  getPreviewCanvas: () => HTMLCanvasElement | null;
  getPreviewOpacity: () => number;
  isStrokeActive: () => boolean;
  getLastDabPosition: () => { x: number; y: number } | null;
  getDebugRects: () => DebugRect[] | null;
  flushPending: () => void;
  compositeAndRender: () => void;
  saveStrokeToHistory: () => void;
  updateThumbnail: (layerId: string) => void;
}

function drawDebugRects(
  ctx: CanvasRenderingContext2D,
  rects: Array<{
    rect: { left: number; top: number; right: number; bottom: number };
    label: string;
    color: string;
  }>
): void {
  if (rects.length === 0) return;

  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 2]);
  ctx.font = '12px monospace';
  ctx.textBaseline = 'top';

  const canvasWidth = ctx.canvas.width;
  const canvasHeight = ctx.canvas.height;

  for (const { rect, label, color } of rects) {
    const left = Math.max(0, Math.floor(rect.left));
    const top = Math.max(0, Math.floor(rect.top));
    const right = Math.min(canvasWidth, Math.ceil(rect.right));
    const bottom = Math.min(canvasHeight, Math.ceil(rect.bottom));
    const width = right - left;
    const height = bottom - top;

    if (width <= 0 || height <= 0) continue;

    ctx.strokeStyle = color;
    ctx.strokeRect(left + 0.5, top + 0.5, width, height);
    ctx.fillStyle = color;
    ctx.fillText(label, left + 2, top + 2);
  }

  ctx.restore();
}

export function useStrokeProcessor({
  canvasRef,
  layerRendererRef,
  width,
  height,
  scale,
  activeLayerId,
  currentTool,
  currentSize,
  brushColor,
  brushOpacity,
  pressureCurve,
  brushHardness,
  wetEdge,
  wetEdgeEnabled,
  brushBackend,
  useGpuDisplay,
  renderGpuFrame,
  commitStrokeGpu,
  getBrushConfig,
  getShiftLineGuide,
  constrainShiftLinePoint,
  onShiftLineStrokeEnd,
  isDrawingRef,
  strokeBufferRef,
  strokeStateRef,
  pendingPointsRef,
  inputQueueRef,
  lastRenderedPosRef,
  lastInputPosRef,
  needsRenderRef,
  pendingEndRef,
  lagometerRef,
  fpsCounterRef,
  latencyProfilerRef,
  beginBrushStroke,
  processBrushPoint,
  endBrushStroke,
  getPreviewCanvas,
  getPreviewOpacity,
  isStrokeActive,
  getLastDabPosition,
  getDebugRects,
  flushPending,
  compositeAndRender,
  saveStrokeToHistory,
  updateThumbnail,
}: UseStrokeProcessorParams) {
  // Get the active layer's context for drawing
  const getActiveLayerCtx = useCallback(() => {
    if (!layerRendererRef.current || !activeLayerId) return null;
    const layer = layerRendererRef.current.getLayer(activeLayerId);
    return layer?.ctx ?? null;
  }, [activeLayerId, layerRendererRef]);

  const lastPressureRef = useRef(0);
  const lastDynamicsRef = useRef<{ tiltX: number; tiltY: number; rotation: number }>({
    tiltX: 0,
    tiltY: 0,
    rotation: 0,
  });
  const buildupAccMsRef = useRef(0);
  const rafPrevTimeRef = useRef<number | null>(null);

  // Check if active layer is a background layer
  const isActiveLayerBackground = useCallback(() => {
    if (!layerRendererRef.current || !activeLayerId) return false;
    const layer = layerRendererRef.current.getLayer(activeLayerId);
    return layer?.isBackground ?? false;
  }, [activeLayerId, layerRendererRef]);

  // Composite with stroke buffer preview overlay at correct layer position
  const renderGuideLine = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      const guideLine = getShiftLineGuide();
      if (!guideLine) return;

      const guideLineOpacity = isDrawingRef.current ? 0.1 : 1;
      const outerWidth = 3 / scale;
      const innerWidth = 1 / scale;

      ctx.save();
      ctx.globalAlpha = guideLineOpacity;

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = outerWidth;
      ctx.beginPath();
      ctx.moveTo(guideLine.start.x, guideLine.start.y);
      ctx.lineTo(guideLine.end.x, guideLine.end.y);
      ctx.stroke();

      ctx.strokeStyle = '#000000';
      ctx.lineWidth = innerWidth;
      ctx.beginPath();
      ctx.moveTo(guideLine.start.x, guideLine.start.y);
      ctx.lineTo(guideLine.end.x, guideLine.end.y);
      ctx.stroke();

      ctx.restore();
    },
    [getShiftLineGuide, scale, isDrawingRef]
  );

  const compositeAndRenderWithPreview = useCallback(() => {
    if (useGpuDisplay) {
      renderGpuFrame(isStrokeActive());

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;

      ctx.clearRect(0, 0, width, height);

      if (window.__gpuBrushDebugRects) {
        const rects = getDebugRects();
        if (rects && rects.length > 0) {
          drawDebugRects(ctx, rects);
        }
      }

      renderGuideLine(ctx);
      return;
    }
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const renderer = layerRendererRef.current;

    if (!canvas || !ctx || !renderer) return;

    // Build preview config if stroke is active
    const preview =
      isStrokeActive() && activeLayerId
        ? (() => {
            const previewCanvas = getPreviewCanvas();
            return previewCanvas
              ? { activeLayerId, canvas: previewCanvas, opacity: getPreviewOpacity() }
              : undefined;
          })()
        : undefined;

    // Composite with optional preview
    const compositeCanvas = renderer.composite(preview);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(compositeCanvas, 0, 0);

    if (window.__gpuBrushDebugRects) {
      const rects = getDebugRects();
      if (rects && rects.length > 0) {
        drawDebugRects(ctx, rects);
      }
    }

    renderGuideLine(ctx);
  }, [
    useGpuDisplay,
    renderGpuFrame,
    width,
    height,
    isStrokeActive,
    getPreviewCanvas,
    getPreviewOpacity,
    getDebugRects,
    activeLayerId,
    renderGuideLine,
    canvasRef,
    layerRendererRef,
  ]);

  // Process a single point through the brush renderer WITHOUT triggering composite
  // Used by batch processing loop in RAF
  const processSinglePoint = useCallback(
    (
      x: number,
      y: number,
      pressure: number,
      pointIndex?: number,
      dynamics?: { tiltX?: number; tiltY?: number; rotation?: number }
    ) => {
      const constrained = constrainShiftLinePoint(x, y);
      const config = getBrushConfig();
      lagometerRef.current.setBrushRadius(config.size / 2);

      const pointDynamics = {
        tiltX: dynamics?.tiltX ?? 0,
        tiltY: dynamics?.tiltY ?? 0,
        rotation: dynamics?.rotation ?? 0,
      };
      processBrushPoint(constrained.x, constrained.y, pressure, config, pointIndex, pointDynamics);

      // Track last rendered position for Visual Lag measurement
      lastRenderedPosRef.current = { x: constrained.x, y: constrained.y };
      lastInputPosRef.current = { x: constrained.x, y: constrained.y };
      lastPressureRef.current = pressure;
      lastDynamicsRef.current = pointDynamics;
    },
    [
      getBrushConfig,
      processBrushPoint,
      constrainShiftLinePoint,
      lagometerRef,
      lastRenderedPosRef,
      lastInputPosRef,
    ]
  );

  // Process a single point AND trigger composite (legacy behavior, used during state machine replay)
  const processBrushPointWithConfig = useCallback(
    (
      x: number,
      y: number,
      pressure: number,
      pointIndex?: number,
      dynamics?: { tiltX?: number; tiltY?: number; rotation?: number }
    ) => {
      processSinglePoint(x, y, pressure, pointIndex, dynamics);
      // Mark that we need to render after processing
      needsRenderRef.current = true;
    },
    [processSinglePoint, needsRenderRef]
  );

  // RAF loop: Batch process queued points and composite once per frame
  useEffect(() => {
    latencyProfilerRef.current.enable();
    const fpsCounter = fpsCounterRef.current;
    fpsCounter.start();

    buildupAccMsRef.current = 0;
    rafPrevTimeRef.current = null;

    let id: number;
    const loop = (time: number) => {
      fpsCounter.tick();

      const prev = rafPrevTimeRef.current;
      const dtMs = prev === null ? 0 : time - prev;
      rafPrevTimeRef.current = time;

      let processedAnyPoints = false;

      // Batch process all queued points (with soft limit)
      const queue = inputQueueRef.current;
      if (queue.length > 0) {
        const canConsumeQueue = strokeStateRef.current === 'active';
        if (!canConsumeQueue) {
          // Drop stale points captured around stroke end to prevent late tail dabs.
          inputQueueRef.current = [];
        } else {
          processedAnyPoints = true;
          // Visual Lag: measure distance from last queued point (newest input)
          // to last rendered point (before this batch)
          const lastQueuedPoint = queue[queue.length - 1]!;
          const renderedPosBefore = lastRenderedPosRef.current;
          if (renderedPosBefore) {
            lagometerRef.current.measure(renderedPosBefore, lastQueuedPoint);
          }

          const count = Math.min(queue.length, MAX_POINTS_PER_FRAME);

          // Drain and process points
          for (let i = 0; i < count; i++) {
            const p = queue[i]!;
            processSinglePoint(p.x, p.y, p.pressure, p.pointIndex, {
              tiltX: p.tiltX,
              tiltY: p.tiltY,
              rotation: p.rotation,
            });
          }

          // Clear processed points from queue
          inputQueueRef.current = count === queue.length ? [] : queue.slice(count);

          flushPending();

          needsRenderRef.current = true;
        }
      }

      // Build-up tick: stationary hold behavior (CPU/GPU)
      const canBuildupTick =
        currentTool === 'brush' && isDrawingRef.current && strokeStateRef.current === 'active';

      if (canBuildupTick) {
        const config = getBrushConfig();
        if (config.buildupEnabled && !processedAnyPoints) {
          buildupAccMsRef.current += dtMs;

          let steps = 0;
          while (
            buildupAccMsRef.current >= BUILDUP_INTERVAL_MS &&
            steps < MAX_BUILDUP_DABS_PER_FRAME
          ) {
            buildupAccMsRef.current -= BUILDUP_INTERVAL_MS;

            const pos = lastInputPosRef.current ?? lastRenderedPosRef.current;
            if (!pos) break;

            let pressure = lastPressureRef.current;
            const tabletState = useTabletStore.getState();
            const isWinTabActive =
              tabletState.isStreaming &&
              typeof tabletState.backend === 'string' &&
              tabletState.backend.toLowerCase() === 'wintab';
            if (isWinTabActive) {
              const pt = tabletState.currentPoint;
              if (pt) {
                pressure = pt.pressure;
              }
            }

            processBrushPointWithConfig(pos.x, pos.y, pressure, undefined, lastDynamicsRef.current);
            steps++;
          }

          if (steps > 0) {
            flushPending();
            needsRenderRef.current = true;
          }
        } else {
          buildupAccMsRef.current = 0;
        }
      } else {
        buildupAccMsRef.current = 0;
      }

      // Composite once per frame if needed
      if (needsRenderRef.current) {
        compositeAndRenderWithPreview();
        needsRenderRef.current = false;
      }

      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);

    return () => {
      fpsCounter.stop();
      cancelAnimationFrame(id);
      buildupAccMsRef.current = 0;
      rafPrevTimeRef.current = null;
    };
  }, [
    compositeAndRenderWithPreview,
    processSinglePoint,
    processBrushPointWithConfig,
    flushPending,
    inputQueueRef,
    lastRenderedPosRef,
    lastInputPosRef,
    brushBackend,
    currentTool,
    getBrushConfig,
    lagometerRef,
    needsRenderRef,
    fpsCounterRef,
    latencyProfilerRef,
    isDrawingRef,
    strokeStateRef,
  ]);

  // 绘制插值后的点序列 (used for eraser, legacy fallback)
  const drawPoints = useCallback(
    (points: RawInputPoint[]) => {
      const ctx = getActiveLayerCtx();
      if (!ctx || points.length < 2) return;

      const isEraser = currentTool === 'eraser';
      const isBackground = isActiveLayerBackground();

      for (let i = 1; i < points.length; i++) {
        const from = points[i - 1];
        const to = points[i];

        if (!from || !to) continue;

        // 应用压感曲线后计算线条粗细
        const adjustedPressure = applyPressureCurve(to.pressure, pressureCurve);
        const size = currentSize * adjustedPressure;
        const opacity = brushOpacity * adjustedPressure;

        ctx.globalAlpha = opacity;
        ctx.lineWidth = Math.max(1, size);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        if (isEraser) {
          if (isBackground) {
            // Background layer: draw background fill color instead of erasing to transparency
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = useDocumentStore.getState().backgroundFillColor || '#ffffff';
          } else {
            // Normal layer: erase to transparency
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0,0,0,1)';
          }
        } else {
          // Brush: normal drawing
          ctx.globalCompositeOperation = 'source-over';
          ctx.strokeStyle = brushColor;
        }

        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }

      // Reset composite operation
      ctx.globalCompositeOperation = 'source-over';

      // Update composite display
      compositeAndRender();
    },
    [
      currentSize,
      brushColor,
      brushOpacity,
      pressureCurve,
      currentTool,
      getActiveLayerCtx,
      compositeAndRender,
      isActiveLayerBackground,
    ]
  );

  // Internal stroke finishing logic (called after state machine validation)
  // Renamed to finalizeStroke for clarity
  const finalizeStroke = useCallback(async () => {
    // 清理 WinTab 缓冲区
    clearPointBuffer();

    const isBrushStroke = isBrushStrokeState(strokeStateRef.current) || isStrokeActive();

    // For brush tool, composite stroke buffer to layer with opacity ceiling
    if (isBrushStroke) {
      // Process any remaining points in queue before finalizing
      const remainingQueue = inputQueueRef.current;
      let processedTailQueue = false;
      if (remainingQueue.length > 0) {
        for (const p of remainingQueue) {
          processSinglePoint(p.x, p.y, p.pressure, p.pointIndex, {
            tiltX: p.tiltX,
            tiltY: p.tiltY,
            rotation: p.rotation,
          });
        }
        inputQueueRef.current = [];
        processedTailQueue = true;
      }

      // Flush/render tail points immediately so pointer-up does not show delayed late dabs.
      if (processedTailQueue) {
        flushPending();
        if (useGpuDisplay) {
          renderGpuFrame(true);
        }
      }

      if (useGpuDisplay && commitStrokeGpu) {
        await commitStrokeGpu();
      } else {
        const layerCtx = getActiveLayerCtx();
        if (layerCtx) {
          await endBrushStroke(layerCtx);
        }
      }
      compositeAndRender();
    } else {
      // For eraser, use the legacy stroke buffer
      const remainingPoints = strokeBufferRef.current?.finish() ?? [];
      if (remainingPoints.length > 0) {
        drawPoints(
          remainingPoints.map((p) => ({
            ...p,
            tilt_x: p.tiltX ?? 0,
            tilt_y: p.tiltY ?? 0,
            timestamp_ms: 0,
          }))
        );
      }
    }

    if (isBrushStroke || currentTool === 'eraser') {
      const fallbackPos = lastRenderedPosRef.current ?? lastInputPosRef.current;
      const lastPos = isBrushStroke
        ? (getLastDabPosition() ?? fallbackPos)
        : lastInputPosRef.current;
      onShiftLineStrokeEnd(lastPos ?? null);
    }
    lastInputPosRef.current = null;

    // Save stroke to history (uses beforeImage captured at stroke start)
    saveStrokeToHistory();
    if (activeLayerId) {
      updateThumbnail(activeLayerId);
    }

    isDrawingRef.current = false;
    strokeStateRef.current = 'idle';
    pendingPointsRef.current = [];
    inputQueueRef.current = [];
    pendingEndRef.current = false;
    lastRenderedPosRef.current = null;
    lastDynamicsRef.current = { tiltX: 0, tiltY: 0, rotation: 0 };
    window.__strokeDiagnostics?.onStrokeEnd();
  }, [
    currentTool,
    inputQueueRef,
    pendingPointsRef,
    pendingEndRef,
    processSinglePoint,
    flushPending,
    renderGpuFrame,
    useGpuDisplay,
    commitStrokeGpu,
    getActiveLayerCtx,
    endBrushStroke,
    compositeAndRender,
    strokeBufferRef,
    drawPoints,
    saveStrokeToHistory,
    activeLayerId,
    updateThumbnail,
    getLastDabPosition,
    isStrokeActive,
    onShiftLineStrokeEnd,
    lastRenderedPosRef,
    lastInputPosRef,
    lastDynamicsRef,
    isDrawingRef,
    strokeStateRef,
  ]);

  // Finish the current stroke properly (used by PointerUp and Alt key)
  // Phase 2.7: Uses state machine to handle starting/active/finishing states
  const finishCurrentStroke = useCallback(async () => {
    if (!isDrawingRef.current) return;

    const state = strokeStateRef.current;

    // Case 1: Still in 'starting' phase - mark pendingEnd, let PointerDown callback handle it
    if (state === 'starting') {
      pendingEndRef.current = true;
      return;
    }

    // Case 2: In 'active' phase - transition to 'finishing' and complete
    if (state === 'active') {
      strokeStateRef.current = 'finishing';
      await finalizeStroke();
      return;
    }

    // Case 3: 'idle' or 'finishing' - ignore (already handled or never started)
  }, [finalizeStroke, isDrawingRef, strokeStateRef, pendingEndRef]);

  /**
   * Initialize brush stroke asynchronously.
   * Handles state transitions and replaying buffered input.
   */
  const initializeBrushStroke = useCallback(async () => {
    try {
      const wetEdgeValue = wetEdgeEnabled ? wetEdge : 0;
      await beginBrushStroke(brushHardness, wetEdgeValue);

      // Check if cancelled or state changed during await
      if (strokeStateRef.current !== 'starting') {
        pendingPointsRef.current = [];
        return;
      }

      // Transition to 'active' state
      strokeStateRef.current = 'active';
      window.__strokeDiagnostics?.onStateChange('active');

      // Replay all buffered points
      const points = pendingPointsRef.current;
      const config = getBrushConfig();
      const isBuildup = config.buildupEnabled;

      let replayPoints = points;
      if (isBuildup && points.length > 1) {
        // When Build-up is enabled, the 'starting' phase can accumulate many
        // near-identical points at the same coordinate (especially with WinTab/raw input).
        // Replaying all of them can create an overly heavy "starting blob".
        // Collapse consecutive near-identical points by keeping only the latest.
        const out: QueuedPoint[] = [];
        const eps2 = 0.5 * 0.5;
        let last = points[0]!;
        out.push(last);
        for (let i = 1; i < points.length; i++) {
          const p = points[i]!;
          const dx = p.x - last.x;
          const dy = p.y - last.y;
          if (dx * dx + dy * dy <= eps2) {
            out[out.length - 1] = p;
            last = p;
            continue;
          }
          out.push(p);
          last = p;
        }

        // In Build-up mode we emit a dab for the first processed point.
        // PointerDown pressure is sometimes less reliable than the first move/raw sample,
        // which can create an overly heavy "starting dab" (especially at very light pressure).
        // If we have at least one follow-up point, start from it and keep tap/hold behavior
        // (single-point strokes) unchanged.
        replayPoints = out.length > 1 ? out.slice(1) : out;
      }

      for (const p of replayPoints) {
        processBrushPointWithConfig(p.x, p.y, p.pressure, p.pointIndex, {
          tiltX: p.tiltX,
          tiltY: p.tiltY,
          rotation: p.rotation,
        });
        window.__strokeDiagnostics?.onPointBuffered();
      }
      pendingPointsRef.current = [];

      // If pendingEnd flag was set during 'starting' phase, finish immediately
      if (pendingEndRef.current) {
        strokeStateRef.current = 'finishing';
        await finalizeStroke();
      }
    } catch (err) {
      console.error('Failed to begin stroke:', err);
      // Reset state on error to avoid sticking in 'starting'
      strokeStateRef.current = 'idle';
      pendingPointsRef.current = [];
      inputQueueRef.current = [];
      pendingEndRef.current = false;
      isDrawingRef.current = false;
      lastDynamicsRef.current = { tiltX: 0, tiltY: 0, rotation: 0 };
    }
  }, [
    beginBrushStroke,
    brushHardness,
    wetEdgeEnabled,
    wetEdge,
    finalizeStroke,
    processBrushPointWithConfig,
    getBrushConfig,
    strokeStateRef,
    pendingPointsRef,
    inputQueueRef,
    pendingEndRef,
    isDrawingRef,
    lastDynamicsRef,
  ]);

  return { drawPoints, finishCurrentStroke, initializeBrushStroke };
}
