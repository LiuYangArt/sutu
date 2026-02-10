import React, { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { useToolStore, ToolType } from '@/stores/tool';
import { useSelectionStore } from '@/stores/selection';
import { useDocumentStore } from '@/stores/document';
import { useViewportStore } from '@/stores/viewport';
import { createHistoryEntryId, type HistoryEntry, useHistoryStore } from '@/stores/history';
import { useSettingsStore } from '@/stores/settings';
import { useTabletStore } from '@/stores/tablet';
import { useSelectionHandler } from './useSelectionHandler';
import { useCursor } from './useCursor';
import { useBrushRenderer, BrushRenderConfig } from './useBrushRenderer';
import { useRawPointerInput } from './useRawPointerInput';
import { useAltEyedropper } from './useAltEyedropper';
import { useShiftLineMode } from './useShiftLineMode';
import { useLayerOperations } from './useLayerOperations';
import { useMoveTool } from './useMoveTool';
import { useGlobalExports } from './useGlobalExports';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { usePointerHandlers } from './usePointerHandlers';
import { useStrokeProcessor } from './useStrokeProcessor';
import { SelectionOverlay } from './SelectionOverlay';
import { BrushQuickPanel } from './BrushQuickPanel';
import { clientToCanvasPoint, getDisplayScale, getSafeDevicePixelRatio } from './canvasGeometry';
import { LatencyProfiler, LagometerMonitor, FPSCounter } from '@/benchmark';
import { LayerRenderer, type LayerMovePreview } from '@/utils/layerRenderer';
import {
  StrokeCaptureController,
  type FixedStrokeCaptureLoadResult,
  type FixedStrokeCaptureSaveResult,
  type StrokeCaptureData,
  type StrokeReplayOptions,
} from '@/test';
import {
  GPUContext,
  GpuCanvasRenderer,
  GpuStrokeCommitCoordinator,
  GpuStrokeHistoryStore,
  loadResidencyBudget,
  type GpuRenderableLayer,
  type GpuBrushCommitReadbackMode,
  type GpuBrushCommitMetricsSnapshot,
  type GpuStrokeCommitResult,
} from '@/gpu';
import {
  bumpLayerRevisions,
  isGpuHistoryPathAvailable,
  isGpuLayerStackPathAvailable,
  reconcileLayerRevisionMap,
} from './gpuLayerStackPolicy';
import { runGpuMovePreviewFrame } from './movePreviewGpuSync';

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
    __gpuLayerStackCacheStats?: () => unknown;
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
    __strokeCaptureSaveFixed?: (
      capture?: StrokeCaptureData | string
    ) => Promise<FixedStrokeCaptureSaveResult>;
    __strokeCaptureLoadFixed?: () => Promise<FixedStrokeCaptureLoadResult | null>;
    __gpuM4ParityGate?: (options?: {
      seed?: number;
      capture?: StrokeCaptureData | string;
    }) => Promise<{
      passed: boolean;
      report: string;
      cases: Array<{
        caseId: string;
        passed: boolean;
        meanAbsDiff: number;
        mismatchRatio: number;
      }>;
    }>;
    __gpuSelectionPipelineV2?: () => boolean;
    __gpuSelectionPipelineV2Set?: (enabled: boolean) => boolean;
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

type QueuedPoint = {
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  rotation: number;
  pointIndex: number;
};

const GPU_TILE_SIZE = 512;
const GPU_LAYER_FORMAT: GPUTextureFormat = 'rgba8unorm';
const MIN_GPU_HISTORY_BUDGET_BYTES = 256 * 1024 * 1024;
const MAX_GPU_HISTORY_BUDGET_BYTES = 1024 * 1024 * 1024;
const GPU_HISTORY_BUDGET_RATIO = 0.2;

interface CompositeClipRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface CompositeRenderOptions {
  clipRect?: CompositeClipRect | null;
  forceCpu?: boolean;
  movePreview?: CompositeMovePreview | null;
}

interface CompositeMovePreview {
  layerId: string;
  canvas: HTMLCanvasElement;
  dirtyRect?: CompositeClipRect | null;
}

function isLineTool(tool: ToolType | null): boolean {
  return tool === 'brush' || tool === 'eraser';
}

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

function resolveGpuHistoryBudgetBytes(residencyBudgetBytes: number): number {
  return Math.min(
    MAX_GPU_HISTORY_BUDGET_BYTES,
    Math.max(
      MIN_GPU_HISTORY_BUDGET_BYTES,
      Math.floor(residencyBudgetBytes * GPU_HISTORY_BUDGET_RATIO)
    )
  );
}

function parseTrackedTileCoordKeys(tileKeys: Set<string>): Array<{ x: number; y: number }> {
  const tiles: Array<{ x: number; y: number }> = [];
  for (const key of tileKeys) {
    const coord = parseTileCoordKey(key);
    if (coord) {
      tiles.push(coord);
    }
  }
  return tiles;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gpuCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDrawingRef = useRef(false);
  const brushCursorRef = useRef<HTMLDivElement>(null);
  const eyedropperCursorRef = useRef<HTMLDivElement>(null);
  const layerRendererRef = useRef<LayerRenderer | null>(null);
  const gpuRendererRef = useRef<GpuCanvasRenderer | null>(null);
  const gpuCommitCoordinatorRef = useRef<GpuStrokeCommitCoordinator | null>(null);
  const gpuStrokeHistoryStoreRef = useRef<GpuStrokeHistoryStore | null>(null);
  const pendingGpuHistoryEntryIdRef = useRef<string | null>(null);
  const residencyBudgetLoggedRef = useRef(false);
  const layerRevisionMapRef = useRef<Map<string, number>>(new Map());
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
  const pendingGpuCpuSyncLayerRef = useRef<string | null>(null);
  const pendingGpuCpuSyncRafRef = useRef<number | null>(null);
  const gpuCanvasClearedForCpuRef = useRef(false);
  const pendingMovePreviewRestoreRef = useRef<{
    layerId: string;
    dirtyRect: CompositeClipRect | null;
  } | null>(null);
  const lastPointerClientPosRef = useRef<{ x: number; y: number } | null>(null);
  const finalizeFloatingSelectionSessionRef = useRef<(reason?: string) => void>(() => undefined);
  const hasFloatingSelectionSessionRef = useRef<() => boolean>(() => false);
  const [keepGpuCanvasVisible, setKeepGpuCanvasVisible] = useState(false);
  const [gpuSelectionPipelineV2Enabled, setGpuSelectionPipelineV2Enabled] = useState(true);
  const [devicePixelRatio, setDevicePixelRatio] = useState(() =>
    getSafeDevicePixelRatio(typeof window === 'undefined' ? undefined : window)
  );
  const [brushQuickPanelOpen, setBrushQuickPanelOpen] = useState(false);
  const [brushQuickPanelAnchor, setBrushQuickPanelAnchor] = useState({ x: 0, y: 0 });
  const [brushQuickPanelHovering, setBrushQuickPanelHovering] = useState(false);

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
    eraserBackgroundMode,
  } = useToolStore();

  const { eraserSize } = useToolStore();
  const brushSize = useToolStore((s) => s.brushSize);
  const currentSize = currentTool === 'eraser' ? eraserSize : brushSize;
  const isBrushQuickPanelTool = currentTool === 'brush' || currentTool === 'eraser';

  const {
    brush: { renderMode },
  } = useSettingsStore();

  const {
    width,
    height,
    activeLayerId,
    setActiveLayer,
    layers,
    initDocument,
    backgroundFillColor,
    consumePendingHistoryLayerAdd,
  } = useDocumentStore((s) => ({
    width: s.width,
    height: s.height,
    activeLayerId: s.activeLayerId,
    setActiveLayer: s.setActiveLayer,
    layers: s.layers,
    initDocument: s.initDocument,
    backgroundFillColor: s.backgroundFillColor,
    consumePendingHistoryLayerAdd: s.consumePendingHistoryLayerAdd,
  }));

  const { pushAddLayer } = useHistoryStore();

  const { isPanning, scale, setScale, setIsPanning, pan, zoomIn, zoomOut, offsetX, offsetY } =
    useViewportStore();
  const displayScale = useMemo(
    () => getDisplayScale(scale, devicePixelRatio),
    [scale, devicePixelRatio]
  );

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
          const { texture: _ignoredDualTexture, ...dualBrushWithoutTexture } = toolState.dualBrush;
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
              scatterEnabled: toolState.scatterEnabled,
              scatter: { ...toolState.scatter },
              textureEnabled: toolState.textureEnabled,
              textureSettings: {
                patternId: toolState.textureSettings.patternId,
                scale: toolState.textureSettings.scale,
                brightness: toolState.textureSettings.brightness,
                contrast: toolState.textureSettings.contrast,
                mode: toolState.textureSettings.mode,
                depth: toolState.textureSettings.depth,
                invert: toolState.textureSettings.invert,
              },
              dualBrushEnabled: toolState.dualBrushEnabled,
              dualBrush: dualBrushWithoutTexture,
              wetEdgeEnabled: toolState.wetEdgeEnabled,
              wetEdge: toolState.wetEdge,
              noiseEnabled: toolState.noiseEnabled,
              buildupEnabled: toolState.buildupEnabled,
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

  const finalizeFloatingSessionIfNeeded = useCallback((reason: string): void => {
    if (!hasFloatingSelectionSessionRef.current()) return;
    finalizeFloatingSelectionSessionRef.current(reason);
  }, []);

  const onBeforeCanvasMutation = useCallback(() => {
    finalizeFloatingSessionIfNeeded('canvas-mutation');
  }, [finalizeFloatingSessionIfNeeded]);

  const onBeforeSelectionMutation = useCallback(() => {
    finalizeFloatingSessionIfNeeded('selection-mutation');
  }, [finalizeFloatingSessionIfNeeded]);

  // Selection handler for rect select and lasso tools
  const {
    handleSelectionPointerDown,
    handleSelectionPointerMove,
    handleSelectionPointerUp,
    handleSelectionDoubleClick: _handleSelectionDoubleClick,
    isSelectionToolActive,
  } = useSelectionHandler({ currentTool, scale, onBeforeSelectionMutation });

  // Get selection store actions for keyboard shortcuts
  const { selectAll, deselectAll, cancelSelection } = useSelectionStore();
  const hasSelection = useSelectionStore((s) => s.hasSelection);
  const selectionMask = useSelectionStore((s) => s.selectionMask);
  const selectionMaskPending = useSelectionStore((s) => s.selectionMaskPending);

  // Initialize brush renderer for Flow/Opacity three-level pipeline
  const {
    beginStroke: beginBrushStroke,
    processPoint: processBrushPoint,
    endStroke: endBrushStroke,
    getPreviewCanvas,
    getPreviewOpacity,
    getPreviewCompositeMode,
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

  const gpuLayerStackPathAvailable = useMemo(
    () =>
      isGpuLayerStackPathAvailable({
        brushBackend,
        gpuAvailable,
        currentTool,
        layers: layers.map((layer) => ({ visible: layer.visible, blendMode: layer.blendMode })),
      }),
    [brushBackend, gpuAvailable, currentTool, layers]
  );

  const gpuDisplayActive = gpuLayerStackPathAvailable;

  const gpuHistoryEnabled = useMemo(
    () =>
      isGpuHistoryPathAvailable({
        gpuDisplayActive,
        currentTool,
      }),
    [gpuDisplayActive, currentTool]
  );

  const clearPendingGpuHistoryEntry = useCallback((): void => {
    pendingGpuHistoryEntryIdRef.current = null;
  }, []);

  const collectLiveGpuHistoryEntries = useCallback(
    (entries: HistoryEntry[], liveIds: Set<string>) => {
      for (const entry of entries) {
        if (entry.type !== 'stroke') continue;
        if (entry.snapshotMode !== 'gpu') continue;
        if (!entry.entryId) continue;
        liveIds.add(entry.entryId);
      }
    },
    []
  );

  const pruneGpuStrokeHistory = useCallback(() => {
    const historyStore = gpuStrokeHistoryStoreRef.current;
    if (!historyStore) return;

    const { undoStack, redoStack } = useHistoryStore.getState();
    const liveIds = new Set<string>();
    collectLiveGpuHistoryEntries(undoStack, liveIds);
    collectLiveGpuHistoryEntries(redoStack, liveIds);
    historyStore.pruneExcept(liveIds);
  }, [collectLiveGpuHistoryEntries]);

  useEffect(() => {
    if (!gpuAvailable) return;
    const device = GPUContext.getInstance().device;
    const gpuCanvas = gpuCanvasRef.current;
    if (!device || !gpuCanvas) return;

    if (!gpuRendererRef.current) {
      gpuRendererRef.current = new GpuCanvasRenderer(device, gpuCanvas, {
        tileSize: GPU_TILE_SIZE,
        layerFormat: GPU_LAYER_FORMAT,
      });
    }

    const budgetInfo = loadResidencyBudget();
    gpuRendererRef.current.setResidencyBudgetBytes(budgetInfo.budgetBytes);
    const historyBudgetBytes = resolveGpuHistoryBudgetBytes(budgetInfo.budgetBytes);
    if (!gpuStrokeHistoryStoreRef.current) {
      gpuStrokeHistoryStoreRef.current = new GpuStrokeHistoryStore({
        device,
        tileSize: GPU_TILE_SIZE,
        layerFormat: GPU_LAYER_FORMAT,
        budgetBytes: historyBudgetBytes,
      });
    } else {
      gpuStrokeHistoryStoreRef.current.setBudgetBytes(historyBudgetBytes);
    }
    pruneGpuStrokeHistory();

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
  }, [gpuAvailable, width, height, pruneGpuStrokeHistory]);

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

  useEffect(() => {
    window.__gpuSelectionPipelineV2 = () => gpuSelectionPipelineV2Enabled;
    window.__gpuSelectionPipelineV2Set = (enabled: boolean) => {
      if (typeof enabled !== 'boolean') return false;
      setGpuSelectionPipelineV2Enabled(enabled);
      return true;
    };
    return () => {
      delete window.__gpuSelectionPipelineV2;
      delete window.__gpuSelectionPipelineV2Set;
    };
  }, [gpuSelectionPipelineV2Enabled]);

  useEffect(() => {
    pruneGpuStrokeHistory();
    const unsubscribe = useHistoryStore.subscribe(() => {
      pruneGpuStrokeHistory();
    });
    return () => {
      unsubscribe();
    };
  }, [pruneGpuStrokeHistory]);

  useEffect(() => {
    return () => {
      gpuStrokeHistoryStoreRef.current?.clear();
      gpuStrokeHistoryStoreRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!gpuHistoryEnabled && !isDrawingRef.current) {
      clearPendingGpuHistoryEntry();
    }
  }, [clearPendingGpuHistoryEntry, gpuHistoryEnabled]);

  useEffect(() => {
    const updateDevicePixelRatio = () => {
      const normalizedDpr = getSafeDevicePixelRatio(window);
      setDevicePixelRatio((prev) => {
        return Math.abs(prev - normalizedDpr) < 0.0001 ? prev : normalizedDpr;
      });
    };

    updateDevicePixelRatio();
    window.addEventListener('resize', updateDevicePixelRatio);
    window.visualViewport?.addEventListener('resize', updateDevicePixelRatio);

    return () => {
      window.removeEventListener('resize', updateDevicePixelRatio);
      window.visualViewport?.removeEventListener('resize', updateDevicePixelRatio);
    };
  }, []);

  // Tablet store: We use getState() directly in event handlers for real-time data
  // No need to subscribe to state changes here since we sync-read in handlers

  // Q1 Optimization: Use pointerrawupdate for lower-latency input (1-3ms improvement)
  const { usingRawInput } = useRawPointerInput({
    containerRef,
    canvasRef,
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

  useEffect(() => {
    layerRevisionMapRef.current = reconcileLayerRevisionMap(
      layerRevisionMapRef.current,
      layers.map((layer) => layer.id)
    );
  }, [layers]);

  const markLayerDirty = useCallback(
    (dirtyLayerIds?: string | string[]) => {
      const allLayerIds = layers.map((layer) => layer.id);
      const normalizedDirtyLayerIds =
        typeof dirtyLayerIds === 'string'
          ? [dirtyLayerIds]
          : Array.isArray(dirtyLayerIds)
            ? dirtyLayerIds
            : undefined;
      layerRevisionMapRef.current = bumpLayerRevisions({
        current: layerRevisionMapRef.current,
        allLayerIds,
        dirtyLayerIds: normalizedDirtyLayerIds,
      });
    },
    [layers]
  );

  const getLayerRevision = useCallback((layerId: string): number => {
    return layerRevisionMapRef.current.get(layerId) ?? 0;
  }, []);

  const getVisibleGpuRenderableLayers = useCallback((): GpuRenderableLayer[] => {
    return layers
      .filter((layer) => layer.visible)
      .map((layer) => ({
        id: layer.id,
        visible: layer.visible,
        opacity: layer.opacity,
        blendMode: layer.blendMode,
        revision: getLayerRevision(layer.id),
      }));
  }, [getLayerRevision, layers]);

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

  const syncGpuLayerTilesToCpu = useCallback(
    async (layerId: string, tiles: Array<{ x: number; y: number }>): Promise<boolean> => {
      if (tiles.length === 0) return false;

      const gpuRenderer = gpuRendererRef.current;
      const renderer = layerRendererRef.current;
      if (!gpuRenderer || !renderer) return false;

      const layer = renderer.getLayer(layerId);
      if (!layer) return false;

      try {
        await gpuRenderer.readbackTilesToLayer({
          layerId,
          tiles,
          targetCtx: layer.ctx,
        });

        const trackedTileKeys = pendingGpuCpuSyncTilesRef.current.get(layerId);
        if (trackedTileKeys) {
          for (const tile of tiles) {
            trackedTileKeys.delete(tileCoordKey(tile.x, tile.y));
          }
          if (trackedTileKeys.size === 0) {
            pendingGpuCpuSyncTilesRef.current.delete(layerId);
          }
        }
        return true;
      } catch (error) {
        console.warn('[NoReadback] Failed to sync GPU tiles to CPU layer', { layerId, error });
        return false;
      }
    },
    []
  );

  const syncGpuLayerToCpu = useCallback(
    async (layerId: string): Promise<boolean> => {
      const gpuRenderer = gpuRendererRef.current;
      const renderer = layerRendererRef.current;
      if (!gpuRenderer || !renderer) return false;

      const layer = renderer.getLayer(layerId);
      if (!layer) return false;

      const trackedTileKeys = pendingGpuCpuSyncTilesRef.current.get(layerId);
      if (!trackedTileKeys || trackedTileKeys.size === 0) return false;

      const tiles = parseTrackedTileCoordKeys(trackedTileKeys);
      if (tiles.length === 0) {
        pendingGpuCpuSyncTilesRef.current.delete(layerId);
        return false;
      }
      return syncGpuLayerTilesToCpu(layerId, tiles);
    },
    [syncGpuLayerTilesToCpu]
  );

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

  const schedulePendingGpuCpuSync = useCallback(
    (layerId: string) => {
      pendingGpuCpuSyncLayerRef.current = layerId;
      if (pendingGpuCpuSyncRafRef.current !== null) return;

      const run = async () => {
        pendingGpuCpuSyncRafRef.current = null;
        const targetLayerId = pendingGpuCpuSyncLayerRef.current;
        if (!targetLayerId) return;

        if (isDrawingRef.current) {
          pendingGpuCpuSyncRafRef.current = requestAnimationFrame(() => {
            void run();
          });
          return;
        }

        await syncGpuLayerToCpu(targetLayerId);
        const stillPending = pendingGpuCpuSyncTilesRef.current.get(targetLayerId);
        if (stillPending && stillPending.size > 0) {
          pendingGpuCpuSyncRafRef.current = requestAnimationFrame(() => {
            void run();
          });
        }
      };

      pendingGpuCpuSyncRafRef.current = requestAnimationFrame(() => {
        void run();
      });
    },
    [syncGpuLayerToCpu]
  );

  useEffect(() => {
    return () => {
      if (pendingGpuCpuSyncRafRef.current !== null) {
        cancelAnimationFrame(pendingGpuCpuSyncRafRef.current);
        pendingGpuCpuSyncRafRef.current = null;
      }
    };
  }, []);

  const getGpuBrushNoReadbackPilot = useCallback((): boolean => {
    return gpuCommitCoordinatorRef.current?.getReadbackMode() === 'disabled';
  }, []);

  const setGpuCommitReadbackMode = useCallback(
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

  const setGpuBrushNoReadbackPilot = useCallback(
    (enabled: boolean): boolean => {
      return setGpuCommitReadbackMode(enabled ? 'disabled' : 'enabled');
    },
    [setGpuCommitReadbackMode]
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
  const compositeAndRender = useCallback(
    (options?: CompositeRenderOptions) => {
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

      const clipRect = options?.clipRect ?? null;
      const movePreview = options?.movePreview ?? null;
      const normalizedRegion = clipRect
        ? (() => {
            const x = Math.max(0, Math.floor(clipRect.left));
            const y = Math.max(0, Math.floor(clipRect.top));
            const right = Math.min(docWidth, Math.ceil(clipRect.right));
            const bottom = Math.min(docHeight, Math.ceil(clipRect.bottom));
            const width = right - x;
            const height = bottom - y;
            if (width <= 0 || height <= 0) return null;
            return { x, y, width, height };
          })()
        : null;
      const normalizedMovePreviewRect = movePreview?.dirtyRect
        ? (() => {
            const x = Math.max(0, Math.floor(movePreview.dirtyRect.left));
            const y = Math.max(0, Math.floor(movePreview.dirtyRect.top));
            const right = Math.min(docWidth, Math.ceil(movePreview.dirtyRect.right));
            const bottom = Math.min(docHeight, Math.ceil(movePreview.dirtyRect.bottom));
            if (right <= x || bottom <= y) return null;
            return { left: x, top: y, right, bottom };
          })()
        : null;

      const useGpuPath =
        gpuDisplayActive &&
        !!gpuRendererRef.current &&
        !options?.forceCpu &&
        (normalizedRegion === null || !!movePreview);
      if (useGpuPath) {
        const gpuRenderer = gpuRendererRef.current;
        if (!gpuRenderer) return;
        const visibleGpuLayers = getVisibleGpuRenderableLayers();
        pendingMovePreviewRestoreRef.current = runGpuMovePreviewFrame({
          gpuRenderer,
          visibleLayers: visibleGpuLayers,
          movePreview: movePreview
            ? {
                layerId: movePreview.layerId,
                canvas: movePreview.canvas,
                dirtyRect: normalizedMovePreviewRect,
              }
            : null,
          pendingRestore: pendingMovePreviewRestoreRef.current,
          getLayerCanvas: (layerId: string) => renderer.getLayer(layerId)?.canvas ?? null,
          width: docWidth,
          height: docHeight,
          tileSize: GPU_TILE_SIZE,
          onRender: (layers) => {
            gpuRenderer.renderLayerStackFrame({
              layers,
              activeLayerId,
              scratchTexture: null,
              strokeOpacity: 1,
              compositeMode: 'paint',
              renderScale: getGpuRenderScale(),
            });
          },
        });
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, docWidth, docHeight);
        gpuCanvasClearedForCpuRef.current = false;
        return;
      }

      if (gpuDisplayActive && gpuRendererRef.current && !gpuCanvasClearedForCpuRef.current) {
        gpuRendererRef.current.renderLayerStackFrame({
          layers: [],
          activeLayerId: null,
          scratchTexture: null,
          strokeOpacity: 1,
          compositeMode: 'paint',
          renderScale: 1,
        });
        gpuCanvasClearedForCpuRef.current = true;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const movePreviewSource: LayerMovePreview | undefined = movePreview
        ? {
            activeLayerId: movePreview.layerId,
            canvas: movePreview.canvas,
          }
        : undefined;
      const compositeCanvas = renderer.composite(
        undefined,
        normalizedRegion ?? undefined,
        movePreviewSource
      );
      if (normalizedRegion) {
        ctx.clearRect(
          normalizedRegion.x,
          normalizedRegion.y,
          normalizedRegion.width,
          normalizedRegion.height
        );
        ctx.drawImage(
          compositeCanvas,
          normalizedRegion.x,
          normalizedRegion.y,
          normalizedRegion.width,
          normalizedRegion.height,
          normalizedRegion.x,
          normalizedRegion.y,
          normalizedRegion.width,
          normalizedRegion.height
        );
        return;
      }

      ctx.clearRect(0, 0, docWidth, docHeight);
      ctx.drawImage(compositeCanvas, 0, 0);
    },
    [activeLayerId, getGpuRenderScale, getVisibleGpuRenderableLayers, gpuDisplayActive]
  );

  const beginGpuStrokeHistory = useCallback(
    (layerId: string): { entryId: string; snapshotMode: 'cpu' | 'gpu' } | null => {
      if (!gpuHistoryEnabled) {
        clearPendingGpuHistoryEntry();
        return null;
      }

      const historyStore = gpuStrokeHistoryStoreRef.current;
      if (!historyStore) {
        clearPendingGpuHistoryEntry();
        return null;
      }

      const entryId = createHistoryEntryId();
      const snapshotMode = historyStore.beginStroke(entryId, layerId);
      pendingGpuHistoryEntryIdRef.current = snapshotMode === 'gpu' ? entryId : null;
      return { entryId, snapshotMode };
    },
    [clearPendingGpuHistoryEntry, gpuHistoryEnabled]
  );

  const applyGpuStrokeHistory = useCallback(
    async (entryId: string, direction: 'undo' | 'redo', layerId: string): Promise<boolean> => {
      const historyStore = gpuStrokeHistoryStoreRef.current;
      const gpuRenderer = gpuRendererRef.current;
      if (!historyStore || !gpuRenderer) return false;

      const applyPayload = historyStore.apply(entryId, direction);
      if (!applyPayload || applyPayload.layerId !== layerId) {
        return false;
      }

      try {
        const appliedTiles = gpuRenderer.applyHistoryTiles({
          layerId: applyPayload.layerId,
          tiles: applyPayload.tiles,
        });
        if (appliedTiles.length === 0) return false;

        await syncGpuLayerTilesToCpu(applyPayload.layerId, appliedTiles);
        return true;
      } catch (error) {
        console.warn('[GpuStrokeHistory] Failed to apply history snapshot', {
          entryId,
          direction,
          layerId,
          error,
        });
        return false;
      }
    },
    [syncGpuLayerTilesToCpu]
  );

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
    handleCopyActiveLayerImage,
    handlePasteImageAsNewLayer,
    handleImportImageFiles,
    handleDuplicateActiveLayer,
    handleRemoveLayer,
    handleRemoveLayers,
    handleMergeSelectedLayers,
    handleMergeAllLayers,
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
    gpuHistoryEnabled,
    beginGpuStrokeHistory,
    applyGpuStrokeHistory,
    onBeforeCanvasMutation,
  });

  const {
    handleMovePointerDown,
    handleMovePointerMove,
    handleMovePointerUp,
    finalizeFloatingSelectionSession,
    hasFloatingSelectionSession,
  } = useMoveTool({
    layerRendererRef,
    currentTool,
    layers,
    activeLayerId,
    width,
    height,
    setActiveLayer,
    syncAllPendingGpuLayersToCpu,
    captureBeforeImage,
    saveStrokeToHistory,
    markLayerDirty,
    compositeAndRender,
    updateThumbnail,
    getVisibleCanvasRect: () => {
      const container = containerRef.current;
      if (!container || displayScale <= 0) return null;
      const rect = container.getBoundingClientRect();
      const left = Math.max(0, -offsetX / displayScale);
      const top = Math.max(0, -offsetY / displayScale);
      const right = Math.min(width, (rect.width - offsetX) / displayScale);
      const bottom = Math.min(height, (rect.height - offsetY) / displayScale);
      if (left >= right || top >= bottom) return null;
      return { left, top, right, bottom };
    },
  });
  finalizeFloatingSelectionSessionRef.current = finalizeFloatingSelectionSession;
  hasFloatingSelectionSessionRef.current = hasFloatingSelectionSession;

  const renderGpuFrame = useCallback(
    (showScratch: boolean) => {
      const gpuRenderer = gpuRendererRef.current;
      const renderer = layerRendererRef.current;
      if (!gpuRenderer || !renderer) return;

      const visibleGpuLayers = getVisibleGpuRenderableLayers();
      for (const visibleLayer of visibleGpuLayers) {
        const layer = renderer.getLayer(visibleLayer.id);
        if (!layer) continue;
        gpuRenderer.syncLayerFromCanvas(visibleLayer.id, layer.canvas, visibleLayer.revision);
      }

      const scratchHandle = showScratch ? getScratchHandle() : null;
      const strokeOpacity = showScratch ? getPreviewOpacity() : 1;
      const strokeCompositeMode = showScratch ? getPreviewCompositeMode() : 'paint';

      gpuRenderer.renderLayerStackFrame({
        layers: visibleGpuLayers,
        activeLayerId,
        scratchTexture: showScratch ? (scratchHandle?.texture ?? null) : null,
        strokeOpacity: showScratch ? strokeOpacity : 1,
        compositeMode: showScratch ? strokeCompositeMode : 'paint',
        renderScale: showScratch ? (scratchHandle?.renderScale ?? getGpuRenderScale()) : 1,
      });
    },
    [
      activeLayerId,
      getScratchHandle,
      getPreviewOpacity,
      getPreviewCompositeMode,
      getGpuRenderScale,
      getVisibleGpuRenderableLayers,
    ]
  );

  const commitStrokeGpu = useCallback(async (): Promise<GpuStrokeCommitResult> => {
    const coordinator = gpuCommitCoordinatorRef.current;
    if (!coordinator) {
      clearPendingGpuHistoryEntry();
      return {
        committed: false,
        dirtyRect: null,
        dirtyTiles: [],
        timings: { prepareMs: 0, commitMs: 0, readbackMs: 0 },
      };
    }
    const historyStore = gpuStrokeHistoryStoreRef.current;
    const historyEntryId = pendingGpuHistoryEntryIdRef.current;
    const commitOptions =
      historyStore && historyEntryId
        ? {
            historyEntryId,
            historyStore,
          }
        : undefined;

    let result: GpuStrokeCommitResult;
    try {
      result = await coordinator.commit(activeLayerId, commitOptions);
    } finally {
      clearPendingGpuHistoryEntry();
    }
    if (
      activeLayerId &&
      result.dirtyTiles.length > 0 &&
      coordinator.getReadbackMode() === 'disabled'
    ) {
      trackPendingGpuCpuSyncTiles(activeLayerId, result.dirtyTiles);
      schedulePendingGpuCpuSync(activeLayerId);
    }
    return result;
  }, [
    activeLayerId,
    clearPendingGpuHistoryEntry,
    trackPendingGpuCpuSyncTiles,
    schedulePendingGpuCpuSync,
  ]);

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

  const getGpuLayerStackCacheStats = useCallback(() => {
    return gpuRendererRef.current?.getLayerStackCacheStats() ?? null;
  }, []);

  const getGpuBrushCommitReadbackMode = useCallback((): GpuBrushCommitReadbackMode => {
    return gpuCommitCoordinatorRef.current?.getReadbackMode() ?? 'enabled';
  }, []);

  const setGpuBrushCommitReadbackMode = useCallback(
    (mode: GpuBrushCommitReadbackMode): boolean => {
      return setGpuCommitReadbackMode(mode);
    },
    [setGpuCommitReadbackMode]
  );

  const sampleGpuPixelColor = useCallback(
    async (canvasX: number, canvasY: number): Promise<string | null> => {
      const renderer = layerRendererRef.current;
      if (!renderer) return null;

      // Eyedropper must sample what is currently visible; sync pending no-readback tiles first.
      await syncAllPendingGpuLayersToCpu();

      const x = Math.floor(canvasX);
      const y = Math.floor(canvasY);
      if (x < 0 || x >= width || y < 0 || y >= height) return null;

      const compositeCanvas = renderer.composite();
      const ctx = compositeCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;

      const pixel = ctx.getImageData(x, y, 1, 1).data;
      const alpha = pixel[3] ?? 0;
      if (alpha <= 0) return null;

      const r = pixel[0] ?? 0;
      const g = pixel[1] ?? 0;
      const b = pixel[2] ?? 0;
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
        .toString(16)
        .padStart(2, '0')}`;
    },
    [height, syncAllPendingGpuLayersToCpu, width]
  );

  useEffect(() => {
    const prevActive = prevGpuDisplayActiveRef.current;
    const prevLayerId = prevGpuDisplayLayerIdRef.current;
    if (prevActive && prevLayerId && (!gpuDisplayActive || prevLayerId !== activeLayerId)) {
      if (!gpuDisplayActive) {
        setKeepGpuCanvasVisible(true);
      }
      void (async () => {
        try {
          const synced = await syncGpuLayerToCpu(prevLayerId);
          if (synced && !gpuDisplayActive) {
            compositeAndRender();
          }
        } finally {
          if (!gpuDisplayActive) {
            setKeepGpuCanvasVisible(false);
          }
        }
      })();
    }
    if (gpuDisplayActive) {
      setKeepGpuCanvasVisible(false);
    }
    prevGpuDisplayActiveRef.current = gpuDisplayActive;
    prevGpuDisplayLayerIdRef.current = activeLayerId;
  }, [gpuDisplayActive, activeLayerId, syncGpuLayerToCpu, compositeAndRender]);

  const showGpuCanvas = gpuDisplayActive || keepGpuCanvasVisible;

  const exportGpuLayerImageData = useCallback(
    async (layerId: string): Promise<ImageData | null> => {
      const gpuRenderer = gpuRendererRef.current;
      if (!gpuRenderer || !gpuDisplayActive) return null;
      return gpuRenderer.readbackLayerExport({
        layerId,
        chunkSize: 2048,
      });
    },
    [gpuDisplayActive]
  );

  const exportGpuFlattenedImageData = useCallback(async (): Promise<ImageData | null> => {
    const gpuRenderer = gpuRendererRef.current;
    if (!gpuRenderer || !gpuDisplayActive) return null;
    return gpuRenderer.readbackFlattenedExport({
      layers: getVisibleGpuRenderableLayers(),
      chunkSize: 2048,
    });
  }, [getVisibleGpuRenderableLayers, gpuDisplayActive]);

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
    handleRemoveLayers,
    handleMergeSelectedLayers: (ids?: string[]) => {
      const selectedIds =
        ids && ids.length > 0 ? ids : useDocumentStore.getState().selectedLayerIds;
      return handleMergeSelectedLayers(selectedIds);
    },
    handleMergeAllLayers,
    handleResizeCanvas,
    getGpuDiagnosticsSnapshot,
    resetGpuDiagnostics,
    getGpuLayerStackCacheStats,
    getGpuBrushCommitMetricsSnapshot,
    resetGpuBrushCommitMetrics,
    getGpuBrushCommitReadbackMode,
    setGpuBrushCommitReadbackMode,
    getGpuBrushNoReadbackPilot,
    setGpuBrushNoReadbackPilot,
    markGpuLayerDirty: markLayerDirty,
    exportGpuLayerImageData,
    exportGpuFlattenedImageData,
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
    const activeLayer = activeLayerId ? layers.find((layer) => layer.id === activeLayerId) : null;
    const isBackgroundLayer = activeLayer?.isBackground === true;
    const isEraser = currentTool === 'eraser';
    const shouldPaintBackgroundColor =
      isEraser && isBackgroundLayer && eraserBackgroundMode === 'background-color';

    let strokeCompositeMode: 'paint' | 'erase' = 'paint';
    let strokeColor = brushColor;
    if (isEraser) {
      strokeCompositeMode = shouldPaintBackgroundColor ? 'paint' : 'erase';
      strokeColor = shouldPaintBackgroundColor ? backgroundFillColor : brushColor;
    }

    return {
      size: currentSize,
      flow: brushFlow,
      opacity: brushOpacity,
      hardness: brushHardness,
      maskType: brushMaskType,
      spacing: brushSpacing,
      roundness: brushRoundness,
      angle: brushAngle,
      color: strokeColor,
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
      strokeCompositeMode,
      selectionHandledByGpu:
        gpuDisplayActive &&
        gpuSelectionPipelineV2Enabled &&
        !selectionMaskPending &&
        (!hasSelection || !!selectionMask),
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
    backgroundFillColor,
    backgroundColor,
    currentTool,
    eraserBackgroundMode,
    activeLayerId,
    layers,
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
    gpuDisplayActive,
    gpuSelectionPipelineV2Enabled,
    hasSelection,
    selectionMask,
    selectionMaskPending,
  ]);

  const { finishCurrentStroke, initializeBrushStroke } = useStrokeProcessor({
    canvasRef,
    layerRendererRef,
    width,
    height,
    scale: displayScale,
    activeLayerId,
    currentTool,
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
    getPreviewCompositeMode,
    isStrokeActive,
    getLastDabPosition,
    getDebugRects,
    flushPending,
    compositeAndRender,
    saveStrokeToHistory,
    updateThumbnail,
  });

  const previousLineToolRef = useRef<ToolType | null>(currentTool);

  useEffect(() => {
    const prevTool = previousLineToolRef.current;
    if (isLineTool(prevTool) && !isLineTool(currentTool) && isDrawingRef.current) {
      void finishCurrentStroke();
    }
    previousLineToolRef.current = currentTool;
  }, [currentTool, finishCurrentStroke]);

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
    onBeforeSelectionMutation,
    handleDuplicateActiveLayer,
    handleCopyImage: handleCopyActiveLayerImage,
    handleCreateLayer: () => {
      const doc = useDocumentStore.getState();
      doc.addLayer({ name: `Layer ${doc.layers.length + 1}`, type: 'raster' });
    },
    handleMergeSelectedLayers: () => {
      const selectedIds = useDocumentStore.getState().selectedLayerIds;
      handleMergeSelectedLayers(selectedIds);
    },
    handleMergeAllLayers,
  });

  const resolveImportAnchorPoint = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        return null;
      }

      const point = clientToCanvasPoint(canvas, clientX, clientY);
      const maxX = Math.max(0, width - 1);
      const maxY = Math.max(0, height - 1);
      return {
        x: clampNumber(Math.round(point.x), 0, maxX),
        y: clampNumber(Math.round(point.y), 0, maxY),
      };
    },
    [height, width]
  );

  useEffect(() => {
    const handlePointerTracking = (event: PointerEvent): void => {
      lastPointerClientPosRef.current = { x: event.clientX, y: event.clientY };
    };

    window.addEventListener('pointermove', handlePointerTracking, { passive: true });
    window.addEventListener('pointerdown', handlePointerTracking, { passive: true });
    return () => {
      window.removeEventListener('pointermove', handlePointerTracking);
      window.removeEventListener('pointerdown', handlePointerTracking);
    };
  }, []);

  useEffect(() => {
    const hasFilePayload = (event: DragEvent): boolean => {
      const types = event.dataTransfer?.types;
      if (!types) return false;
      return Array.from(types).includes('Files');
    };

    const handleWindowDragOver = (event: DragEvent): void => {
      if (!hasFilePayload(event)) return;
      event.preventDefault();
    };

    const handleWindowDrop = (event: DragEvent): void => {
      if (!hasFilePayload(event)) return;
      event.preventDefault();
      const droppedFiles = Array.from(event.dataTransfer?.files ?? []);
      if (droppedFiles.length === 0) return;
      const anchorPoint = resolveImportAnchorPoint(event.clientX, event.clientY);
      void handleImportImageFiles(droppedFiles, { anchorPoint });
    };

    const handleWindowPaste = (event: ClipboardEvent): void => {
      if (isEditableTarget(event.target)) return;

      event.preventDefault();
      const lastPointer = lastPointerClientPosRef.current;
      const anchorPoint = lastPointer
        ? resolveImportAnchorPoint(lastPointer.x, lastPointer.y)
        : null;
      void handlePasteImageAsNewLayer({
        clipboardData: event.clipboardData,
        anchorPoint,
        allowSystemClipboardRead: false,
      });
    };

    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('drop', handleWindowDrop);
    window.addEventListener('paste', handleWindowPaste);
    return () => {
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('drop', handleWindowDrop);
      window.removeEventListener('paste', handleWindowPaste);
    };
  }, [handleImportImageFiles, handlePasteImageAsNewLayer, resolveImportAnchorPoint]);

  const { cursorStyle, showDomCursor, showEyedropperDomCursor } = useCursor({
    currentTool,
    currentSize,
    scale: displayScale,
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
    useGpuDisplay: gpuDisplayActive,
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
  });

  const closeBrushQuickPanel = useCallback(() => {
    setBrushQuickPanelOpen(false);
    setBrushQuickPanelHovering(false);
  }, []);

  const openBrushQuickPanel = useCallback((x: number, y: number) => {
    setBrushQuickPanelAnchor({ x, y });
    setBrushQuickPanelOpen(true);
  }, []);

  useEffect(() => {
    if (isBrushQuickPanelTool) return;
    setBrushQuickPanelOpen(false);
  }, [isBrushQuickPanelTool]);

  const handleCanvasPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (isBrushQuickPanelTool && e.button === 2) {
        e.preventDefault();
        openBrushQuickPanel(e.clientX, e.clientY);
        return;
      }

      if (brushQuickPanelOpen && e.button === 0) {
        closeBrushQuickPanel();
      }

      handlePointerDown(e);
    },
    [
      isBrushQuickPanelTool,
      brushQuickPanelOpen,
      openBrushQuickPanel,
      closeBrushQuickPanel,
      handlePointerDown,
    ]
  );

  const handleCanvasContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isBrushQuickPanelTool) return;
      e.preventDefault();
    },
    [isBrushQuickPanelTool]
  );

  // 计算 viewport 变换样式
  const viewportStyle: React.CSSProperties = {
    transform: `translate(${offsetX}px, ${offsetY}px) scale(${displayScale})`,
    transformOrigin: '0 0',
  };

  // Calculate clip-path for checkerboard
  const x = offsetX;
  const y = offsetY;
  const w = width * displayScale;
  const h = height * displayScale;
  const clipPathKey = `polygon(${x}px ${y}px, ${x + w}px ${y}px, ${x + w}px ${y + h}px, ${x}px ${y + h}px)`;

  return (
    <div
      ref={containerRef}
      className="canvas-container"
      tabIndex={-1}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onContextMenu={handleCanvasContextMenu}
      // Note: onPointerEnter cursor handling is done by native event listener
      style={{ cursor: cursorStyle }}
    >
      <div className="canvas-checkerboard" style={{ clipPath: clipPathKey }} />
      <SelectionOverlay scale={displayScale} offsetX={offsetX} offsetY={offsetY} />
      <div className="canvas-viewport" style={viewportStyle}>
        <canvas
          ref={gpuCanvasRef}
          width={width}
          height={height}
          className="gpu-canvas"
          data-testid="gpu-canvas"
          style={{ display: showGpuCanvas ? 'block' : 'none' }}
        />
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          className="main-canvas"
          data-testid="main-canvas"
        />
      </div>
      {showDomCursor && !brushQuickPanelHovering && (
        <div
          ref={brushCursorRef}
          className={`brush-cursor ${brushTexture?.cursorPath ? 'brush-cursor--texture' : ''}`}
          style={{
            width: currentSize * displayScale,
            height: currentSize * displayScale * (brushRoundness / 100),
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
      {showEyedropperDomCursor && !brushQuickPanelHovering && (
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
      <BrushQuickPanel
        isOpen={brushQuickPanelOpen}
        anchorX={brushQuickPanelAnchor.x}
        anchorY={brushQuickPanelAnchor.y}
        onRequestClose={closeBrushQuickPanel}
        onHoveringChange={setBrushQuickPanelHovering}
      />
    </div>
  );
}
