import React, { useEffect, useRef, useCallback, useMemo } from 'react';
import { useToolStore, ToolType } from '@/stores/tool';
import { useSelectionStore } from '@/stores/selection';
import { useDocumentStore } from '@/stores/document';
import { useViewportStore } from '@/stores/viewport';
import { useHistoryStore } from '@/stores/history';
import { useSettingsStore } from '@/stores/settings';
import { useTabletStore } from '@/stores/tablet';
import { useSelectionHandler } from './useSelectionHandler';
import { useCursor } from './useCursor';
import { useBrushRenderer, BrushRenderConfig } from './useBrushRenderer';
import { useRawPointerInput } from './useRawPointerInput';
import { useAltEyedropper } from './useAltEyedropper';
import { useShiftLineMode } from './useShiftLineMode';
import { useLayerOperations } from './useLayerOperations';
import { useGlobalExports } from './useGlobalExports';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { usePointerHandlers } from './usePointerHandlers';
import { useStrokeProcessor } from './useStrokeProcessor';
import { SelectionOverlay } from './SelectionOverlay';
import { LatencyProfiler, LagometerMonitor, FPSCounter } from '@/benchmark';
import { LayerRenderer } from '@/utils/layerRenderer';
import { StrokeBuffer } from '@/utils/interpolation';
import { StrokeCaptureController, type StrokeCaptureData, type StrokeReplayOptions } from '@/test';
import {
  GPUContext,
  GpuCanvasRenderer,
  GpuStrokeCommitCoordinator,
  loadResidencyBudget,
  type GpuBrushCommitReadbackMode,
  type GpuBrushCommitMetricsSnapshot,
  type GpuStrokeCommitResult,
} from '@/gpu';

import './Canvas.css';

declare global {
  interface Window {
    __canvasFillLayer?: (color: string) => void;
    __canvasClearSelection?: () => void;
    __canvasClearLayer?: () => void;
    __getLayerImageData?: (layerId: string) => Promise<string | undefined>;
    __getFlattenedImage?: () => Promise<string | undefined>;
    __getThumbnail?: () => Promise<string | undefined>;
    __loadLayerImages?: (
      layersData: Array<{ id: string; imageData?: string; offsetX?: number; offsetY?: number }>,
      benchmarkSessionId?: string
    ) => Promise<void>;
    __gpuBrushDebugRects?: boolean;
    __gpuBrushUseBatchUnionRect?: boolean;
    __gpuBrushDiag?: boolean;
    __gpuBrushDiagCopyBytesThreshold?: number;
    __gpuBrushDiagPendingMsThreshold?: number;
    __gpuBrushDiagnostics?: () => unknown;
    __gpuBrushDiagnosticsReset?: () => boolean;
    __gpuBrushCommitMetrics?: () => GpuBrushCommitMetricsSnapshot | null;
    __gpuBrushCommitMetricsReset?: () => boolean;
    __gpuBrushCommitReadbackMode?: () => GpuBrushCommitReadbackMode;
    __gpuBrushCommitReadbackModeSet?: (mode: GpuBrushCommitReadbackMode) => boolean;
    __gpuBrushNoReadbackPilot?: () => boolean;
    __gpuBrushNoReadbackPilotSet?: (enabled: boolean) => boolean;
    __gpuM0Baseline?: () => Promise<void>;
    __strokeCaptureStart?: () => boolean;
    __strokeCaptureStop?: () => StrokeCaptureData | null;
    __strokeCaptureLast?: () => StrokeCaptureData | null;
    __strokeCaptureReplay?: (
      capture?: StrokeCaptureData | string,
      options?: StrokeReplayOptions
    ) => Promise<{ events: number; durationMs: number } | null>;
    __strokeCaptureDownload?: (fileName?: string, capture?: StrokeCaptureData | string) => boolean;
    __strokeDiagnostics?: {
      onPointBuffered: () => void;
      onStrokeStart: () => void;
      onStrokeEnd: () => void;
      onStateChange: (state: string) => void;
      onStartPressureFallback: () => void;
      startPressureFallbackCount?: number;
    };
  }
}

type QueuedPoint = { x: number; y: number; pressure: number; pointIndex: number };

function tileCoordKey(x: number, y: number): string {
  return `${x},${y}`;
}

function parseTileCoordKey(key: string): { x: number; y: number } | null {
  const [xStr, yStr] = key.split(',');
  if (xStr === undefined || yStr === undefined) return null;
  const x = Number.parseInt(xStr, 10);
  const y = Number.parseInt(yStr, 10);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gpuCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDrawingRef = useRef(false);
  const brushCursorRef = useRef<HTMLDivElement>(null);
  const eyedropperCursorRef = useRef<HTMLDivElement>(null);
  const layerRendererRef = useRef<LayerRenderer | null>(null);
  const strokeBufferRef = useRef(new StrokeBuffer());
  const gpuRendererRef = useRef<GpuCanvasRenderer | null>(null);
  const gpuCommitCoordinatorRef = useRef<GpuStrokeCommitCoordinator | null>(null);
  const residencyBudgetLoggedRef = useRef(false);
  const layerRevisionRef = useRef(0);
  const lagometerRef = useRef(new LagometerMonitor());
  const fpsCounterRef = useRef(new FPSCounter());
  const lastRenderedPosRef = useRef<{ x: number; y: number } | null>(null);
  const lastInputPosRef = useRef<{ x: number; y: number } | null>(null);
  const needsRenderRef = useRef(false);
  const pendingEndRef = useRef(false);
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  const zoomStartRef = useRef<{ x: number; y: number; startScale: number } | null>(null);
  const isZoomingRef = useRef(false);
  const previousToolRef = useRef<ToolType | null>('brush');
  const historyInitializedRef = useRef(false);
  const strokeCaptureRef = useRef<StrokeCaptureController | null>(null);
  const pendingGpuCpuSyncTilesRef = useRef<Map<string, Set<string>>>(new Map());
  const prevGpuDisplayActiveRef = useRef(false);
  const prevGpuDisplayLayerIdRef = useRef<string | null>(null);

  // Input processing refs
  const strokeStateRef = useRef<string>('idle');
  const pendingPointsRef = useRef<QueuedPoint[]>([]);
  const inputQueueRef = useRef<QueuedPoint[]>([]);
  const pointIndexRef = useRef(0);

  // Profiling
  const latencyProfilerRef = useRef(new LatencyProfiler());

  // Store access
  const {
    currentTool,
    brushRoundness,
    brushAngle,
    brushTexture,
    brushColor,
    backgroundColor,
    brushOpacity,
    brushFlow,
    brushHardness,
    brushMaskType,
    brushSpacing,
    shapeDynamics,
    scatter,
    colorDynamics,
    transfer,
    wetEdge,
    wetEdgeEnabled,
    buildupEnabled,
    shapeDynamicsEnabled,
    scatterEnabled,
    colorDynamicsEnabled,
    transferEnabled,
    textureEnabled,
    textureSettings,
    noiseEnabled,
    dualBrush,
    dualBrushEnabled,
    showCrosshair,
    setTool,
    setCurrentSize,
    setBrushColor,
    pressureCurve,
    pressureFlowEnabled,
    pressureOpacityEnabled,
    pressureSizeEnabled,
  } = useToolStore();

  const { eraserSize } = useToolStore();
  const brushSize = useToolStore((s) => s.brushSize);
  const currentSize = currentTool === 'eraser' ? eraserSize : brushSize;

  const {
    brush: { renderMode },
  } = useSettingsStore();

  const {
    width,
    height,
    activeLayerId,
    layers,
    initDocument,
    backgroundFillColor,
    consumePendingHistoryLayerAdd,
  } = useDocumentStore((s) => ({
    width: s.width,
    height: s.height,
    activeLayerId: s.activeLayerId,
    layers: s.layers,
    initDocument: s.initDocument,
    backgroundFillColor: s.backgroundFillColor,
    consumePendingHistoryLayerAdd: s.consumePendingHistoryLayerAdd,
  }));

  const visibleLayerCount = useMemo(() => layers.filter((layer) => layer.visible).length, [layers]);

  const { pushAddLayer } = useHistoryStore();

  const { isPanning, scale, setScale, setIsPanning, pan, zoomIn, zoomOut, offsetX, offsetY } =
    useViewportStore();

  useEffect(() => {
    if (!strokeCaptureRef.current) {
      strokeCaptureRef.current = new StrokeCaptureController({
        getCanvas: () => canvasRef.current,
        getCaptureRoot: () => containerRef.current,
        getScale: () => useViewportStore.getState().scale,
        getLiveInputOverride: (event) => {
          // WinTab backend often reports PointerEvent pressure as a constant mouse-like value.
          // For recording/replay fidelity, capture pressure/tilt from tablet stream when available.
          if (!event.isTrusted) return null;
          if (event.type !== 'pointerdown' && event.type !== 'pointermove') return null;

          const tablet = useTabletStore.getState();
          const isWinTabActive =
            tablet.isStreaming &&
            typeof tablet.backend === 'string' &&
            tablet.backend.toLowerCase() === 'wintab';
          if (!isWinTabActive) return null;

          const pt = tablet.currentPoint;
          if (!pt) return null;

          return {
            pressure: pt.pressure,
            tiltX: pt.tilt_x,
            tiltY: pt.tilt_y,
            pointerType: 'pen',
          };
        },
        getMetadata: () => {
          const docState = useDocumentStore.getState();
          const toolState = useToolStore.getState();
          const viewportState = useViewportStore.getState();
          return {
            canvasWidth: docState.width,
            canvasHeight: docState.height,
            viewportScale: viewportState.scale,
            viewportOffsetX: viewportState.offsetX,
            viewportOffsetY: viewportState.offsetY,
            activeLayerId: docState.activeLayerId,
            tool: {
              currentTool: toolState.currentTool,
              brushColor: toolState.brushColor,
              brushSize: toolState.brushSize,
              brushFlow: toolState.brushFlow,
              brushOpacity: toolState.brushOpacity,
              brushHardness: toolState.brushHardness,
              brushSpacing: toolState.brushSpacing,
              pressureCurve: toolState.pressureCurve,
              pressureSizeEnabled: toolState.pressureSizeEnabled,
              pressureFlowEnabled: toolState.pressureFlowEnabled,
              pressureOpacityEnabled: toolState.pressureOpacityEnabled,
            },
          };
        },
      });
    }

    return () => {
      strokeCaptureRef.current?.cancel();
    };
  }, []);

  const startStrokeCapture = useCallback(() => {
    return strokeCaptureRef.current?.start() ?? false;
  }, []);

  const stopStrokeCapture = useCallback(() => {
    return strokeCaptureRef.current?.stop() ?? null;
  }, []);

  const getLastStrokeCapture = useCallback(() => {
    return strokeCaptureRef.current?.getLastCapture() ?? null;
  }, []);

  const replayStrokeCapture = useCallback(
    async (capture?: StrokeCaptureData | string, options?: StrokeReplayOptions) => {
      if (!strokeCaptureRef.current) return null;
      return strokeCaptureRef.current.replay(capture, options);
    },
    []
  );

  const downloadStrokeCapture = useCallback(
    (fileName?: string, capture?: StrokeCaptureData | string) => {
      if (!strokeCaptureRef.current) return false;
      return strokeCaptureRef.current.download(fileName, capture);
    },
    []
  );

  // Selection handler for rect select and lasso tools
  const {
    handleSelectionPointerDown,
    handleSelectionPointerMove,
    handleSelectionPointerUp,
    handleSelectionDoubleClick: _handleSelectionDoubleClick,
    isSelectionToolActive,
  } = useSelectionHandler({ currentTool, scale });

  // Get selection store actions for keyboard shortcuts
  const { selectAll, deselectAll, cancelSelection } = useSelectionStore();
  const selectionMask = useSelectionStore((s) => s.selectionMask);

  // Initialize brush renderer for Flow/Opacity three-level pipeline
  const {
    beginStroke: beginBrushStroke,
    processPoint: processBrushPoint,
    endStroke: endBrushStroke,
    getPreviewCanvas,
    getPreviewOpacity,
    isStrokeActive,
    getLastDabPosition,
    getDebugRects,
    flushPending,
    backend: brushBackend,
    gpuAvailable,
    setGpuPreviewReadbackEnabled,
    getScratchHandle,
    prepareStrokeEndGpu,
    clearScratchGpu,
    getGpuRenderScale,
    getGpuDiagnosticsSnapshot,
    resetGpuDiagnostics,
  } = useBrushRenderer({
    width,
    height,
    renderMode,
    benchmarkProfiler: latencyProfilerRef.current,
  });

  const gpuDisplayActive = useMemo(
    () =>
      brushBackend === 'gpu' && gpuAvailable && currentTool === 'brush' && visibleLayerCount <= 1,
    [brushBackend, gpuAvailable, currentTool, visibleLayerCount]
  );

  useEffect(() => {
    if (!gpuAvailable) return;
    const device = GPUContext.getInstance().device;
    const gpuCanvas = gpuCanvasRef.current;
    if (!device || !gpuCanvas) return;

    if (!gpuRendererRef.current) {
      gpuRendererRef.current = new GpuCanvasRenderer(device, gpuCanvas, {
        tileSize: 512,
        layerFormat: 'rgba8unorm',
      });
    }

    const budgetInfo = loadResidencyBudget();
    gpuRendererRef.current.setResidencyBudgetBytes(budgetInfo.budgetBytes);
    if (!residencyBudgetLoggedRef.current) {
      const budgetMb = (budgetInfo.budgetBytes / (1024 * 1024)).toFixed(0);
      if (budgetInfo.source === 'probe') {
        const maxProbeGb = ((budgetInfo.maxAllocationBytes ?? 0) / (1024 * 1024 * 1024)).toFixed(2);
        // eslint-disable-next-line no-console
        console.info(
          `[GpuCanvasRenderer] Residency budget from probe: ${budgetMb} MB (probe max ${maxProbeGb} GiB)`
        );
      } else {
        // eslint-disable-next-line no-console
        console.info(`[GpuCanvasRenderer] Residency budget fallback: ${budgetMb} MB`);
      }
      residencyBudgetLoggedRef.current = true;
    }

    gpuRendererRef.current.resize(width, height);
  }, [gpuAvailable, width, height]);

  useEffect(() => {
    const gpuRenderer = gpuRendererRef.current;
    if (!gpuRenderer) return;

    const coordinator = new GpuStrokeCommitCoordinator({
      gpuRenderer,
      prepareStrokeEndGpu,
      clearScratchGpu,
      getTargetLayer: (layerId: string) => {
        const layer = layerRendererRef.current?.getLayer(layerId);
        if (!layer) return null;
        return { canvas: layer.canvas, ctx: layer.ctx };
      },
    });
    coordinator.setReadbackMode('disabled');
    gpuCommitCoordinatorRef.current = coordinator;
  }, [prepareStrokeEndGpu, clearScratchGpu]);

  useEffect(() => {
    setGpuPreviewReadbackEnabled(!gpuDisplayActive);
  }, [gpuDisplayActive, setGpuPreviewReadbackEnabled]);

  useEffect(() => {
    if (gpuRendererRef.current) {
      gpuRendererRef.current.setSelectionMask(selectionMask ?? null);
    }
  }, [selectionMask]);

  // Tablet store: We use getState() directly in event handlers for real-time data
  // No need to subscribe to state changes here since we sync-read in handlers

  // Q1 Optimization: Use pointerrawupdate for lower-latency input (1-3ms improvement)
  const { usingRawInput } = useRawPointerInput({
    containerRef,
    canvasRef,
    scale,
    isDrawingRef,
    currentTool,
    strokeStateRef,
    pendingPointsRef,
    inputQueueRef,
    pointIndexRef,
    latencyProfiler: latencyProfilerRef.current,
    onPointBuffered: () => window.__strokeDiagnostics?.onPointBuffered(),
  });

  const isLineToolActive = currentTool === 'brush' || currentTool === 'eraser';

  const requestRender = useCallback(() => {
    needsRenderRef.current = true;
  }, []);

  const markLayerDirty = useCallback(() => {
    layerRevisionRef.current += 1;
  }, []);

  const trackPendingGpuCpuSyncTiles = useCallback(
    (layerId: string, tiles: Array<{ x: number; y: number }>) => {
      if (tiles.length === 0) return;
      let layerTiles = pendingGpuCpuSyncTilesRef.current.get(layerId);
      if (!layerTiles) {
        layerTiles = new Set<string>();
        pendingGpuCpuSyncTilesRef.current.set(layerId, layerTiles);
      }
      for (const tile of tiles) {
        layerTiles.add(tileCoordKey(tile.x, tile.y));
      }
    },
    []
  );

  const syncGpuLayerToCpu = useCallback(async (layerId: string): Promise<boolean> => {
    const gpuRenderer = gpuRendererRef.current;
    const renderer = layerRendererRef.current;
    if (!gpuRenderer || !renderer) return false;

    const layer = renderer.getLayer(layerId);
    if (!layer) return false;

    const trackedTileKeys = pendingGpuCpuSyncTilesRef.current.get(layerId);
    if (!trackedTileKeys || trackedTileKeys.size === 0) return false;

    const tiles: Array<{ x: number; y: number }> = [];
    for (const key of trackedTileKeys) {
      const coord = parseTileCoordKey(key);
      if (coord) {
        tiles.push(coord);
      }
    }
    if (tiles.length === 0) {
      pendingGpuCpuSyncTilesRef.current.delete(layerId);
      return false;
    }

    try {
      await gpuRenderer.readbackTilesToLayer({
        layerId,
        tiles,
        targetCtx: layer.ctx,
      });
      pendingGpuCpuSyncTilesRef.current.delete(layerId);
      return true;
    } catch (error) {
      console.warn('[NoReadback] Failed to sync GPU tiles to CPU layer', { layerId, error });
      return false;
    }
  }, []);

  const syncAllPendingGpuLayersToCpu = useCallback(async (): Promise<number> => {
    const layerIds = Array.from(pendingGpuCpuSyncTilesRef.current.keys());
    if (layerIds.length === 0) return 0;
    let synced = 0;
    for (const layerId of layerIds) {
      if (await syncGpuLayerToCpu(layerId)) {
        synced += 1;
      }
    }
    return synced;
  }, [syncGpuLayerToCpu]);

  const getGpuBrushNoReadbackPilot = useCallback((): boolean => {
    return gpuCommitCoordinatorRef.current?.getReadbackMode() === 'disabled';
  }, []);

  const setGpuBrushNoReadbackPilot = useCallback(
    (enabled: boolean): boolean => {
      const coordinator = gpuCommitCoordinatorRef.current;
      if (!coordinator) {
        return false;
      }
      coordinator.setReadbackMode(enabled ? 'disabled' : 'enabled');
      if (!enabled) {
        void syncAllPendingGpuLayersToCpu();
      }
      return true;
    },
    [syncAllPendingGpuLayersToCpu]
  );

  const {
    getGuideLine: getShiftLineGuide,
    updateCursor: updateShiftLineCursor,
    constrainPoint: constrainShiftLinePoint,
    lockLine: lockShiftLine,
    onStrokeEnd: onShiftLineStrokeEnd,
  } = useShiftLineMode({
    enabled: isLineToolActive,
    onInvalidate: requestRender,
    focusContainerRef: containerRef,
  });

  // Composite all layers and render to display canvas
  const compositeAndRender = useCallback(() => {
    const canvas = canvasRef.current;
    const renderer = layerRendererRef.current;

    if (!canvas || !renderer) return;

    // Ensure display canvas buffer matches document size (needed for immediate resize/undo/redo)
    const { width: docWidth, height: docHeight } = useDocumentStore.getState();
    if (canvas.width !== docWidth) canvas.width = docWidth;
    if (canvas.height !== docHeight) canvas.height = docHeight;
    const gpuCanvas = gpuCanvasRef.current;
    if (gpuCanvas) {
      if (gpuCanvas.width !== docWidth) gpuCanvas.width = docWidth;
      if (gpuCanvas.height !== docHeight) gpuCanvas.height = docHeight;
    }

    if (gpuDisplayActive && gpuRendererRef.current && activeLayerId) {
      const layer = renderer.getLayer(activeLayerId);
      if (!layer) return;

      gpuRendererRef.current.syncLayerFromCanvas(
        activeLayerId,
        layer.canvas,
        layerRevisionRef.current
      );
      gpuRendererRef.current.renderFrame({
        layerId: activeLayerId,
        scratchTexture: null,
        strokeOpacity: 1,
        renderScale: getGpuRenderScale(),
      });
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, docWidth, docHeight);
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Composite all layers
    const compositeCanvas = renderer.composite();

    // Clear and draw composite to display canvas
    ctx.clearRect(0, 0, docWidth, docHeight);
    ctx.drawImage(compositeCanvas, 0, 0);
  }, [activeLayerId, getGpuRenderScale, gpuDisplayActive]);

  const {
    updateThumbnail,
    captureBeforeImage,
    saveStrokeToHistory,
    fillActiveLayer,
    handleClearSelection,
    handleUndo,
    handleRedo,
    handleClearLayer,
    handleDuplicateLayer,
    handleRemoveLayer,
    handleResizeCanvas,
  } = useLayerOperations({
    layerRendererRef,
    activeLayerId,
    layers,
    width,
    height,
    compositeAndRender,
    markLayerDirty,
    syncGpuLayerForHistory: syncGpuLayerToCpu,
  });

  const renderGpuFrame = useCallback(
    (showScratch: boolean) => {
      const gpuRenderer = gpuRendererRef.current;
      const renderer = layerRendererRef.current;
      if (!gpuRenderer || !renderer || !activeLayerId) return;

      const layer = renderer.getLayer(activeLayerId);
      if (!layer) return;

      gpuRenderer.syncLayerFromCanvas(activeLayerId, layer.canvas, layerRevisionRef.current);

      const scratchHandle = showScratch ? getScratchHandle() : null;
      const strokeOpacity = showScratch ? getPreviewOpacity() : 1;

      gpuRenderer.renderFrame({
        layerId: activeLayerId,
        scratchTexture: scratchHandle?.texture ?? null,
        strokeOpacity,
        renderScale: scratchHandle?.renderScale ?? getGpuRenderScale(),
      });
    },
    [activeLayerId, getScratchHandle, getPreviewOpacity, getGpuRenderScale]
  );

  const commitStrokeGpu = useCallback(async (): Promise<GpuStrokeCommitResult> => {
    const coordinator = gpuCommitCoordinatorRef.current;
    if (!coordinator) {
      return {
        committed: false,
        dirtyRect: null,
        dirtyTiles: [],
        timings: { prepareMs: 0, commitMs: 0, readbackMs: 0 },
      };
    }
    const result = await coordinator.commit(activeLayerId);
    if (
      activeLayerId &&
      result.dirtyTiles.length > 0 &&
      coordinator.getReadbackMode() === 'disabled'
    ) {
      trackPendingGpuCpuSyncTiles(activeLayerId, result.dirtyTiles);
    }
    return result;
  }, [activeLayerId, trackPendingGpuCpuSyncTiles]);

  const getGpuBrushCommitMetricsSnapshot = useCallback((): GpuBrushCommitMetricsSnapshot | null => {
    return gpuCommitCoordinatorRef.current?.getCommitMetricsSnapshot() ?? null;
  }, []);

  const resetGpuBrushCommitMetrics = useCallback((): boolean => {
    const coordinator = gpuCommitCoordinatorRef.current;
    if (!coordinator) {
      return false;
    }
    coordinator.resetCommitMetrics();
    return true;
  }, []);

  const getGpuBrushCommitReadbackMode = useCallback((): GpuBrushCommitReadbackMode => {
    return gpuCommitCoordinatorRef.current?.getReadbackMode() ?? 'enabled';
  }, []);

  const setGpuBrushCommitReadbackMode = useCallback(
    (mode: GpuBrushCommitReadbackMode): boolean => {
      const coordinator = gpuCommitCoordinatorRef.current;
      if (!coordinator) {
        return false;
      }
      coordinator.setReadbackMode(mode);
      if (mode === 'enabled') {
        void syncAllPendingGpuLayersToCpu();
      }
      return true;
    },
    [syncAllPendingGpuLayersToCpu]
  );

  useEffect(() => {
    const prevActive = prevGpuDisplayActiveRef.current;
    const prevLayerId = prevGpuDisplayLayerIdRef.current;
    if (prevActive && prevLayerId && (!gpuDisplayActive || prevLayerId !== activeLayerId)) {
      void (async () => {
        const synced = await syncGpuLayerToCpu(prevLayerId);
        if (synced && !gpuDisplayActive) {
          compositeAndRender();
        }
      })();
    }
    prevGpuDisplayActiveRef.current = gpuDisplayActive;
    prevGpuDisplayLayerIdRef.current = activeLayerId;
  }, [gpuDisplayActive, activeLayerId, syncGpuLayerToCpu, compositeAndRender]);

  useGlobalExports({
    layerRendererRef,
    compositeAndRender,
    fillActiveLayer,
    handleClearSelection,
    handleUndo,
    handleRedo,
    handleClearLayer,
    handleDuplicateLayer,
    handleRemoveLayer,
    handleResizeCanvas,
    getGpuDiagnosticsSnapshot,
    resetGpuDiagnostics,
    getGpuBrushCommitMetricsSnapshot,
    resetGpuBrushCommitMetrics,
    getGpuBrushCommitReadbackMode,
    setGpuBrushCommitReadbackMode,
    getGpuBrushNoReadbackPilot,
    setGpuBrushNoReadbackPilot,
    syncGpuLayerToCpu,
    syncAllGpuLayersToCpu: syncAllPendingGpuLayersToCpu,
    startStrokeCapture,
    stopStrokeCapture,
    getLastStrokeCapture,
    replayStrokeCapture,
    downloadStrokeCapture,
  });

  // Initialize document and layer renderer
  useEffect(() => {
    // Initialize document if no layers exist
    if (layers.length === 0) {
      initDocument({ width, height, dpi: 72 });
    }
  }, [layers.length, initDocument, width, height]);

  // Initialize layer renderer and sync with document layers
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Create or update layer renderer
    if (!layerRendererRef.current) {
      layerRendererRef.current = new LayerRenderer(width, height);
    } else {
      const renderer = layerRendererRef.current;
      const compositeCanvas = renderer.getCompositeCanvas();
      if (compositeCanvas.width !== width || compositeCanvas.height !== height) {
        renderer.resize(width, height);
      }
    }

    const renderer = layerRendererRef.current;

    // Sync layers from document store
    const existingIds = new Set(renderer.getLayerIds());
    const documentIds = new Set(layers.map((l) => l.id));

    // Remove layers that no longer exist
    for (const id of existingIds) {
      if (!documentIds.has(id)) {
        renderer.removeLayer(id);
      }
    }

    // Add or update layers
    for (const layer of layers) {
      if (!existingIds.has(layer.id)) {
        // Create new layer
        renderer.createLayer(layer.id, {
          visible: layer.visible,
          opacity: layer.opacity,
          blendMode: layer.blendMode,
          fillColor: layer.isBackground ? backgroundFillColor : undefined,
          isBackground: layer.isBackground,
        });
        // Generate initial thumbnail for new layers
        updateThumbnail(layer.id);

        // Save initial state to history for new layers
        // Use pushAddLayer to record layer creation for undo
        if (consumePendingHistoryLayerAdd(layer.id)) {
          const layerIndex = layers.findIndex((l) => l.id === layer.id);
          pushAddLayer(layer.id, layer, layerIndex);
        }
      } else {
        // Update existing layer properties
        renderer.updateLayer(layer.id, {
          visible: layer.visible,
          opacity: layer.opacity,
          blendMode: layer.blendMode,
          isBackground: layer.isBackground,
        });
      }
    }

    // Update layer order
    renderer.setLayerOrder(layers.map((l) => l.id));

    // Initial composite render
    compositeAndRender();

    // Mark history as initialized after first layer is added
    if (activeLayerId && !historyInitializedRef.current) {
      historyInitializedRef.current = true;
    }
  }, [
    layers,
    width,
    height,
    activeLayerId,
    compositeAndRender,
    pushAddLayer,
    updateThumbnail,
    backgroundFillColor,
    consumePendingHistoryLayerAdd,
  ]);

  // Re-composite when layer visibility/opacity changes
  useEffect(() => {
    compositeAndRender();
  }, [layers, compositeAndRender]);

  // Re-render when GPU display mode toggles
  useEffect(() => {
    compositeAndRender();
  }, [gpuDisplayActive, compositeAndRender]);

  // 鼠标滚轮缩放
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const centerX = e.clientX - rect.left;
      const centerY = e.clientY - rect.top;

      if (e.deltaY < 0) {
        zoomIn(centerX, centerY);
      } else {
        zoomOut(centerX, centerY);
      }
    },
    [zoomIn, zoomOut]
  );

  // 使用 passive: false 注册 wheel 事件，以便 preventDefault() 正常工作
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [handleWheel]);

  // Build brush render config for the three-level pipeline
  const getBrushConfig = useCallback((): BrushRenderConfig => {
    return {
      size: currentSize,
      flow: brushFlow,
      opacity: brushOpacity,
      hardness: brushHardness,
      maskType: brushMaskType,
      spacing: brushSpacing,
      roundness: brushRoundness,
      angle: brushAngle,
      color: brushColor,
      backgroundColor,
      pressureSizeEnabled,
      pressureFlowEnabled,
      pressureOpacityEnabled,
      pressureCurve,
      texture: brushTexture,
      shapeDynamicsEnabled,
      shapeDynamics,
      scatterEnabled,
      scatter,
      colorDynamicsEnabled,
      colorDynamics,
      wetEdgeEnabled,
      wetEdge,
      buildupEnabled,
      transferEnabled,
      transfer,
      textureEnabled,
      textureSettings,
      noiseEnabled,
      dualBrushEnabled,
      dualBrush,
    };
  }, [
    currentSize,
    brushFlow,
    brushOpacity,
    brushHardness,
    brushMaskType,
    brushSpacing,
    brushRoundness,
    brushAngle,
    brushColor,
    backgroundColor,
    pressureSizeEnabled,
    pressureFlowEnabled,
    pressureOpacityEnabled,
    pressureCurve,
    brushTexture,
    shapeDynamicsEnabled,
    shapeDynamics,
    scatterEnabled,
    scatter,
    colorDynamicsEnabled,
    colorDynamics,
    wetEdgeEnabled,
    wetEdge,
    buildupEnabled,
    transferEnabled,
    transfer,
    textureEnabled,
    textureSettings,
    noiseEnabled,
    dualBrushEnabled,
    dualBrush,
  ]);

  const { drawPoints, finishCurrentStroke, initializeBrushStroke } = useStrokeProcessor({
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
    useGpuDisplay: gpuDisplayActive,
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
  });

  // Alt eyedropper switching - must be after finishCurrentStroke to avoid TDZ
  useAltEyedropper(previousToolRef, finishCurrentStroke);

  const { spacePressed } = useKeyboardShortcuts({
    currentTool,
    currentSize,
    setTool,
    setCurrentSize,
    handleUndo,
    handleRedo,
    selectAll,
    deselectAll,
    cancelSelection,
    width,
    height,
    setIsPanning,
    panStartRef,
  });

  const { cursorStyle, showDomCursor, showEyedropperDomCursor } = useCursor({
    currentTool,
    currentSize,
    scale,
    showCrosshair,
    spacePressed,
    isPanning,
    containerRef,
    brushCursorRef,
    eyedropperCursorRef,
    brushRoundness,
    brushAngle,
    brushTexture: brushTexture
      ? {
          cursorPath: brushTexture.cursorPath,
          cursorBounds: brushTexture.cursorBounds,
        }
      : null,
    canvasRef,
  });

  const { handlePointerDown, handlePointerMove, handlePointerUp } = usePointerHandlers({
    containerRef,
    canvasRef,
    layerRendererRef,
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
  });

  // 计算 viewport 变换样式
  const viewportStyle: React.CSSProperties = {
    transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
    transformOrigin: '0 0',
  };

  // Calculate clip-path for checkerboard
  const x = offsetX;
  const y = offsetY;
  const w = width * scale;
  const h = height * scale;
  const clipPathKey = `polygon(${x}px ${y}px, ${x + w}px ${y}px, ${x + w}px ${y + h}px, ${x}px ${y + h}px)`;

  return (
    <div
      ref={containerRef}
      className="canvas-container"
      tabIndex={-1}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      // Note: onPointerEnter cursor handling is done by native event listener
      style={{ cursor: cursorStyle }}
    >
      <div className="canvas-checkerboard" style={{ clipPath: clipPathKey }} />
      <SelectionOverlay scale={scale} offsetX={offsetX} offsetY={offsetY} />
      <div className="canvas-viewport" style={viewportStyle}>
        <canvas
          ref={gpuCanvasRef}
          width={width}
          height={height}
          className="gpu-canvas"
          data-testid="gpu-canvas"
          style={{ display: gpuDisplayActive ? 'block' : 'none' }}
        />
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          className="main-canvas"
          data-testid="main-canvas"
        />
      </div>
      {showDomCursor && (
        <div
          ref={brushCursorRef}
          className={`brush-cursor ${brushTexture?.cursorPath ? 'brush-cursor--texture' : ''}`}
          style={{
            width: currentSize * scale,
            height: currentSize * scale * (brushRoundness / 100),
            // Note: position transform is set by useCursor via JS
            // rotation is applied to inner content, not the container
          }}
        >
          {brushTexture?.cursorPath ? (
            <svg
              key={brushTexture.cursorPath.slice(0, 50)}
              width="100%"
              height="100%"
              viewBox="-0.5 -0.5 1 1"
              preserveAspectRatio="none"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                overflow: 'visible',
                transform: `rotate(${brushAngle}deg)`,
              }}
            >
              {/* Use vector-effect to keep stroke width constant regardless of viewBox scale */}
              <path
                d={brushTexture.cursorPath}
                fill="none"
                stroke="rgba(255,255,255,0.9)"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={brushTexture.cursorPath}
                fill="none"
                stroke="rgba(0,0,0,0.8)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          ) : (
            // For non-texture brushes, apply rotation via pseudo-element in CSS
            <div
              className="brush-cursor__ellipse"
              style={{
                width: '100%',
                height: '100%',
                borderRadius: '50%',
                border: '1px solid var(--border-strong)',
                boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.5)',
                transform: `rotate(${brushAngle}deg)`,
              }}
            />
          )}
        </div>
      )}
      {showEyedropperDomCursor && (
        <div
          ref={eyedropperCursorRef}
          className="eyedropper-cursor"
          style={{
            position: 'fixed',
            left: 0,
            top: 0,
            pointerEvents: 'none',
            zIndex: 'var(--z-overlay)',
            width: 24,
            height: 24,
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path
              d="m2 22 1-1h3l9-9"
              stroke="black"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="m2 22 1-1h3l9-9"
              stroke="white"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M3 21v-3l9-9"
              stroke="black"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M3 21v-3l9-9"
              stroke="white"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"
              stroke="black"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"
              fill="white"
              stroke="white"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}
    </div>
  );
}
