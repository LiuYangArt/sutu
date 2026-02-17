import { useEffect, type RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { join, tempDir } from '@tauri-apps/api/path';
import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  writeFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs';
import { useDocumentStore, type BlendMode, type ResizeCanvasOptions } from '@/stores/document';
import { useViewportStore } from '@/stores/viewport';
import { useSettingsStore } from '@/stores/settings';
import { useTabletStore } from '@/stores/tablet';
import { useToolStore, type ToolType, type PressureCurve, type BrushMaskType } from '@/stores/tool';
import { LayerRenderer } from '@/utils/layerRenderer';
import { decompressLz4PrependSize } from '@/utils/lz4';
import { renderLayerThumbnail } from '@/utils/layerThumbnail';
import { buildProjectProtocolUrl } from '@/utils/projectProtocolUrl';
import {
  parseDualBrushSettings,
  parseScatterSettings,
  parseTextureSettings,
} from './replayContextParsers';
import { isNativeTabletStreamingState } from './inputUtils';
import type { M4ParityGateOptions, M4ParityGateResult } from '@/test/m4FeatureParityGate';
import type {
  FixedCaptureSource,
  FixedStrokeCaptureLoadResult,
  FixedStrokeCaptureSaveResult,
} from '@/test/strokeCaptureFixedFile';
import type { StrokeCaptureData, StrokeReplayOptions } from '@/test/StrokeCapture';
import {
  getLastKritaTailTrace,
  startKritaTailTraceSession,
  stopKritaTailTraceSession,
} from '@/test/kritaTailTrace/collector';
import type { KritaTailTrace, KritaTailTraceMeta } from '@/test/kritaTailTrace/types';
import { appDotStorageKey, appHyphenStorageKey } from '@/constants/appMeta';
import type { StrokeFinalizeDebugSnapshot } from '@/utils/strokeBuffer';
import {
  GPUContext,
  type GpuBrushCommitReadbackMode,
  persistResidencyBudgetFromProbe,
  type GpuBrushCommitMetricsSnapshot,
} from '@/gpu';

interface UseGlobalExportsParams {
  layerRendererRef: RefObject<LayerRenderer | null>;
  compositeAndRender: () => void;
  fillActiveLayer: (color: string) => void;
  handleClearSelection: () => void;
  handleUndo: () => void;
  handleRedo: () => void;
  jumpToHistoryIndex?: (targetIndex: number) => Promise<boolean>;
  handleClearLayer: () => void;
  handleDuplicateLayer: (from: string, to: string) => void;
  handleSetLayerOpacity?: (ids: string[], opacity: number) => number;
  handleSetLayerBlendMode?: (ids: string[], blendMode: BlendMode) => number;
  handleRemoveLayer: (id: string) => void;
  handleRemoveLayers?: (ids: string[]) => number;
  handleMergeSelectedLayers?: (ids?: string[]) => number;
  handleMergeAllLayers?: () => number;
  handleResizeCanvas: (options: ResizeCanvasOptions) => void;
  getGpuDiagnosticsSnapshot?: () => unknown;
  resetGpuDiagnostics?: () => boolean;
  getGpuLayerStackCacheStats?: () => unknown;
  getGpuBrushCommitMetricsSnapshot?: () => GpuBrushCommitMetricsSnapshot | null;
  resetGpuBrushCommitMetrics?: () => boolean;
  getGpuBrushCommitReadbackMode?: () => GpuBrushCommitReadbackMode;
  setGpuBrushCommitReadbackMode?: (mode: GpuBrushCommitReadbackMode) => boolean;
  getGpuBrushNoReadbackPilot?: () => boolean;
  setGpuBrushNoReadbackPilot?: (enabled: boolean) => boolean;
  getStrokeFinalizeDebugSnapshot?: () => StrokeFinalizeDebugSnapshot | null;
  markGpuLayerDirty?: (layerIds?: string | string[]) => void;
  exportGpuLayerImageData?: (layerId: string) => Promise<ImageData | null>;
  exportGpuFlattenedImageData?: () => Promise<ImageData | null>;
  syncGpuLayerToCpu?: (layerId: string) => Promise<boolean>;
  syncAllGpuLayersToCpu?: () => Promise<number>;
  startStrokeCapture?: () => boolean;
  stopStrokeCapture?: () => StrokeCaptureData | null;
  getLastStrokeCapture?: () => StrokeCaptureData | null;
  replayStrokeCapture?: (
    capture?: StrokeCaptureData | string,
    options?: StrokeReplayOptions
  ) => Promise<{ events: number; durationMs: number } | null>;
  downloadStrokeCapture?: (fileName?: string, capture?: StrokeCaptureData | string) => boolean;
}

const TOOL_TYPES = new Set<ToolType>([
  'brush',
  'eraser',
  'eyedropper',
  'gradient',
  'move',
  'select',
  'lasso',
  'zoom',
]);

const PRESSURE_CURVES = new Set<PressureCurve>(['linear', 'soft', 'hard', 'sCurve']);
const BRUSH_MASK_TYPES = new Set<BrushMaskType>(['gaussian']);
const DEBUG_CAPTURE_DIR = 'debug-data';
const DEBUG_CAPTURE_FILE_NAME = 'debug-stroke-capture.json';
const DEBUG_CAPTURE_RELATIVE_PATH = `${DEBUG_CAPTURE_DIR}/${DEBUG_CAPTURE_FILE_NAME}`;
const DEBUG_CAPTURE_LOCAL_KEY = appDotStorageKey('debug-data.debug-stroke-capture');

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asBrushMaskType(value: unknown): BrushMaskType | null {
  if (typeof value !== 'string') return null;
  if (!BRUSH_MASK_TYPES.has(value as BrushMaskType)) return null;
  return value as BrushMaskType;
}

function isCssColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s) return false;
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  const rgb = /^rgba?\([^)]+\)$/i;
  return hex.test(s) || rgb.test(s);
}

function parseStrokeCaptureInput(
  capture: StrokeCaptureData | string | undefined,
  fallback: StrokeCaptureData | null
): StrokeCaptureData | null {
  if (!capture) return fallback;
  if (typeof capture === 'string') {
    try {
      const parsed = JSON.parse(capture) as unknown;
      if (
        isRecord(parsed) &&
        parsed.version === 1 &&
        Array.isArray(parsed.samples) &&
        isRecord(parsed.metadata)
      ) {
        return parsed as unknown as StrokeCaptureData;
      }
    } catch {
      return null;
    }
    return null;
  }
  return capture;
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function imageDataToDataUrl(imageData: ImageData): string | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

function dataUrlToPngBytes(dataUrl: string): Uint8Array | undefined {
  const base64Index = dataUrl.indexOf('base64,');
  if (base64Index < 0) return undefined;
  const base64 = dataUrl.slice(base64Index + 'base64,'.length);
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array | undefined> {
  return Promise.resolve(dataUrlToPngBytes(canvas.toDataURL('image/png')));
}

function imageDataToCanvas(imageData: ImageData): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export function useGlobalExports({
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
  handleMergeSelectedLayers,
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
  markGpuLayerDirty,
  exportGpuLayerImageData,
  exportGpuFlattenedImageData,
  syncGpuLayerToCpu,
  syncAllGpuLayersToCpu,
  startStrokeCapture,
  stopStrokeCapture,
  getLastStrokeCapture,
  replayStrokeCapture,
  downloadStrokeCapture,
}: UseGlobalExportsParams): void {
  useEffect(() => {
    const win = window as Window & {
      __canvasFillLayer?: (color: string) => void;
      __canvasClearSelection?: () => void;
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
      __canvasUndo?: () => void;
      __canvasRedo?: () => void;
      __canvasHistoryJumpTo?: (targetIndex: number) => Promise<boolean>;
      __canvasClearLayer?: () => void;
      __canvasDuplicateLayer?: (from: string, to: string) => void;
      __canvasSetLayerOpacity?: (ids: string[], opacity: number) => number;
      __canvasSetLayerBlendMode?: (ids: string[], blendMode: BlendMode) => number;
      __canvasRemoveLayer?: (id: string) => void;
      __canvasRemoveLayers?: (ids: string[]) => number;
      __canvasMergeSelectedLayers?: (ids?: string[]) => number;
      __canvasMergeAllLayers?: () => number;
      __canvasResize?: (options: ResizeCanvasOptions) => void;
      __gpuM0Baseline?: () => Promise<void>;
      __gpuFormatCompare?: (options?: {
        size?: number;
        ditherStrength?: number;
        includeLinearNoDither?: boolean;
      }) => Promise<string[]>;
      __gpuTileSizeCompare?: (options?: {
        canvasSize?: number;
        tileSizes?: number[];
        frames?: number;
        budgetRatio?: number;
        viewportTiles?: number;
      }) => Promise<unknown>;
      __gpuBrushDiagnostics?: () => unknown;
      __gpuBrushDiagnosticsReset?: () => boolean;
      __gpuLayerStackCacheStats?: () => unknown;
      __gpuBrushCommitMetrics?: () => GpuBrushCommitMetricsSnapshot | null;
      __gpuBrushCommitMetricsReset?: () => boolean;
      __gpuBrushCommitReadbackMode?: () => GpuBrushCommitReadbackMode;
      __gpuBrushCommitReadbackModeSet?: (mode: GpuBrushCommitReadbackMode) => boolean;
      __gpuBrushNoReadbackPilot?: () => boolean;
      __gpuBrushNoReadbackPilotSet?: (enabled: boolean) => boolean;
      __brushStrokeFinalizeDebug?: () => StrokeFinalizeDebugSnapshot | null;
      __brushTailTaperDebug?: () => StrokeFinalizeDebugSnapshot | null;
      __strokeCaptureStart?: () => boolean;
      __strokeCaptureStop?: () => StrokeCaptureData | null;
      __strokeCaptureLast?: () => StrokeCaptureData | null;
      __strokeCaptureReplay?: (
        capture?: StrokeCaptureData | string,
        options?: StrokeReplayOptions
      ) => Promise<{ events: number; durationMs: number } | null>;
      __kritaTailTraceStart?: (options?: {
        strokeId?: string;
        meta?: Partial<KritaTailTraceMeta>;
      }) => KritaTailTrace;
      __kritaTailTraceStop?: () => KritaTailTrace | null;
      __kritaTailTraceLast?: () => KritaTailTrace | null;
      __strokeCaptureDownload?: (
        fileName?: string,
        capture?: StrokeCaptureData | string
      ) => boolean;
      __strokeCaptureSaveFixed?: (
        capture?: StrokeCaptureData | string
      ) => Promise<FixedStrokeCaptureSaveResult>;
      __strokeCaptureLoadFixed?: () => Promise<FixedStrokeCaptureLoadResult | null>;
      __gpuM4ParityGate?: (options?: M4ParityGateOptions) => Promise<M4ParityGateResult>;
    };

    const isTauriRuntime = '__TAURI_INTERNALS__' in window;
    const appConfigPath = `AppConfig/${DEBUG_CAPTURE_RELATIVE_PATH}`;
    const localStoragePath = `localStorage:${DEBUG_CAPTURE_LOCAL_KEY}`;

    const getFallbackPath = (source: FixedCaptureSource): string => {
      return source === 'appconfig' ? appConfigPath : localStoragePath;
    };

    const buildDefaultKritaTailMeta = (): KritaTailTraceMeta => {
      const docState = useDocumentStore.getState();
      const toolState = useToolStore.getState();
      const backendState = useTabletStore.getState();
      return {
        caseId: 'manual',
        canvas: {
          width: docState.width,
          height: docState.height,
          dpi: docState.dpi,
        },
        brushPreset: `${toolState.currentTool}-size-${Math.round(toolState.brushSize)}`,
        runtimeFlags: {
          trajectorySmoothingEnabled: false,
          speedIsolationEnabled: true,
          pressureHeuristicsEnabled: false,
          gpuNoReadbackPilotEnabled: false,
        },
        build: {
          appCommit: 'unknown',
          kritaCommit: 'baseline',
          platform:
            typeof navigator !== 'undefined' && typeof navigator.platform === 'string'
              ? navigator.platform
              : 'unknown',
          inputBackend: isNativeTabletStreamingState(backendState) ? 'native-stream' : 'pointer',
        },
      };
    };

    const mergeKritaTailMeta = (
      baseMeta: KritaTailTraceMeta,
      patch?: Partial<KritaTailTraceMeta>
    ): KritaTailTraceMeta => {
      if (!patch) return baseMeta;
      return {
        ...baseMeta,
        ...patch,
        canvas: {
          ...baseMeta.canvas,
          ...(patch.canvas ?? {}),
        },
        runtimeFlags: {
          ...baseMeta.runtimeFlags,
          ...(patch.runtimeFlags ?? {}),
        },
        build: {
          ...baseMeta.build,
          ...(patch.build ?? {}),
        },
      };
    };

    win.__canvasFillLayer = fillActiveLayer;
    win.__canvasClearSelection = handleClearSelection;
    win.__canvasUndo = handleUndo;
    win.__canvasRedo = handleRedo;
    win.__canvasHistoryJumpTo = async (targetIndex: number) => {
      if (!Number.isInteger(targetIndex)) return false;
      return (await jumpToHistoryIndex?.(targetIndex)) ?? false;
    };
    win.__canvasClearLayer = handleClearLayer;
    win.__canvasDuplicateLayer = handleDuplicateLayer;
    if (handleSetLayerOpacity) {
      win.__canvasSetLayerOpacity = handleSetLayerOpacity;
    }
    if (handleSetLayerBlendMode) {
      win.__canvasSetLayerBlendMode = handleSetLayerBlendMode;
    }
    win.__canvasRemoveLayer = handleRemoveLayer;
    if (handleRemoveLayers) {
      win.__canvasRemoveLayers = handleRemoveLayers;
    }
    if (handleMergeSelectedLayers) {
      win.__canvasMergeSelectedLayers = handleMergeSelectedLayers;
    }
    if (handleMergeAllLayers) {
      win.__canvasMergeAllLayers = handleMergeAllLayers;
    }
    win.__canvasResize = handleResizeCanvas;
    win.__gpuM0Baseline = async () => {
      const device = GPUContext.getInstance().device;
      if (!device) {
        console.warn('[M0Baseline] GPU device not available');
        return;
      }
      const { runM0Baseline } = await import('@/gpu/benchmarks/m0Baseline');
      const result = await runM0Baseline(device);
      const residency = persistResidencyBudgetFromProbe(result.allocationProbe, 0.6);
      // eslint-disable-next-line no-console
      console.log('[M0Baseline] result', { ...result, residencyBudget: residency });
    };

    win.__gpuFormatCompare = async (options): Promise<string[]> => {
      const device = GPUContext.getInstance().device;
      if (!device) {
        console.warn('[FormatCompare] GPU device not available');
        return [];
      }

      const { runFormatCompare } = await import('@/gpu/benchmarks/formatCompare');
      const result = await runFormatCompare(device, {
        includeLinearNoDither: options?.includeLinearNoDither ?? true,
        size: options?.size,
        ditherStrength: options?.ditherStrength,
      });

      try {
        const folder = appHyphenStorageKey('gpu-compare');
        await mkdir(folder, { baseDir: BaseDirectory.Temp, recursive: true });
        const tempRoot = await tempDir();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');

        const paths: string[] = [];
        for (const image of result.images) {
          const fileName = `${folder}/gpu-format-${stamp}-${image.name}.png`;
          await writeFile(fileName, image.pngBytes, { baseDir: BaseDirectory.Temp });
          const absPath = await join(tempRoot, fileName);
          paths.push(absPath);
        }

        // eslint-disable-next-line no-console
        console.log('[FormatCompare] saved', paths);
        return paths;
      } catch (error) {
        console.warn('[FormatCompare] write temp files failed', error);
        return [];
      }
    };

    win.__gpuTileSizeCompare = async (options): Promise<unknown> => {
      const device = GPUContext.getInstance().device;
      if (!device) {
        console.warn('[TileSizeCompare] GPU device not available');
        return null;
      }

      const { runTileSizeCompare } = await import('@/gpu/benchmarks/tileSizeCompare');
      const result = await runTileSizeCompare(device, {
        canvasSize: options?.canvasSize,
        tileSizes: options?.tileSizes,
        frames: options?.frames,
        budgetRatio: options?.budgetRatio,
        viewportTiles: options?.viewportTiles,
      });

      // eslint-disable-next-line no-console
      console.log('[TileSizeCompare] result', result);
      return result;
    };

    win.__gpuBrushDiagnostics = () => {
      return getGpuDiagnosticsSnapshot?.() ?? null;
    };
    win.__gpuBrushDiagnosticsReset = () => {
      return resetGpuDiagnostics?.() ?? false;
    };
    win.__gpuLayerStackCacheStats = () => {
      return getGpuLayerStackCacheStats?.() ?? null;
    };
    win.__gpuBrushCommitMetrics = () => {
      return getGpuBrushCommitMetricsSnapshot?.() ?? null;
    };
    win.__gpuBrushCommitMetricsReset = () => {
      return resetGpuBrushCommitMetrics?.() ?? false;
    };
    win.__gpuBrushCommitReadbackMode = () => {
      return getGpuBrushCommitReadbackMode?.() ?? 'enabled';
    };
    win.__gpuBrushCommitReadbackModeSet = (mode) => {
      if (mode !== 'enabled' && mode !== 'disabled') return false;
      return setGpuBrushCommitReadbackMode?.(mode) ?? false;
    };
    win.__gpuBrushNoReadbackPilot = () => {
      return getGpuBrushNoReadbackPilot?.() ?? false;
    };
    win.__gpuBrushNoReadbackPilotSet = (enabled) => {
      if (typeof enabled !== 'boolean') return false;
      return setGpuBrushNoReadbackPilot?.(enabled) ?? false;
    };
    win.__brushStrokeFinalizeDebug = () => {
      return getStrokeFinalizeDebugSnapshot?.() ?? null;
    };
    // Deprecated alias kept for one release cycle.
    win.__brushTailTaperDebug = () => {
      return getStrokeFinalizeDebugSnapshot?.() ?? null;
    };

    const applyReplayContext = async (capture: StrokeCaptureData): Promise<void> => {
      const applied: string[] = [];
      const warnings: string[] = [];
      const metadata = capture.metadata;

      const targetWidth = asFiniteNumber(metadata.canvasWidth);
      const targetHeight = asFiniteNumber(metadata.canvasHeight);
      if (targetWidth !== null && targetHeight !== null && targetWidth > 0 && targetHeight > 0) {
        const doc = useDocumentStore.getState();
        const roundedWidth = Math.round(targetWidth);
        const roundedHeight = Math.round(targetHeight);
        if (doc.width !== targetWidth || doc.height !== targetHeight) {
          handleResizeCanvas({
            width: roundedWidth,
            height: roundedHeight,
            anchor: 'top-left',
            scaleContent: false,
            extensionColor: 'transparent',
            resampleMode: 'nearest',
          });
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        applied.push(`canvas ${roundedWidth}x${roundedHeight}`);
      } else {
        warnings.push('capture metadata missing valid canvas size');
      }

      if (typeof metadata.activeLayerId === 'string' && metadata.activeLayerId.length > 0) {
        const doc = useDocumentStore.getState();
        const exists = doc.layers.some((layer) => layer.id === metadata.activeLayerId);
        if (exists) {
          doc.setActiveLayer(metadata.activeLayerId);
          applied.push(`activeLayer ${metadata.activeLayerId}`);
        } else {
          warnings.push(`capture activeLayerId not found: ${metadata.activeLayerId}`);
        }
      }

      {
        const doc = useDocumentStore.getState();
        if (!doc.activeLayerId) {
          const fallbackLayer = doc.layers.find((layer) => layer.visible) ?? doc.layers[0];
          if (fallbackLayer) {
            doc.setActiveLayer(fallbackLayer.id);
            applied.push(`activeLayer ${fallbackLayer.id}`);
          } else {
            warnings.push('document has no available layer for replay');
          }
        }
      }

      const viewport = useViewportStore.getState();
      const targetScale = asFiniteNumber(metadata.viewportScale);
      if (targetScale !== null && targetScale > 0) {
        viewport.setScale(targetScale);
        applied.push(`zoom ${targetScale.toFixed(3)}`);
      } else {
        warnings.push('capture metadata missing valid viewportScale');
      }

      const targetOffsetX = asFiniteNumber(metadata.viewportOffsetX);
      const targetOffsetY = asFiniteNumber(metadata.viewportOffsetY);
      if (targetOffsetX !== null && targetOffsetY !== null) {
        viewport.setOffset(targetOffsetX, targetOffsetY);
        applied.push(`offset (${targetOffsetX.toFixed(1)}, ${targetOffsetY.toFixed(1)})`);
      }

      const toolStore = useToolStore.getState();
      const toolMeta = isRecord(metadata.tool) ? metadata.tool : {};

      const capturedTool = toolMeta.currentTool;
      if (typeof capturedTool === 'string' && TOOL_TYPES.has(capturedTool as ToolType)) {
        toolStore.setTool(capturedTool as ToolType);
        applied.push(`tool ${capturedTool}`);
      } else {
        warnings.push('capture metadata missing valid tool.currentTool');
      }

      const brushColor = toolMeta.brushColor;
      if (isCssColor(brushColor)) {
        toolStore.setBrushColor(brushColor);
      }

      const brushSize = asFiniteNumber(toolMeta.brushSize);
      if (brushSize !== null && brushSize > 0) {
        toolStore.setCurrentSize(brushSize);
      }
      const brushFlow = asFiniteNumber(toolMeta.brushFlow);
      if (brushFlow !== null) {
        toolStore.setBrushFlow(brushFlow);
      }
      const brushOpacity = asFiniteNumber(toolMeta.brushOpacity);
      if (brushOpacity !== null) {
        toolStore.setBrushOpacity(brushOpacity);
      }
      const brushHardness = asFiniteNumber(toolMeta.brushHardness);
      if (brushHardness !== null) {
        toolStore.setBrushHardness(brushHardness);
      }
      const brushSpacing = asFiniteNumber(toolMeta.brushSpacing);
      if (brushSpacing !== null) {
        toolStore.setBrushSpacing(brushSpacing);
      }
      const brushRoundness = asFiniteNumber(toolMeta.brushRoundness);
      if (brushRoundness !== null) {
        toolStore.setBrushRoundness(brushRoundness);
      }
      const brushAngle = asFiniteNumber(toolMeta.brushAngle);
      if (brushAngle !== null) {
        toolStore.setBrushAngle(brushAngle);
      }
      const capturedMaskType =
        asBrushMaskType(toolMeta.brushMaskType) ?? asBrushMaskType(toolMeta.maskType);
      if (capturedMaskType) {
        toolStore.setBrushMaskType(capturedMaskType);
      }

      const pressureCurve = toolMeta.pressureCurve;
      if (
        typeof pressureCurve === 'string' &&
        PRESSURE_CURVES.has(pressureCurve as PressureCurve)
      ) {
        toolStore.setPressureCurve(pressureCurve as PressureCurve);
      }

      const pressureSizeEnabled = asBoolean(toolMeta.pressureSizeEnabled);
      const pressureFlowEnabled = asBoolean(toolMeta.pressureFlowEnabled);
      const pressureOpacityEnabled = asBoolean(toolMeta.pressureOpacityEnabled);
      useToolStore.setState((state) => ({
        pressureSizeEnabled:
          pressureSizeEnabled === null ? state.pressureSizeEnabled : pressureSizeEnabled,
        pressureFlowEnabled:
          pressureFlowEnabled === null ? state.pressureFlowEnabled : pressureFlowEnabled,
        pressureOpacityEnabled:
          pressureOpacityEnabled === null ? state.pressureOpacityEnabled : pressureOpacityEnabled,
      }));

      const scatterEnabled = asBoolean(toolMeta.scatterEnabled);
      if (scatterEnabled !== null) {
        toolStore.setScatterEnabled(scatterEnabled);
      }
      const scatterPatch = parseScatterSettings(toolMeta.scatter);
      if (scatterPatch) {
        toolStore.setScatter(scatterPatch as Parameters<typeof toolStore.setScatter>[0]);
      }

      const textureEnabled = asBoolean(toolMeta.textureEnabled);
      if (textureEnabled !== null) {
        toolStore.setTextureEnabled(textureEnabled);
      }
      const texturePatch = parseTextureSettings(toolMeta.textureSettings);
      if (texturePatch) {
        toolStore.setTextureSettings(
          texturePatch as Parameters<typeof toolStore.setTextureSettings>[0]
        );
      }

      const dualBrushEnabled = asBoolean(toolMeta.dualBrushEnabled);
      if (dualBrushEnabled !== null) {
        toolStore.setDualBrushEnabled(dualBrushEnabled);
      }
      const dualBrushPatch = parseDualBrushSettings(toolMeta.dualBrush);
      if (dualBrushPatch) {
        toolStore.setDualBrush(dualBrushPatch as Parameters<typeof toolStore.setDualBrush>[0]);
      }

      const wetEdgeEnabled = asBoolean(toolMeta.wetEdgeEnabled);
      if (wetEdgeEnabled !== null) {
        toolStore.setWetEdgeEnabled(wetEdgeEnabled);
      }
      const wetEdge = asFiniteNumber(toolMeta.wetEdge);
      if (wetEdge !== null) {
        toolStore.setWetEdge(wetEdge);
      }

      const noiseEnabled = asBoolean(toolMeta.noiseEnabled);
      if (noiseEnabled !== null) {
        toolStore.setNoiseEnabled(noiseEnabled);
      }
      if (isRecord(toolMeta.noiseSettings)) {
        const noiseSize = asFiniteNumber(toolMeta.noiseSettings.size);
        const noiseSizeJitter = asFiniteNumber(toolMeta.noiseSettings.sizeJitter);
        const noiseDensityJitter = asFiniteNumber(toolMeta.noiseSettings.densityJitter);
        toolStore.setNoiseSettings({
          ...(noiseSize !== null ? { size: noiseSize } : {}),
          ...(noiseSizeJitter !== null ? { sizeJitter: noiseSizeJitter } : {}),
          ...(noiseDensityJitter !== null ? { densityJitter: noiseDensityJitter } : {}),
        });
      }
      const buildupEnabled = asBoolean(toolMeta.buildupEnabled);
      if (buildupEnabled !== null) {
        toolStore.setBuildupEnabled(buildupEnabled);
      }

      if (applied.length > 0) {
        // eslint-disable-next-line no-console
        console.info('[StrokeCapture] replay context applied', applied);
      }
      if (warnings.length > 0) {
        // eslint-disable-next-line no-console
        console.warn('[StrokeCapture] replay context warnings', warnings);
      }
    };

    win.__strokeCaptureStart = () => {
      const started = startStrokeCapture?.() ?? false;
      if (started) {
        // eslint-disable-next-line no-console
        console.log('[StrokeCapture] recording started');
      }
      return started;
    };
    win.__strokeCaptureStop = () => {
      const capture = stopStrokeCapture?.() ?? null;
      if (capture) {
        // eslint-disable-next-line no-console
        console.log('[StrokeCapture] recording stopped', {
          samples: capture.samples.length,
          createdAt: capture.createdAt,
        });
      }
      return capture;
    };
    win.__strokeCaptureLast = () => {
      return getLastStrokeCapture?.() ?? null;
    };
    win.__kritaTailTraceStart = (options) => {
      const meta = mergeKritaTailMeta(buildDefaultKritaTailMeta(), options?.meta);
      return startKritaTailTraceSession({
        strokeId: options?.strokeId,
        meta,
      });
    };
    win.__kritaTailTraceStop = () => {
      return stopKritaTailTraceSession();
    };
    win.__kritaTailTraceLast = () => {
      return getLastKritaTailTrace();
    };
    win.__strokeCaptureReplay = async (capture, options) => {
      const resolvedCapture = parseStrokeCaptureInput(capture, getLastStrokeCapture?.() ?? null);
      if (!resolvedCapture) {
        console.warn('[StrokeCapture] replay skipped: invalid capture input');
        return null;
      }

      await applyReplayContext(resolvedCapture);
      // Let React commit zoom/offset/tool updates before converting replay points to client coords.
      await waitForAnimationFrame();
      await waitForAnimationFrame();
      const result = await replayStrokeCapture?.(resolvedCapture, options);
      // eslint-disable-next-line no-console
      console.log('[StrokeCapture] replay result', result);
      return result ?? null;
    };
    win.__strokeCaptureDownload = (fileName, capture) => {
      return downloadStrokeCapture?.(fileName, capture) ?? false;
    };
    win.__strokeCaptureSaveFixed = async (capture): Promise<FixedStrokeCaptureSaveResult> => {
      const fallbackCapture = getLastStrokeCapture?.() ?? null;
      const resolvedCapture = parseStrokeCaptureInput(capture, fallbackCapture);
      const fallbackSource: FixedCaptureSource = isTauriRuntime ? 'appconfig' : 'localstorage';
      const fallbackPath = getFallbackPath(fallbackSource);

      if (!resolvedCapture) {
        return {
          ok: false,
          path: fallbackPath,
          name: DEBUG_CAPTURE_FILE_NAME,
          source: fallbackSource,
          error: 'invalid capture input',
        };
      }

      const serialized = JSON.stringify(resolvedCapture, null, 2);

      if (isTauriRuntime) {
        try {
          await mkdir(DEBUG_CAPTURE_DIR, { baseDir: BaseDirectory.AppConfig, recursive: true });
          await writeTextFile(DEBUG_CAPTURE_RELATIVE_PATH, serialized, {
            baseDir: BaseDirectory.AppConfig,
          });
          return {
            ok: true,
            path: appConfigPath,
            name: DEBUG_CAPTURE_FILE_NAME,
            source: 'appconfig',
          };
        } catch (error) {
          return {
            ok: false,
            path: appConfigPath,
            name: DEBUG_CAPTURE_FILE_NAME,
            source: 'appconfig',
            error: String(error),
          };
        }
      }

      try {
        window.localStorage.setItem(DEBUG_CAPTURE_LOCAL_KEY, serialized);
        return {
          ok: true,
          path: localStoragePath,
          name: DEBUG_CAPTURE_FILE_NAME,
          source: 'localstorage',
        };
      } catch (error) {
        return {
          ok: false,
          path: localStoragePath,
          name: DEBUG_CAPTURE_FILE_NAME,
          source: 'localstorage',
          error: String(error),
        };
      }
    };
    win.__strokeCaptureLoadFixed = async (): Promise<FixedStrokeCaptureLoadResult | null> => {
      if (isTauriRuntime) {
        try {
          const hasFile = await exists(DEBUG_CAPTURE_RELATIVE_PATH, {
            baseDir: BaseDirectory.AppConfig,
          });
          if (!hasFile) {
            return null;
          }

          const serialized = await readTextFile(DEBUG_CAPTURE_RELATIVE_PATH, {
            baseDir: BaseDirectory.AppConfig,
          });
          const capture = parseStrokeCaptureInput(serialized, null);
          if (!capture) {
            return null;
          }

          return {
            capture,
            path: appConfigPath,
            name: DEBUG_CAPTURE_FILE_NAME,
            source: 'appconfig',
          };
        } catch {
          return null;
        }
      }

      try {
        const serialized = window.localStorage.getItem(DEBUG_CAPTURE_LOCAL_KEY);
        if (!serialized) return null;
        const capture = parseStrokeCaptureInput(serialized, null);
        if (!capture) return null;
        return {
          capture,
          path: localStoragePath,
          name: DEBUG_CAPTURE_FILE_NAME,
          source: 'localstorage',
        };
      } catch {
        return null;
      }
    };

    let m4ParityGate: ((options?: M4ParityGateOptions) => Promise<M4ParityGateResult>) | null =
      null;
    win.__gpuM4ParityGate = async (options?: M4ParityGateOptions): Promise<M4ParityGateResult> => {
      if (!m4ParityGate) {
        const { createM4ParityGate } = await import('@/test/m4FeatureParityGate');
        m4ParityGate = createM4ParityGate({
          replay: async (
            capture,
            replayOptions
          ): Promise<{ events: number; durationMs: number } | null> => {
            const fn = win.__strokeCaptureReplay;
            if (typeof fn !== 'function') {
              throw new Error('Missing API: window.__strokeCaptureReplay');
            }
            return fn(capture, replayOptions);
          },
          clearLayer: () => {
            const fn = win.__canvasClearLayer;
            if (typeof fn !== 'function') {
              throw new Error('Missing API: window.__canvasClearLayer');
            }
            fn();
          },
          getFlattenedImage: async () => {
            const fn = win.__getFlattenedImage;
            if (typeof fn !== 'function') {
              throw new Error('Missing API: window.__getFlattenedImage');
            }
            return fn();
          },
          loadFixedCapture: async () => {
            const fn = win.__strokeCaptureLoadFixed;
            if (typeof fn !== 'function') {
              throw new Error('Missing API: window.__strokeCaptureLoadFixed');
            }
            return fn();
          },
          parseStrokeCaptureInput,
          getRenderMode: () => useSettingsStore.getState().brush.renderMode,
          setRenderMode: (mode) => useSettingsStore.getState().setRenderMode(mode),
          waitForAnimationFrame,
          resetGpuDiagnostics,
          getGpuDiagnosticsSnapshot,
        });
      }
      return m4ParityGate(options);
    };

    async function tryGpuLayerExportDataUrl(layerId: string): Promise<string | undefined> {
      if (!exportGpuLayerImageData) return undefined;
      try {
        const image = await exportGpuLayerImageData(layerId);
        return image ? imageDataToDataUrl(image) : undefined;
      } catch (error) {
        console.warn('[M5] GPU layer export failed, fallback to CPU path', error);
        return undefined;
      }
    }

    async function tryGpuFlattenedExportImageData(
      context: 'flattened' | 'thumbnail'
    ): Promise<ImageData | null> {
      if (!exportGpuFlattenedImageData) return null;
      try {
        return await exportGpuFlattenedImageData();
      } catch (error) {
        console.warn(`[M5] GPU ${context} export failed, fallback to CPU path`, error);
        return null;
      }
    }

    // Get single layer image data as Base64 PNG data URL
    win.__getLayerImageData = async (layerId: string): Promise<string | undefined> => {
      const gpuDataUrl = await tryGpuLayerExportDataUrl(layerId);
      if (gpuDataUrl) return gpuDataUrl;

      await syncGpuLayerToCpu?.(layerId);
      if (!layerRendererRef.current) return undefined;
      const layer = layerRendererRef.current.getLayer(layerId);
      if (!layer) return undefined;

      // Export canvas as PNG data URL
      return layer.canvas.toDataURL('image/png');
    };

    win.__getLayerImageBytes = async (layerId: string): Promise<number[] | undefined> => {
      if (exportGpuLayerImageData) {
        try {
          const image = await exportGpuLayerImageData(layerId);
          if (image) {
            const canvas = imageDataToCanvas(image);
            if (!canvas) return undefined;
            const bytes = await canvasToPngBytes(canvas);
            return bytes ? Array.from(bytes) : undefined;
          }
        } catch (error) {
          console.warn('[M5] GPU layer bytes export failed, fallback to CPU path', error);
        }
      }

      await syncGpuLayerToCpu?.(layerId);
      if (!layerRendererRef.current) return undefined;
      const layer = layerRendererRef.current.getLayer(layerId);
      if (!layer) return undefined;
      const bytes = await canvasToPngBytes(layer.canvas);
      return bytes ? Array.from(bytes) : undefined;
    };

    // Get flattened (composited) image
    win.__getFlattenedImage = async (): Promise<string | undefined> => {
      const gpuImage = await tryGpuFlattenedExportImageData('flattened');
      if (gpuImage) {
        return imageDataToDataUrl(gpuImage);
      }

      await syncAllGpuLayersToCpu?.();
      if (!layerRendererRef.current) return undefined;
      const compositeCanvas = layerRendererRef.current.composite();
      return compositeCanvas.toDataURL('image/png');
    };

    win.__getFlattenedImageBytes = async (): Promise<number[] | undefined> => {
      const gpuImage = await tryGpuFlattenedExportImageData('flattened');
      if (gpuImage) {
        const canvas = imageDataToCanvas(gpuImage);
        if (!canvas) return undefined;
        const bytes = await canvasToPngBytes(canvas);
        return bytes ? Array.from(bytes) : undefined;
      }

      await syncAllGpuLayersToCpu?.();
      if (!layerRendererRef.current) return undefined;
      const compositeCanvas = layerRendererRef.current.composite();
      const bytes = await canvasToPngBytes(compositeCanvas);
      return bytes ? Array.from(bytes) : undefined;
    };

    // Get thumbnail (256x256)
    win.__getThumbnail = async (): Promise<string | undefined> => {
      let compositeCanvas: HTMLCanvasElement | null = null;
      const gpuImage = await tryGpuFlattenedExportImageData('thumbnail');
      if (gpuImage) {
        compositeCanvas = imageDataToCanvas(gpuImage);
      }

      if (!compositeCanvas) {
        await syncAllGpuLayersToCpu?.();
        if (!layerRendererRef.current) return undefined;
        compositeCanvas = layerRendererRef.current.composite();
      }
      if (!compositeCanvas) return undefined;

      // Create thumbnail canvas
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 256;
      thumbCanvas.height = 256;
      const ctx = thumbCanvas.getContext('2d');
      if (!ctx) return undefined;

      // Scale to fit 256x256 maintaining aspect ratio
      const scale = Math.min(256 / compositeCanvas.width, 256 / compositeCanvas.height);
      const w = compositeCanvas.width * scale;
      const h = compositeCanvas.height * scale;
      const x = (256 - w) / 2;
      const y = (256 - h) / 2;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 256, 256);
      ctx.drawImage(compositeCanvas, x, y, w, h);

      return thumbCanvas.toDataURL('image/png');
    };

    win.__getThumbnailBytes = async (): Promise<number[] | undefined> => {
      let compositeCanvas: HTMLCanvasElement | null = null;
      const gpuImage = await tryGpuFlattenedExportImageData('thumbnail');
      if (gpuImage) {
        compositeCanvas = imageDataToCanvas(gpuImage);
      }

      if (!compositeCanvas) {
        await syncAllGpuLayersToCpu?.();
        if (!layerRendererRef.current) return undefined;
        compositeCanvas = layerRendererRef.current.composite();
      }
      if (!compositeCanvas) return undefined;

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 256;
      thumbCanvas.height = 256;
      const ctx = thumbCanvas.getContext('2d');
      if (!ctx) return undefined;

      const scale = Math.min(256 / compositeCanvas.width, 256 / compositeCanvas.height);
      const w = compositeCanvas.width * scale;
      const h = compositeCanvas.height * scale;
      const x = (256 - w) / 2;
      const y = (256 - h) / 2;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 256, 256);
      ctx.drawImage(compositeCanvas, x, y, w, h);
      const bytes = await canvasToPngBytes(thumbCanvas);
      return bytes ? Array.from(bytes) : undefined;
    };

    // Load layer images when opening a file
    // Uses project:// custom protocol for zero-copy binary transfer
    // Supports both encoded images (PNG/WebP) and raw RGBA data (with optional LZ4 compression)
    win.__loadLayerImages = async (
      layersData: Array<{ id: string; imageData?: string; offsetX?: number; offsetY?: number }>,
      benchmarkSessionId?: string
    ): Promise<void> => {
      if (!layerRendererRef.current) return;

      const docState = useDocumentStore.getState();
      const docWidth = docState.width;
      const docHeight = docState.height;
      const updateLayerThumbnail = docState.updateLayerThumbnail;

      function updateThumbnailForLayer(layerId: string, layerCanvas: HTMLCanvasElement): void {
        const thumb = renderLayerThumbnail(layerCanvas, docWidth, docHeight);
        if (thumb) updateLayerThumbnail(layerId, thumb);
      }

      let fetchTotal = 0;
      let decompressTotal = 0;
      let renderTotal = 0;
      const loadedLayerIds: string[] = [];

      for (const layerData of layersData) {
        const layer = layerRendererRef.current.getLayer(layerData.id);
        if (!layer) continue;
        loadedLayerIds.push(layerData.id);

        // Get offset for layer positioning
        const offsetX = layerData.offsetX ?? 0;
        const offsetY = layerData.offsetY ?? 0;

        // Determine image source: project:// protocol or legacy base64
        if (layerData.imageData) {
          // Legacy: base64 data provided (for backward compatibility)
          const imgSrc = layerData.imageData.startsWith('data:')
            ? layerData.imageData
            : `data:image/png;base64,${layerData.imageData}`;

          const img = new Image();
          img.crossOrigin = 'anonymous';
          await new Promise<void>((resolve) => {
            img.onload = () => {
              layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
              layer.ctx.drawImage(img, offsetX, offsetY);
              updateThumbnailForLayer(layerData.id, layer.canvas);
              resolve();
            };
            img.onerror = () => resolve();
            img.src = imgSrc;
          });
        } else {
          // New: use project:// custom protocol
          const url = buildProjectProtocolUrl(`/layer/${layerData.id}`);
          try {
            const fetchStart = performance.now();
            const response = await fetch(url);
            const buffer = await response.arrayBuffer();
            fetchTotal += performance.now() - fetchStart;

            const contentType = response.headers.get('Content-Type') || '';
            const imgWidth = parseInt(response.headers.get('X-Image-Width') || '0');
            const imgHeight = parseInt(response.headers.get('X-Image-Height') || '0');

            if (contentType === 'image/x-rgba-lz4') {
              // LZ4-compressed RGBA data - decompress first
              const decompressStart = performance.now();
              const decompressed = decompressLz4PrependSize(new Uint8Array(buffer));
              decompressTotal += performance.now() - decompressStart;

              if (imgWidth > 0 && imgHeight > 0) {
                const renderStart = performance.now();
                const imageData = new ImageData(
                  new Uint8ClampedArray(decompressed),
                  imgWidth,
                  imgHeight
                );
                layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
                layer.ctx.putImageData(imageData, offsetX, offsetY);
                updateThumbnailForLayer(layerData.id, layer.canvas);
                renderTotal += performance.now() - renderStart;
              }
            } else if (contentType === 'image/x-rgba') {
              // Raw RGBA data (uncompressed) - use ImageData for fast rendering
              if (imgWidth > 0 && imgHeight > 0) {
                const renderStart = performance.now();
                const imageData = new ImageData(new Uint8ClampedArray(buffer), imgWidth, imgHeight);
                layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
                layer.ctx.putImageData(imageData, offsetX, offsetY);
                updateThumbnailForLayer(layerData.id, layer.canvas);
                renderTotal += performance.now() - renderStart;
              }
            } else {
              // Encoded image (PNG/WebP) - use Image element
              const renderStart = performance.now();
              // Create blob from already-fetched buffer (response body was consumed by arrayBuffer())
              const blob = new Blob([buffer], { type: contentType });
              const bitmap = await createImageBitmap(blob);
              layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
              layer.ctx.drawImage(bitmap, offsetX, offsetY);
              updateThumbnailForLayer(layerData.id, layer.canvas);
              renderTotal += performance.now() - renderStart;
            }
          } catch (e) {
            console.warn(`Failed to load layer image: ${layerData.id}`, e);
          }
        }
      }

      if (loadedLayerIds.length > 0) {
        markGpuLayerDirty?.(loadedLayerIds);
      }

      // Report benchmark phases to backend if session ID is provided
      if (benchmarkSessionId) {
        await invoke('report_benchmark', {
          sessionId: benchmarkSessionId,
          phase: 'fetch',
          durationMs: fetchTotal,
        });
        await invoke('report_benchmark', {
          sessionId: benchmarkSessionId,
          phase: 'decompress',
          durationMs: decompressTotal,
        });
        await invoke('report_benchmark', {
          sessionId: benchmarkSessionId,
          phase: 'render',
          durationMs: renderTotal,
        });
        // Signal completion to trigger final report
        const report = await invoke<string | null>('report_benchmark', {
          sessionId: benchmarkSessionId,
          phase: 'complete',
          durationMs: 0,
        });
        // Output benchmark report to browser console
        if (report) {
          // console.log(report);
        }
      }

      // Trigger re-render
      compositeAndRender();
    };

    return () => {
      delete win.__canvasFillLayer;
      delete win.__canvasClearSelection;
      delete win.__getLayerImageData;
      delete win.__getLayerImageBytes;
      delete win.__getFlattenedImage;
      delete win.__getFlattenedImageBytes;
      delete win.__getThumbnail;
      delete win.__getThumbnailBytes;
      delete win.__loadLayerImages;
      delete win.__canvasUndo;
      delete win.__canvasRedo;
      delete win.__canvasHistoryJumpTo;
      delete win.__canvasClearLayer;
      delete win.__canvasDuplicateLayer;
      delete win.__canvasSetLayerOpacity;
      delete win.__canvasSetLayerBlendMode;
      delete win.__canvasRemoveLayer;
      delete win.__canvasRemoveLayers;
      delete win.__canvasMergeSelectedLayers;
      delete win.__canvasMergeAllLayers;
      delete win.__canvasResize;
      delete win.__gpuM0Baseline;
      delete win.__gpuFormatCompare;
      delete win.__gpuTileSizeCompare;
      delete win.__gpuBrushDiagnostics;
      delete win.__gpuBrushDiagnosticsReset;
      delete win.__gpuLayerStackCacheStats;
      delete win.__gpuBrushCommitMetrics;
      delete win.__gpuBrushCommitMetricsReset;
      delete win.__gpuBrushCommitReadbackMode;
      delete win.__gpuBrushCommitReadbackModeSet;
      delete win.__gpuBrushNoReadbackPilot;
      delete win.__gpuBrushNoReadbackPilotSet;
      delete win.__brushStrokeFinalizeDebug;
      delete win.__brushTailTaperDebug;
      delete win.__strokeCaptureStart;
      delete win.__strokeCaptureStop;
      delete win.__strokeCaptureLast;
      delete win.__kritaTailTraceStart;
      delete win.__kritaTailTraceStop;
      delete win.__kritaTailTraceLast;
      delete win.__strokeCaptureReplay;
      delete win.__strokeCaptureDownload;
      delete win.__strokeCaptureSaveFixed;
      delete win.__strokeCaptureLoadFixed;
      delete win.__gpuM4ParityGate;
    };
  }, [
    layerRendererRef,
    compositeAndRender,
    fillActiveLayer,
    handleClearSelection,
    handleUndo,
    handleRedo,
    jumpToHistoryIndex,
    handleClearLayer,
    handleDuplicateLayer,
    handleRemoveLayer,
    handleRemoveLayers,
    handleMergeSelectedLayers,
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
    markGpuLayerDirty,
    exportGpuLayerImageData,
    exportGpuFlattenedImageData,
    syncGpuLayerToCpu,
    syncAllGpuLayersToCpu,
    startStrokeCapture,
    stopStrokeCapture,
    getLastStrokeCapture,
    replayStrokeCapture,
    downloadStrokeCapture,
  ]);
}
