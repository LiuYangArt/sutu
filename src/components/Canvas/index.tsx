import React, { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { LOCKED_NOISE_SETTINGS, useToolStore, ToolType } from '@/stores/tool';
import {
  useSelectionStore,
  type SelectionMode,
  type SelectionPoint,
  type SelectionSnapshot,
} from '@/stores/selection';
import { useDocumentStore } from '@/stores/document';
import { useViewportStore } from '@/stores/viewport';
import { createHistoryEntryId, type HistoryEntry, useHistoryStore } from '@/stores/history';
import { useSettingsStore } from '@/stores/settings';
import { useTabletStore } from '@/stores/tablet';
import { usePanelStore } from '@/stores/panel';
import { useSelectionHandler } from './useSelectionHandler';
import { useCursor } from './useCursor';
import { useBrushRenderer, BrushRenderConfig } from './useBrushRenderer';
import { useRawPointerInput } from './useRawPointerInput';
import { useAltEyedropper } from './useAltEyedropper';
import { useShiftLineMode } from './useShiftLineMode';
import {
  useLayerOperations,
  type ApplyGpuSelectionFillToActiveLayerParams,
  type ApplyGradientToActiveLayerParams,
} from './useLayerOperations';
import { useMoveTool } from './useMoveTool';
import { useGlobalExports } from './useGlobalExports';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { usePointerHandlers } from './usePointerHandlers';
import { useStrokeProcessor } from './useStrokeProcessor';
import { useGradientTool, type GradientPreviewPayload } from './useGradientTool';
import { SelectionOverlay } from './SelectionOverlay';
import { BrushQuickPanel } from './BrushQuickPanel';
import { clientToCanvasPoint, getDisplayScale, getSafeDevicePixelRatio } from './canvasGeometry';
import { isNativeTabletStreamingBackend } from './inputUtils';
import { LatencyProfiler } from '@/benchmark/LatencyProfiler';
import { LagometerMonitor } from '@/benchmark/LagometerMonitor';
import { FPSCounter } from '@/benchmark/FPSCounter';
import { LayerRenderer, type LayerMovePreview } from '@/utils/layerRenderer';
import type { Rect, StrokeFinalizeDebugSnapshot } from '@/utils/strokeBuffer';
import type {
  StrokeCaptureController,
  StrokeCaptureData,
  StrokeReplayOptions,
} from '@/test/StrokeCapture';
import type {
  FixedStrokeCaptureLoadResult,
  FixedStrokeCaptureSaveResult,
} from '@/test/strokeCaptureFixedFile';
import {
  GPUContext,
  GpuCanvasRenderer,
  GpuStrokeCommitCoordinator,
  GpuStrokeHistoryStore,
  loadResidencyBudget,
  type GpuCurvesRenderParams,
  type GpuRenderableLayer,
  type GpuGradientRenderParams,
  type GpuBrushCommitReadbackMode,
  type GpuBrushCommitMetricsSnapshot,
  type GpuStrokeCommitResult,
} from '@/gpu';
import type {
  CurvesCommitRequest,
  CurvesCommitResult,
  CurvesHistogramByChannel,
  CurvesPreviewPayload,
  CurvesPreviewResult,
  CurvesRuntimeError,
  CurvesSessionInfo,
} from '@/types/curves';
import {
  applyCurvesToImageData,
  computeHistogramsByChannel,
  curvesPayloadToLuts,
} from '@/utils/curvesRenderer';
import {
  bumpLayerRevisions,
  isGpuCurvesPathAvailable,
  isGpuHistoryPathAvailable,
  isGpuLayerStackPathAvailable,
  reconcileLayerRevisionMap,
} from './gpuLayerStackPolicy';
import { runGpuMovePreviewFrame } from './movePreviewGpuSync';
import { buildPressureCurveLut } from '@/utils/pressureCurve';

import './Canvas.css';

const MIN_GRADIENT_GUIDE_SCALE = 0.0001;

function strokeGradientGuideLine(
  ctx: CanvasRenderingContext2D,
  start: { x: number; y: number },
  end: { x: number; y: number },
  color: string,
  width: number
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
}

function strokeGradientGuideCircle(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  radius: number,
  color: string,
  width: number
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.stroke();
}

function drawGradientGuideOverlay(
  ctx: CanvasRenderingContext2D,
  guide: NonNullable<GradientPreviewPayload['guide']>,
  displayScale: number
): void {
  const safeScale = Math.max(displayScale, MIN_GRADIENT_GUIDE_SCALE);
  const lineOuterWidth = 3 / safeScale;
  const lineInnerWidth = 1.5 / safeScale;
  const anchorRadius = 4.5 / safeScale;
  const anchorCoreRadius = 1.6 / safeScale;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  strokeGradientGuideLine(ctx, guide.start, guide.end, 'rgba(255, 255, 255, 0.95)', lineOuterWidth);
  strokeGradientGuideLine(ctx, guide.start, guide.end, 'rgba(0, 0, 0, 0.9)', lineInnerWidth);

  if (guide.showAnchor) {
    strokeGradientGuideCircle(
      ctx,
      guide.start,
      anchorRadius,
      'rgba(255, 255, 255, 0.95)',
      lineOuterWidth
    );
    strokeGradientGuideCircle(ctx, guide.start, anchorRadius, 'rgba(0, 0, 0, 0.9)', lineInnerWidth);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.beginPath();
    ctx.arc(guide.start.x, guide.start.y, anchorCoreRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

declare global {
  interface Window {
    __canvasFillLayer?: (color: string) => void;
    __canvasClearSelection?: () => void;
    __canvasClearLayer?: () => void;
    __getLayerImageData?: (layerId: string) => Promise<string | undefined>;
    __getLayerImageBytes?: (layerId: string) => Promise<number[] | undefined>;
    __getFlattenedImage?: () => Promise<string | undefined>;
    __getFlattenedImageBytes?: () => Promise<number[] | undefined>;
    __getThumbnail?: () => Promise<string | undefined>;
    __getThumbnailBytes?: () => Promise<number[] | undefined>;
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
    __kritaPressureFullGate?: (options?: {
      capture?: StrokeCaptureData | string;
      baselineVersion?: string;
      thresholdVersion?: string;
    }) => Promise<{
      overall: 'pass' | 'fail';
      stage_gate: 'pass' | 'fail';
      final_gate: 'pass' | 'fail';
      fast_gate: 'pass' | 'fail';
      blocking_failures: string[];
      run_meta: { run_id: string };
    }>;
    __tabletInputTraceGet?: () => boolean;
    __tabletInputTraceSet?: (enabled: boolean) => Promise<{
      frontendEnabled: boolean;
      backendEnabled: boolean;
      traceFile: { baseDir: 'AppConfig'; relativePath: string };
    }>;
    __tabletInputTraceEnabled?: boolean;
    __gpuSelectionPipelineV2?: () => boolean;
    __gpuSelectionPipelineV2Set?: (enabled: boolean) => boolean;
    __brushTailTaperDebug?: () => StrokeFinalizeDebugSnapshot | null;
    __brushStrokeFinalizeDebug?: () => StrokeFinalizeDebugSnapshot | null;
    __canvasCurvesBeginSession?: () => CurvesSessionInfo | null;
    __canvasCurvesPreview?: (
      sessionId: string,
      payload: CurvesPreviewPayload
    ) => CurvesPreviewResult;
    __canvasCurvesCommit?: (
      sessionId: string,
      payload: CurvesPreviewPayload,
      request?: CurvesCommitRequest
    ) => Promise<CurvesCommitResult>;
    __canvasCurvesCancel?: (sessionId: string) => void;
    __strokeDiagnostics?: {
      onPointBuffered: () => void;
      onStrokeStart: () => void;
      onStrokeEnd: () => void;
      onStateChange: (state: string) => void;
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
  timestampMs: number;
  source: 'wintab' | 'macnative' | 'pointerevent';
  phase: 'down' | 'move' | 'up' | 'hover';
  hostTimeUs: number;
  deviceTimeUs: number;
  pointIndex: number;
};

const GPU_TILE_SIZE = 512;
const GPU_LAYER_FORMAT: GPUTextureFormat = 'rgba8unorm';
const MIN_GPU_HISTORY_BUDGET_BYTES = 256 * 1024 * 1024;
const MAX_GPU_HISTORY_BUDGET_BYTES = 1024 * 1024 * 1024;
const GPU_HISTORY_BUDGET_RATIO = 0.2;
const ENABLE_GPU_CURVES = true;

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

interface PendingSelectionAutoFillPreview {
  path: SelectionPoint[];
  color: string;
  startedAt: number;
}

interface CurvesSessionState {
  sessionId: string;
  layerId: string;
  renderMode: 'gpu' | 'cpu';
  baseImageData: ImageData;
  selectionMask: ImageData | null;
  selectionBounds: { x: number; y: number; width: number; height: number } | null;
  histogram: number[];
  histogramByChannel: CurvesHistogramByChannel;
  previewCanvas: HTMLCanvasElement;
  previewRafId: number | null;
  pendingPayload: CurvesPreviewPayload | null;
  gpuError: CurvesRuntimeError | null;
  previewHalted: boolean;
  lastPreviewResult: CurvesPreviewResult;
}

function cloneCurvesSessionImageData(imageData: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
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

function errorDetailText(error: unknown): string | undefined {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function createCurvesRuntimeError(args: {
  code: CurvesRuntimeError['code'];
  stage: CurvesRuntimeError['stage'];
  message: string;
  error?: unknown;
}): CurvesRuntimeError {
  return {
    code: args.code,
    stage: args.stage,
    message: args.message,
    detail: args.error === undefined ? undefined : errorDetailText(args.error),
  };
}

function createCurvesSessionInvalidPreviewResult(): CurvesPreviewResult {
  return {
    ok: false,
    renderMode: 'cpu',
    halted: true,
    error: {
      code: 'SESSION_INVALID',
      stage: 'preview',
      message: '曲线会话不存在或已失效。',
    },
  };
}

function createCurvesSessionInvalidCommitResult(): CurvesCommitResult {
  return {
    ok: false,
    canForceCpuCommit: false,
    error: {
      code: 'SESSION_INVALID',
      stage: 'commit',
      message: '曲线会话不存在或已失效。',
    },
  };
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

function resolveSelectionDirtyRect(
  width: number,
  height: number,
  selectionBounds: { x: number; y: number; width: number; height: number } | null
): Rect {
  if (!selectionBounds) {
    return { left: 0, top: 0, right: width, bottom: height };
  }
  const left = Math.max(0, Math.floor(selectionBounds.x));
  const top = Math.max(0, Math.floor(selectionBounds.y));
  const right = Math.min(width, Math.ceil(selectionBounds.x + selectionBounds.width));
  const bottom = Math.min(height, Math.ceil(selectionBounds.y + selectionBounds.height));
  if (right <= left || bottom <= top) {
    return { left: 0, top: 0, right: width, bottom: height };
  }
  return { left, top, right, bottom };
}

export function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gpuCanvasRef = useRef<HTMLCanvasElement>(null);
  const gradientPreviewCanvasRef = useRef<HTMLCanvasElement>(null);
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
  const curvesSessionRef = useRef<CurvesSessionState | null>(null);
  const disposeCurvesSessionOnUnmountRef = useRef<() => void>(() => {});
  const finalizeFloatingSelectionSessionRef = useRef<(reason?: string) => void>(() => undefined);
  const hasFloatingSelectionSessionRef = useRef<() => boolean>(() => false);
  const commitSelectionFillGpuRef = useRef<
    ((params: ApplyGpuSelectionFillToActiveLayerParams) => Promise<boolean>) | null
  >(null);
  const [keepGpuCanvasVisible, setKeepGpuCanvasVisible] = useState(false);
  const [gpuSelectionPipelineV2Enabled, setGpuSelectionPipelineV2Enabled] = useState(true);
  const [devicePixelRatio, setDevicePixelRatio] = useState(() =>
    getSafeDevicePixelRatio(typeof window === 'undefined' ? undefined : window)
  );
  const [brushQuickPanelOpen, setBrushQuickPanelOpen] = useState(false);
  const [brushQuickPanelAnchor, setBrushQuickPanelAnchor] = useState({ x: 0, y: 0 });
  const [brushQuickPanelHovering, setBrushQuickPanelHovering] = useState(false);
  const [pendingSelectionAutoFillPreview, setPendingSelectionAutoFillPreview] =
    useState<PendingSelectionAutoFillPreview | null>(null);

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
    brush: { renderMode, forceDomCursorDebug },
    general: { selectionAutoFillEnabled },
    tablet: {
      pressureCurvePoints,
      maxBrushSpeedPxPerMs,
      brushSpeedSmoothingSamples,
      lowPressureAdaptiveSmoothingEnabled,
    },
  } = useSettingsStore();
  const globalPressureLut = useMemo(
    () => buildPressureCurveLut(pressureCurvePoints),
    [pressureCurvePoints]
  );

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
  const openPanel = usePanelStore((s) => s.openPanel);
  const togglePanel = usePanelStore((s) => s.togglePanel);

  const { isPanning, scale, setScale, setIsPanning, pan, zoomIn, zoomOut, offsetX, offsetY } =
    useViewportStore();
  const displayScale = useMemo(
    () => getDisplayScale(scale, devicePixelRatio),
    [scale, devicePixelRatio]
  );

  useEffect(() => {
    let disposed = false;

    const setupStrokeCapture = async () => {
      if (strokeCaptureRef.current) return;
      try {
        const { StrokeCaptureController } = await import('@/test/StrokeCapture');
        if (disposed || strokeCaptureRef.current) return;
        strokeCaptureRef.current = new StrokeCaptureController({
          getCanvas: () => canvasRef.current,
          getCaptureRoot: () => containerRef.current,
          getScale: () => useViewportStore.getState().scale,
          getLiveInputOverride: (event) => {
            // Native tablet backend can report richer pressure/tilt than raw PointerEvent.
            // For recording/replay fidelity, capture pressure/tilt from tablet stream when available.
            if (!event.isTrusted) return null;
            if (event.type !== 'pointerdown' && event.type !== 'pointermove') return null;

            const tablet = useTabletStore.getState();
            const activeBackend =
              typeof tablet.activeBackend === 'string' && tablet.activeBackend.length > 0
                ? tablet.activeBackend
                : tablet.backend;
            const isNativeBackendActive =
              tablet.isStreaming && isNativeTabletStreamingBackend(activeBackend);
            if (!isNativeBackendActive) return null;

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
            const { texture: _ignoredDualTexture, ...dualBrushWithoutTexture } =
              toolState.dualBrush;
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
                brushMaskType: toolState.brushMaskType,
                brushRoundness: toolState.brushRoundness,
                brushAngle: toolState.brushAngle,
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
                noiseSettings: {
                  size: LOCKED_NOISE_SETTINGS.size,
                  sizeJitter: LOCKED_NOISE_SETTINGS.sizeJitter,
                  densityJitter: LOCKED_NOISE_SETTINGS.densityJitter,
                },
                buildupEnabled: toolState.buildupEnabled,
              },
            };
          },
        });
      } catch (error) {
        console.warn('[StrokeCapture] Failed to initialize controller', error);
      }
    };

    void setupStrokeCapture();

    return () => {
      disposed = true;
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

  const clearPendingSelectionAutoFillPreview = useCallback(() => {
    setPendingSelectionAutoFillPreview(null);
  }, []);

  const latchPendingSelectionAutoFillPreview = useCallback(
    (path: SelectionPoint[]): void => {
      if (!selectionAutoFillEnabled) return;
      setPendingSelectionAutoFillPreview({
        path: path.map((point) => ({ ...point })),
        color: brushColor,
        startedAt: performance.now(),
      });
    },
    [brushColor, selectionAutoFillEnabled]
  );

  // Get selection store actions for keyboard shortcuts
  const { selectAll, deselectAll, cancelSelection } = useSelectionStore();
  const hasSelection = useSelectionStore((s) => s.hasSelection);
  const isCreatingSelection = useSelectionStore((s) => s.isCreating);
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
    getStrokeFinalizeDebugSnapshot,
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

  const gpuCurvesPathAvailable = useMemo(
    () =>
      isGpuCurvesPathAvailable({
        gpuAvailable,
        layers: layers.map((layer) => ({ visible: layer.visible, blendMode: layer.blendMode })),
      }),
    [gpuAvailable, layers]
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
      if (curvesSessionRef.current) return;
      gpuRendererRef.current.setSelectionMask(selectionMask ?? null);
    }
  }, [selectionMask]);

  useEffect(() => {
    if (selectionAutoFillEnabled) return;
    clearPendingSelectionAutoFillPreview();
  }, [clearPendingSelectionAutoFillPreview, selectionAutoFillEnabled]);

  useEffect(() => {
    if (currentTool === 'select' || currentTool === 'lasso') return;
    clearPendingSelectionAutoFillPreview();
  }, [clearPendingSelectionAutoFillPreview, currentTool]);

  useEffect(() => {
    if (hasSelection || isCreatingSelection) return;
    clearPendingSelectionAutoFillPreview();
  }, [
    clearPendingSelectionAutoFillPreview,
    hasSelection,
    isCreatingSelection,
    pendingSelectionAutoFillPreview,
  ]);

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
    getCapturedStrokeHistoryMeta,
    saveStrokeToHistory,
    discardCapturedStrokeHistory,
    fillActiveLayer,
    applySelectionAutoFillToActiveLayer,
    applyGradientToActiveLayer,
    handleClearSelection,
    handleUndo,
    handleRedo,
    jumpToHistoryIndex,
    handleClearLayer,
    handleDuplicateLayer,
    handleCopyActiveLayerImage,
    handlePasteImageAsNewLayer,
    handleImportImageFiles,
    handleSetLayerOpacity,
    handleSetLayerBlendMode,
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
    applyGpuSelectionFillToActiveLayer: async (params) => {
      const commit = commitSelectionFillGpuRef.current;
      if (!commit) return false;
      return commit(params);
    },
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

  const handleSelectionCommitted = useCallback(
    async ({
      before,
      after,
      mode: _mode,
    }: {
      before: SelectionSnapshot;
      after: SelectionSnapshot;
      mode: SelectionMode;
    }): Promise<boolean> => {
      if (!selectionAutoFillEnabled) return false;
      try {
        const applied = await applySelectionAutoFillToActiveLayer({
          color: brushColor,
          selectionBefore: before,
          selectionAfter: after,
        });
        if (!applied) {
          console.error('[GPU_SELECTION_FILL_FAILED]', {
            layerId: activeLayerId,
            reason: 'auto-fill returned false',
          });
        }
        return applied;
      } finally {
        clearPendingSelectionAutoFillPreview();
      }
    },
    [
      activeLayerId,
      applySelectionAutoFillToActiveLayer,
      brushColor,
      clearPendingSelectionAutoFillPreview,
      selectionAutoFillEnabled,
    ]
  );

  // Selection handler for rect select and lasso tools
  const {
    handleSelectionPointerDown,
    handleSelectionPointerMove,
    handleSelectionPointerUp,
    handleSelectionDoubleClick: _handleSelectionDoubleClick,
    isSelectionToolActive,
  } = useSelectionHandler({
    currentTool,
    scale,
    onBeforeSelectionMutation,
    onSelectionCommitStart: selectionAutoFillEnabled
      ? ({ path }) => {
          latchPendingSelectionAutoFillPreview(path);
        }
      : undefined,
    onSelectionCommitted: selectionAutoFillEnabled ? handleSelectionCommitted : undefined,
  });

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

  const commitSelectionFillGpu = useCallback(
    async (params: ApplyGpuSelectionFillToActiveLayerParams): Promise<boolean> => {
      const gpuRenderer = gpuRendererRef.current;
      const renderer = layerRendererRef.current;
      const fail = (message: string, extra?: Record<string, unknown>): false => {
        if (extra) {
          console.warn(`[SelectionAutoFillGpu] ${message}`, extra);
        } else {
          console.warn(`[SelectionAutoFillGpu] ${message}`);
        }
        return false;
      };
      if (!gpuRenderer || !renderer) return fail('GPU renderer unavailable');

      const layerState = layers.find((layer) => layer.id === params.layerId);
      if (!layerState || layerState.locked || !layerState.visible) {
        return fail('target layer is not editable', {
          layerId: params.layerId,
          layerLocked: layerState?.locked ?? null,
          layerVisible: layerState?.visible ?? null,
        });
      }

      const selectionState = useSelectionStore.getState();
      if (selectionState.selectionMaskPending) {
        return fail('selection mask is still pending', {
          layerId: params.layerId,
        });
      }
      if (!selectionState.hasSelection || !selectionState.selectionMask) {
        return fail('selection mask is missing', {
          layerId: params.layerId,
          hasSelection: selectionState.hasSelection,
        });
      }

      const layer = renderer.getLayer(params.layerId);
      if (!layer) {
        return fail('target layer missing in renderer', {
          layerId: params.layerId,
        });
      }

      const historyStore = gpuStrokeHistoryStoreRef.current;
      const historyEntryId =
        params.historyMeta?.snapshotMode === 'gpu' ? params.historyMeta.entryId : null;
      const finalizeHistory = () => {
        if (historyStore && historyEntryId) {
          historyStore.finalizeStroke(historyEntryId);
        }
      };

      try {
        // Ensure this commit uses the exact selection snapshot passed from commit workflow.
        gpuRenderer.setSelectionMask(params.selectionMask);

        const visibleGpuLayers = getVisibleGpuRenderableLayers();
        for (const visibleLayer of visibleGpuLayers) {
          const sourceLayer = renderer.getLayer(visibleLayer.id);
          if (!sourceLayer) continue;
          gpuRenderer.syncLayerFromCanvas(
            visibleLayer.id,
            sourceLayer.canvas,
            visibleLayer.revision
          );
        }

        const committedTiles = gpuRenderer.commitSelectionFill({
          layerId: params.layerId,
          fill: {
            color: params.color,
            dirtyRect: params.dirtyRect,
          },
          baseLayerCanvas: layer.canvas,
          historyCapture:
            historyStore && historyEntryId
              ? {
                  entryId: historyEntryId,
                  store: historyStore,
                }
              : undefined,
        });
        if (committedTiles.length === 0) {
          return fail('no tiles committed', {
            layerId: params.layerId,
            dirtyRect: params.dirtyRect,
          });
        }

        // Selection auto-fill needs immediate CPU canvas coherence for composite/thumbnail/history UX.
        // Always read back committed tiles here to avoid stale CPU data clobbering GPU results.
        const synced = await syncGpuLayerTilesToCpu(params.layerId, committedTiles);
        if (!synced) {
          return fail('readback sync failed after commit', {
            layerId: params.layerId,
            committedTileCount: committedTiles.length,
          });
        }
        return true;
      } catch (error) {
        return fail('Failed to commit GPU selection fill', {
          layerId: params.layerId,
          error,
        });
      } finally {
        finalizeHistory();
      }
    },
    [getVisibleGpuRenderableLayers, layers, syncGpuLayerTilesToCpu]
  );
  commitSelectionFillGpuRef.current = commitSelectionFillGpu;

  const commitGradientGpu = useCallback(
    async (
      params: ApplyGradientToActiveLayerParams & { layerId: string; dirtyRect: Rect | null }
    ): Promise<boolean> => {
      const gpuRenderer = gpuRendererRef.current;
      const renderer = layerRendererRef.current;
      if (!gpuRenderer || !renderer) return false;
      const layerState = layers.find((layer) => layer.id === params.layerId);
      if (!layerState || layerState.locked || !layerState.visible) return false;

      const selectionState = useSelectionStore.getState();
      if (selectionState.selectionMaskPending) return false;
      if (selectionState.hasSelection && !selectionState.selectionMask) return false;

      const layer = renderer.getLayer(params.layerId);
      if (!layer) return false;

      onBeforeCanvasMutation?.();
      await captureBeforeImage(true, true);

      const historyStore = gpuStrokeHistoryStoreRef.current;
      const capturedHistoryMeta = getCapturedStrokeHistoryMeta();
      if (!capturedHistoryMeta || capturedHistoryMeta.layerId !== params.layerId) {
        discardCapturedStrokeHistory();
        return false;
      }
      const historyEntryId =
        capturedHistoryMeta.snapshotMode === 'gpu' ? capturedHistoryMeta.entryId : null;
      const readbackMode = gpuCommitCoordinatorRef.current?.getReadbackMode() ?? 'enabled';
      const finalizeHistory = () => {
        if (historyStore && historyEntryId) {
          historyStore.finalizeStroke(historyEntryId);
        }
      };

      try {
        const visibleGpuLayers = getVisibleGpuRenderableLayers();
        for (const visibleLayer of visibleGpuLayers) {
          const sourceLayer = renderer.getLayer(visibleLayer.id);
          if (!sourceLayer) continue;
          gpuRenderer.syncLayerFromCanvas(
            visibleLayer.id,
            sourceLayer.canvas,
            visibleLayer.revision
          );
        }

        const gradientParams: GpuGradientRenderParams = {
          shape: params.shape,
          colorStops: params.colorStops,
          opacityStops: params.opacityStops,
          blendMode: params.blendMode,
          opacity: params.opacity,
          reverse: params.reverse,
          dither: params.dither,
          transparency: params.transparency,
          foregroundColor: params.foregroundColor,
          backgroundColor: params.backgroundColor,
          start: params.start,
          end: params.end,
          dirtyRect: params.dirtyRect,
        };

        const committedTiles = gpuRenderer.commitGradient({
          layerId: params.layerId,
          gradient: gradientParams,
          baseLayerCanvas: layer.canvas,
          historyCapture:
            historyStore && historyEntryId
              ? {
                  entryId: historyEntryId,
                  store: historyStore,
                }
              : undefined,
        });

        if (committedTiles.length === 0) {
          discardCapturedStrokeHistory();
          return false;
        }

        if (readbackMode === 'enabled') {
          await gpuRenderer.readbackTilesToLayer({
            layerId: params.layerId,
            tiles: committedTiles,
            targetCtx: layer.ctx,
          });
        } else {
          trackPendingGpuCpuSyncTiles(params.layerId, committedTiles);
          schedulePendingGpuCpuSync(params.layerId);
        }

        saveStrokeToHistory();
        updateThumbnail(params.layerId);
        compositeAndRender();
        return true;
      } catch (error) {
        discardCapturedStrokeHistory();
        console.warn('[GradientGpu] Failed to commit GPU gradient', {
          layerId: params.layerId,
          error,
        });
        return false;
      } finally {
        finalizeHistory();
        clearPendingGpuHistoryEntry();
      }
    },
    [
      captureBeforeImage,
      clearPendingGpuHistoryEntry,
      compositeAndRender,
      discardCapturedStrokeHistory,
      getCapturedStrokeHistoryMeta,
      getVisibleGpuRenderableLayers,
      layers,
      onBeforeCanvasMutation,
      saveStrokeToHistory,
      schedulePendingGpuCpuSync,
      trackPendingGpuCpuSyncTiles,
      updateThumbnail,
    ]
  );

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
    jumpToHistoryIndex,
    handleClearLayer,
    handleDuplicateLayer,
    handleSetLayerOpacity,
    handleSetLayerBlendMode,
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
    getStrokeFinalizeDebugSnapshot,
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
      globalPressureLut,
      maxBrushSpeedPxPerMs,
      brushSpeedSmoothingSamples,
      lowPressureAdaptiveSmoothingEnabled,
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
      noiseSize: LOCKED_NOISE_SETTINGS.size,
      noiseSizeJitter: LOCKED_NOISE_SETTINGS.sizeJitter,
      noiseDensityJitter: LOCKED_NOISE_SETTINGS.densityJitter,
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
    globalPressureLut,
    maxBrushSpeedPxPerMs,
    brushSpeedSmoothingSamples,
    lowPressureAdaptiveSmoothingEnabled,
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
    handleOpenCurvesPanel: () => {
      openPanel('curves-panel');
    },
    handleToggleHistoryPanel: () => {
      togglePanel('history-panel');
    },
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

  const cursorBrushTexture = useMemo(
    () =>
      brushTexture
        ? {
            cursorId: brushTexture.id,
            cursorPath: brushTexture.cursorPath,
            cursorBounds: brushTexture.cursorBounds,
            cursorPathLod0: brushTexture.cursorPathLod0,
            cursorPathLod1: brushTexture.cursorPathLod1,
            cursorPathLod2: brushTexture.cursorPathLod2,
            cursorComplexityLod0: brushTexture.cursorComplexityLod0,
            cursorComplexityLod1: brushTexture.cursorComplexityLod1,
            cursorComplexityLod2: brushTexture.cursorComplexityLod2,
          }
        : null,
    [brushTexture]
  );

  const { cursorStyle, showDomCursor, showEyedropperDomCursor, resolvedDomCursorPath } = useCursor({
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
    brushTexture: cursorBrushTexture,
    forceDomCursor: forceDomCursorDebug,
    canvasRef,
  });

  const clearGradientPreview = useCallback(() => {
    const overlay = gradientPreviewCanvasRef.current;
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
  }, [height, width]);

  const renderGradientPreview = useCallback(
    (payload: GradientPreviewPayload) => {
      const overlay = gradientPreviewCanvasRef.current;
      if (!overlay) return;

      const ctx = overlay.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, width, height);

      if (payload.previewLayerCanvas) {
        const renderer = layerRendererRef.current;
        if (renderer) {
          const compositePreview = renderer.composite(undefined, undefined, {
            activeLayerId: payload.layerId,
            canvas: payload.previewLayerCanvas,
          });
          ctx.drawImage(compositePreview, 0, 0);
        }
      }

      const guide = payload.guide;
      if (!guide) return;
      drawGradientGuideOverlay(ctx, guide, displayScale);
    },
    [displayScale, height, width]
  );

  const renderGpuGradientPreview = useCallback(
    (payload: {
      layerId: string;
      gradientParams: ApplyGradientToActiveLayerParams;
      dirtyRect: Rect | null;
    }) => {
      if (!gpuDisplayActive) return;
      const gpuRenderer = gpuRendererRef.current;
      const renderer = layerRendererRef.current;
      if (!gpuRenderer || !renderer) return;

      const visibleGpuLayers = getVisibleGpuRenderableLayers();
      for (const visibleLayer of visibleGpuLayers) {
        const layer = renderer.getLayer(visibleLayer.id);
        if (!layer) continue;
        gpuRenderer.syncLayerFromCanvas(visibleLayer.id, layer.canvas, visibleLayer.revision);
      }

      gpuRenderer.renderLayerStackFrameWithGradientPreview({
        layers: visibleGpuLayers,
        activeLayerId: payload.layerId,
        gradient: {
          shape: payload.gradientParams.shape,
          colorStops: payload.gradientParams.colorStops,
          opacityStops: payload.gradientParams.opacityStops,
          blendMode: payload.gradientParams.blendMode,
          opacity: payload.gradientParams.opacity,
          reverse: payload.gradientParams.reverse,
          dither: payload.gradientParams.dither,
          transparency: payload.gradientParams.transparency,
          foregroundColor: payload.gradientParams.foregroundColor,
          backgroundColor: payload.gradientParams.backgroundColor,
          start: payload.gradientParams.start,
          end: payload.gradientParams.end,
          dirtyRect: payload.dirtyRect,
        },
      });
    },
    [getVisibleGpuRenderableLayers, gpuDisplayActive]
  );

  const clearGpuGradientPreview = useCallback(() => {
    if (!gpuDisplayActive) return;
    renderGpuFrame(false);
  }, [gpuDisplayActive, renderGpuFrame]);

  const renderCurvesPreviewCpu = useCallback(
    (session: CurvesSessionState, payload: CurvesPreviewPayload) => {
      const renderer = layerRendererRef.current;
      if (!renderer) return;
      if (!payload.previewEnabled) {
        clearGradientPreview();
        return;
      }

      const luts = curvesPayloadToLuts(payload);
      const previewImage = applyCurvesToImageData({
        baseImageData: session.baseImageData,
        luts,
        selectionMask: session.selectionMask,
      });

      const previewCtx = session.previewCanvas.getContext('2d');
      if (!previewCtx) return;
      previewCtx.putImageData(previewImage, 0, 0);

      const overlay = gradientPreviewCanvasRef.current;
      if (!overlay) return;
      const overlayCtx = overlay.getContext('2d');
      if (!overlayCtx) return;
      overlayCtx.clearRect(0, 0, width, height);
      const composed = renderer.composite(undefined, undefined, {
        activeLayerId: session.layerId,
        canvas: session.previewCanvas,
      });
      overlayCtx.drawImage(composed, 0, 0);
    },
    [clearGradientPreview, height, width]
  );

  const renderCurvesPreviewGpu = useCallback(
    (session: CurvesSessionState, payload: CurvesPreviewPayload) => {
      if (!payload.previewEnabled) {
        renderGpuFrame(false);
        return;
      }
      if (!gpuDisplayActive) {
        throw new Error('GPU display path inactive');
      }
      const gpuRenderer = gpuRendererRef.current;
      const renderer = layerRendererRef.current;
      if (!gpuRenderer || !renderer) {
        throw new Error('GPU renderer unavailable');
      }

      const visibleGpuLayers = getVisibleGpuRenderableLayers();
      for (const visibleLayer of visibleGpuLayers) {
        const layer = renderer.getLayer(visibleLayer.id);
        if (!layer) continue;
        gpuRenderer.syncLayerFromCanvas(visibleLayer.id, layer.canvas, visibleLayer.revision);
      }

      const dirtyRect = resolveSelectionDirtyRect(width, height, session.selectionBounds);
      const luts = curvesPayloadToLuts(payload);
      const curvesParams: GpuCurvesRenderParams = {
        rgbLut: luts.rgb,
        redLut: luts.red,
        greenLut: luts.green,
        blueLut: luts.blue,
        dirtyRect,
      };
      gpuRenderer.renderLayerStackFrameWithCurvesPreview({
        layers: visibleGpuLayers,
        activeLayerId: session.layerId,
        curves: curvesParams,
      });
    },
    [getVisibleGpuRenderableLayers, gpuDisplayActive, height, renderGpuFrame, width]
  );

  const restoreGpuSelectionMaskFromStore = useCallback(() => {
    const gpuRenderer = gpuRendererRef.current;
    if (!gpuRenderer) return;
    gpuRenderer.setSelectionMask(selectionMask ?? null);
  }, [selectionMask]);

  const clearCurvesPreviewVisual = useCallback(() => {
    clearGradientPreview();
    if (gpuDisplayActive) {
      renderGpuFrame(false);
    }
  }, [clearGradientPreview, gpuDisplayActive, renderGpuFrame]);

  const runCurvesPreviewFrame = useCallback(() => {
    const session = curvesSessionRef.current;
    if (!session) return;
    session.previewRafId = null;
    const payload = session.pendingPayload;
    if (!payload) return;
    session.pendingPayload = null;

    if (session.previewHalted) {
      return;
    }

    if (session.renderMode === 'gpu') {
      try {
        renderCurvesPreviewGpu(session, payload);
        session.gpuError = null;
        session.lastPreviewResult = {
          ok: true,
          renderMode: 'gpu',
          halted: false,
        };
      } catch (error) {
        const runtimeError = createCurvesRuntimeError({
          code: 'GPU_PREVIEW_FAILED',
          stage: 'preview',
          message: 'GPU 曲线预览失败，预览已停止。',
          error,
        });
        session.gpuError = runtimeError;
        session.previewHalted = true;
        session.lastPreviewResult = {
          ok: false,
          renderMode: 'gpu',
          halted: true,
          error: runtimeError,
        };
        console.error('[CurvesGpuFailFast]', {
          sessionId: session.sessionId,
          layerId: session.layerId,
          stage: 'preview',
          code: runtimeError.code,
          error,
        });
      }
      return;
    }
    renderCurvesPreviewCpu(session, payload);
    session.lastPreviewResult = {
      ok: true,
      renderMode: 'cpu',
      halted: false,
    };
  }, [renderCurvesPreviewCpu, renderCurvesPreviewGpu]);

  const cancelCurvesPreviewSchedule = useCallback(() => {
    const session = curvesSessionRef.current;
    if (!session) return;
    if (session.previewRafId !== null) {
      window.cancelAnimationFrame(session.previewRafId);
      session.previewRafId = null;
    }
    session.pendingPayload = null;
  }, []);

  const commitCurvesGpu = useCallback(
    async (
      session: CurvesSessionState,
      payload: CurvesPreviewPayload
    ): Promise<CurvesCommitResult> => {
      const gpuRenderer = gpuRendererRef.current;
      const renderer = layerRendererRef.current;
      if (!gpuRenderer || !renderer) {
        return {
          ok: false,
          canForceCpuCommit: true,
          error: createCurvesRuntimeError({
            code: 'GPU_COMMIT_FAILED',
            stage: 'commit',
            message: 'GPU 提交前置条件不满足。',
          }),
        };
      }

      const layerState = layers.find((layer) => layer.id === session.layerId);
      if (!layerState || layerState.locked || !layerState.visible) {
        return {
          ok: false,
          canForceCpuCommit: false,
          error: createCurvesRuntimeError({
            code: 'GPU_COMMIT_FAILED',
            stage: 'commit',
            message: '当前图层不可提交（锁定或不可见）。',
          }),
        };
      }

      const layer = renderer.getLayer(session.layerId);
      if (!layer) {
        return {
          ok: false,
          canForceCpuCommit: false,
          error: createCurvesRuntimeError({
            code: 'GPU_COMMIT_FAILED',
            stage: 'commit',
            message: '目标图层不存在。',
          }),
        };
      }

      onBeforeCanvasMutation?.();
      const readbackMode = gpuCommitCoordinatorRef.current?.getReadbackMode() ?? 'enabled';

      try {
        const visibleGpuLayers = getVisibleGpuRenderableLayers();
        for (const visibleLayer of visibleGpuLayers) {
          const sourceLayer = renderer.getLayer(visibleLayer.id);
          if (!sourceLayer) continue;
          gpuRenderer.syncLayerFromCanvas(
            visibleLayer.id,
            sourceLayer.canvas,
            visibleLayer.revision
          );
        }

        const dirtyRect = resolveSelectionDirtyRect(width, height, session.selectionBounds);
        const luts = curvesPayloadToLuts(payload);
        const curvesParams: GpuCurvesRenderParams = {
          rgbLut: luts.rgb,
          redLut: luts.red,
          greenLut: luts.green,
          blueLut: luts.blue,
          dirtyRect,
        };

        const committedTiles = gpuRenderer.commitCurves({
          layerId: session.layerId,
          curves: curvesParams,
          baseLayerCanvas: layer.canvas,
        });

        if (committedTiles.length === 0) {
          discardCapturedStrokeHistory();
          return {
            ok: false,
            canForceCpuCommit: true,
            error: createCurvesRuntimeError({
              code: 'GPU_COMMIT_FAILED',
              stage: 'commit',
              message: 'GPU 曲线提交未生成有效 tile。',
            }),
          };
        }

        if (readbackMode === 'enabled') {
          await gpuRenderer.readbackTilesToLayer({
            layerId: session.layerId,
            tiles: committedTiles,
            targetCtx: layer.ctx,
          });
        } else {
          trackPendingGpuCpuSyncTiles(session.layerId, committedTiles);
          schedulePendingGpuCpuSync(session.layerId);
        }

        useHistoryStore.getState().pushStroke({
          layerId: session.layerId,
          entryId: session.sessionId,
          snapshotMode: 'cpu',
          beforeImage: cloneCurvesSessionImageData(session.baseImageData),
        });
        useDocumentStore.getState().markDirty();
        updateThumbnail(session.layerId);
        compositeAndRender();
        return {
          ok: true,
          appliedMode: 'gpu',
          canForceCpuCommit: false,
        };
      } catch (error) {
        console.error('[CurvesGpuFailFast]', {
          sessionId: session.sessionId,
          layerId: session.layerId,
          stage: 'commit',
          code: 'GPU_COMMIT_FAILED',
          error,
        });
        return {
          ok: false,
          canForceCpuCommit: true,
          error: createCurvesRuntimeError({
            code: 'GPU_COMMIT_FAILED',
            stage: 'commit',
            message: 'GPU 曲线提交失败。',
            error,
          }),
        };
      } finally {
        clearPendingGpuHistoryEntry();
        restoreGpuSelectionMaskFromStore();
      }
    },
    [
      clearPendingGpuHistoryEntry,
      compositeAndRender,
      discardCapturedStrokeHistory,
      getVisibleGpuRenderableLayers,
      height,
      layers,
      onBeforeCanvasMutation,
      restoreGpuSelectionMaskFromStore,
      schedulePendingGpuCpuSync,
      trackPendingGpuCpuSyncTiles,
      updateThumbnail,
      width,
    ]
  );

  const disposeCurvesSession = useCallback(
    (options?: { clearVisual?: boolean }) => {
      const session = curvesSessionRef.current;
      if (!session) return;
      cancelCurvesPreviewSchedule();
      if (options?.clearVisual !== false) {
        clearCurvesPreviewVisual();
      }
      curvesSessionRef.current = null;
      restoreGpuSelectionMaskFromStore();
    },
    [cancelCurvesPreviewSchedule, clearCurvesPreviewVisual, restoreGpuSelectionMaskFromStore]
  );

  const beginCurvesSession = useCallback((): CurvesSessionInfo | null => {
    disposeCurvesSession();
    const renderer = layerRendererRef.current;
    if (!renderer || !activeLayerId) return null;

    const layerState = layers.find((layer) => layer.id === activeLayerId);
    if (!layerState || layerState.locked || !layerState.visible) return null;

    const baseLayerImage = renderer.getLayerImageData(activeLayerId);
    if (!baseLayerImage) return null;

    const selectionState = useSelectionStore.getState();
    if (selectionState.selectionMaskPending) return null;

    let selectionMaskSnapshot: ImageData | null = null;
    if (selectionState.hasSelection) {
      if (!selectionState.selectionMask) return null;
      selectionMaskSnapshot = new ImageData(
        new Uint8ClampedArray(selectionState.selectionMask.data),
        selectionState.selectionMask.width,
        selectionState.selectionMask.height
      );
    }

    const baseImageData = new ImageData(
      new Uint8ClampedArray(baseLayerImage.data),
      baseLayerImage.width,
      baseLayerImage.height
    );
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = width;
    previewCanvas.height = height;
    const renderMode: 'gpu' | 'cpu' = ENABLE_GPU_CURVES && gpuCurvesPathAvailable ? 'gpu' : 'cpu';
    const sessionId = createHistoryEntryId('curves');
    const histogramByChannel = computeHistogramsByChannel(baseImageData, selectionMaskSnapshot);
    const histogram = histogramByChannel.rgb;

    curvesSessionRef.current = {
      sessionId,
      layerId: activeLayerId,
      renderMode,
      baseImageData,
      selectionMask: selectionMaskSnapshot,
      selectionBounds: selectionState.bounds ? { ...selectionState.bounds } : null,
      histogram,
      histogramByChannel,
      previewCanvas,
      previewRafId: null,
      pendingPayload: null,
      gpuError: null,
      previewHalted: false,
      lastPreviewResult: {
        ok: true,
        renderMode,
        halted: false,
      },
    };
    if (renderMode === 'gpu') {
      gpuRendererRef.current?.setSelectionMask(selectionMaskSnapshot);
    }

    return {
      sessionId,
      layerId: activeLayerId,
      hasSelection: !!selectionMaskSnapshot,
      histogram,
      histogramByChannel,
      renderMode,
    };
  }, [activeLayerId, disposeCurvesSession, gpuCurvesPathAvailable, height, layers, width]);

  const previewCurvesSession = useCallback(
    (sessionId: string, payload: CurvesPreviewPayload): CurvesPreviewResult => {
      const session = curvesSessionRef.current;
      if (!session || session.sessionId !== sessionId) {
        console.error('[CurvesGpuFailFast]', {
          stage: 'preview',
          code: 'SESSION_INVALID',
          requestedSessionId: sessionId,
          activeSessionId: session?.sessionId ?? null,
        });
        return createCurvesSessionInvalidPreviewResult();
      }

      if (session.previewHalted) {
        const haltedError =
          session.gpuError ??
          createCurvesRuntimeError({
            code: 'GPU_PREVIEW_HALTED',
            stage: 'preview',
            message: 'GPU 曲线预览已停止，请先处理错误。',
          });
        session.lastPreviewResult = {
          ok: false,
          renderMode: session.renderMode,
          halted: true,
          error: haltedError,
        };
        return session.lastPreviewResult;
      }

      session.pendingPayload = payload;
      runCurvesPreviewFrame();
      return session.lastPreviewResult;
    },
    [runCurvesPreviewFrame]
  );

  const commitCurvesSession = useCallback(
    async (
      sessionId: string,
      payload: CurvesPreviewPayload,
      request?: CurvesCommitRequest
    ): Promise<CurvesCommitResult> => {
      const session = curvesSessionRef.current;
      if (!session || session.sessionId !== sessionId) {
        console.error('[CurvesGpuFailFast]', {
          stage: 'commit',
          code: 'SESSION_INVALID',
          requestedSessionId: sessionId,
          activeSessionId: session?.sessionId ?? null,
        });
        return createCurvesSessionInvalidCommitResult();
      }

      cancelCurvesPreviewSchedule();
      clearCurvesPreviewVisual();
      const forceCpu = request?.forceCpu === true;

      if (session.renderMode === 'gpu' && !forceCpu) {
        let gpuResult: CurvesCommitResult;
        try {
          gpuResult = await commitCurvesGpu(session, payload);
        } catch (error) {
          console.error('[CurvesGpuFailFast]', {
            sessionId: session.sessionId,
            layerId: session.layerId,
            stage: 'commit',
            code: 'GPU_COMMIT_FAILED',
            error,
          });
          gpuResult = {
            ok: false,
            canForceCpuCommit: true,
            error: createCurvesRuntimeError({
              code: 'GPU_COMMIT_FAILED',
              stage: 'commit',
              message: 'GPU 曲线提交失败。',
              error,
            }),
          };
        }
        if (gpuResult.ok) {
          curvesSessionRef.current = null;
          restoreGpuSelectionMaskFromStore();
          return gpuResult;
        }
        session.gpuError = gpuResult.error ?? null;
        session.previewHalted = true;
        return gpuResult;
      }

      const renderer = layerRendererRef.current;
      if (!renderer) {
        return {
          ok: false,
          canForceCpuCommit: false,
          error: createCurvesRuntimeError({
            code: 'CPU_COMMIT_FAILED',
            stage: 'commit',
            message: 'CPU 提交前置条件不满足。',
          }),
        };
      }
      const layerState = layers.find((layer) => layer.id === session.layerId);
      if (!layerState || layerState.locked || !layerState.visible) {
        return {
          ok: false,
          canForceCpuCommit: false,
          error: createCurvesRuntimeError({
            code: 'CPU_COMMIT_FAILED',
            stage: 'commit',
            message: '当前图层不可提交（锁定或不可见）。',
          }),
        };
      }

      try {
        onBeforeCanvasMutation?.();
        const luts = curvesPayloadToLuts(payload);
        const nextImage = applyCurvesToImageData({
          baseImageData: session.baseImageData,
          luts,
          selectionMask: session.selectionMask,
        });
        renderer.setLayerImageData(session.layerId, nextImage);
        useHistoryStore.getState().pushStroke({
          layerId: session.layerId,
          entryId: session.sessionId,
          snapshotMode: 'cpu',
          beforeImage: cloneCurvesSessionImageData(session.baseImageData),
        });
        useDocumentStore.getState().markDirty();
        markLayerDirty(session.layerId);
        updateThumbnail(session.layerId);
        compositeAndRender();
      } catch (error) {
        console.error('[CurvesGpuFailFast]', {
          sessionId: session.sessionId,
          layerId: session.layerId,
          stage: 'commit',
          code: 'CPU_COMMIT_FAILED',
          error,
        });
        return {
          ok: false,
          canForceCpuCommit: false,
          error: createCurvesRuntimeError({
            code: 'CPU_COMMIT_FAILED',
            stage: 'commit',
            message: 'CPU 曲线提交失败。',
            error,
          }),
        };
      }

      curvesSessionRef.current = null;
      restoreGpuSelectionMaskFromStore();
      return {
        ok: true,
        appliedMode: 'cpu',
        canForceCpuCommit: false,
      };
    },
    [
      cancelCurvesPreviewSchedule,
      clearCurvesPreviewVisual,
      commitCurvesGpu,
      compositeAndRender,
      layers,
      markLayerDirty,
      onBeforeCanvasMutation,
      restoreGpuSelectionMaskFromStore,
      updateThumbnail,
    ]
  );

  const cancelCurvesSession = useCallback(
    (sessionId: string): void => {
      const session = curvesSessionRef.current;
      if (!session || session.sessionId !== sessionId) return;
      disposeCurvesSession();
    },
    [disposeCurvesSession]
  );

  useEffect(() => {
    disposeCurvesSessionOnUnmountRef.current = disposeCurvesSession;
  }, [disposeCurvesSession]);

  useEffect(() => {
    window.__canvasCurvesBeginSession = beginCurvesSession;
    window.__canvasCurvesPreview = previewCurvesSession;
    window.__canvasCurvesCommit = commitCurvesSession;
    window.__canvasCurvesCancel = cancelCurvesSession;
    return () => {
      delete window.__canvasCurvesBeginSession;
      delete window.__canvasCurvesPreview;
      delete window.__canvasCurvesCommit;
      delete window.__canvasCurvesCancel;
    };
  }, [beginCurvesSession, previewCurvesSession, commitCurvesSession, cancelCurvesSession]);

  useEffect(() => {
    return () => {
      disposeCurvesSessionOnUnmountRef.current();
    };
  }, []);

  const {
    handleGradientPointerDown,
    handleGradientPointerMove,
    handleGradientPointerUp,
    cancelGradientSession,
  } = useGradientTool({
    currentTool,
    activeLayerId,
    layers,
    width,
    height,
    layerRendererRef,
    applyGradientToActiveLayer,
    applyGpuGradientToActiveLayer: commitGradientGpu,
    useGpuGradientPath: gpuDisplayActive,
    renderGpuPreview: renderGpuGradientPreview,
    clearGpuPreview: clearGpuGradientPreview,
    renderPreview: renderGradientPreview,
    clearPreview: clearGradientPreview,
  });

  const { handlePointerDown, handlePointerMove, handlePointerUp, handlePointerCancel } =
    usePointerHandlers({
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
    });

  useEffect(() => {
    return () => {
      cancelGradientSession();
    };
  }, [cancelGradientSession]);

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
      onPointerCancel={handlePointerCancel}
      onContextMenu={handleCanvasContextMenu}
      // Note: onPointerEnter cursor handling is done by native event listener
      style={{ cursor: cursorStyle }}
    >
      <div className="canvas-checkerboard" style={{ clipPath: clipPathKey }} />
      <SelectionOverlay
        scale={displayScale}
        offsetX={offsetX}
        offsetY={offsetY}
        latchedFillPreview={pendingSelectionAutoFillPreview}
      />
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
        <canvas
          ref={gradientPreviewCanvasRef}
          width={width}
          height={height}
          className="gradient-preview-canvas"
          data-testid="gradient-preview-canvas"
        />
      </div>
      {showDomCursor && !brushQuickPanelHovering && (
        <div
          ref={brushCursorRef}
          className={`brush-cursor ${resolvedDomCursorPath ? 'brush-cursor--texture' : ''}`}
          style={{
            width: currentSize * displayScale,
            height: currentSize * displayScale * (brushRoundness / 100),
            // Note: position transform is set by useCursor via JS
            // rotation is applied to inner content, not the container
          }}
        >
          {resolvedDomCursorPath ? (
            <svg
              key={resolvedDomCursorPath.slice(0, 50)}
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
                d={resolvedDomCursorPath}
                fill="none"
                stroke="rgba(255,255,255,0.9)"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={resolvedDomCursorPath}
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
