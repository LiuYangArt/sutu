import { useEffect, type RefObject } from 'react';
import { useDocumentStore, type ResizeCanvasOptions } from '@/stores/document';
import { useViewportStore } from '@/stores/viewport';
import { useSettingsStore } from '@/stores/settings';
import { useToolStore, type ToolType, type PressureCurve } from '@/stores/tool';
import { LayerRenderer } from '@/utils/layerRenderer';
import { decompressLz4PrependSize } from '@/utils/lz4';
import { renderLayerThumbnail } from '@/utils/layerThumbnail';
import {
  parseDualBrushSettings,
  parseScatterSettings,
  parseTextureSettings,
} from './replayContextParsers';
import {
  DEBUG_CAPTURE_DIR,
  DEBUG_CAPTURE_FILE_NAME,
  DEBUG_CAPTURE_LOCAL_KEY,
  DEBUG_CAPTURE_RELATIVE_PATH,
  type FixedCaptureSource,
  type FixedStrokeCaptureLoadResult,
  type FixedStrokeCaptureSaveResult,
  type StrokeCaptureData,
  type StrokeReplayOptions,
} from '@/test';
import {
  createM4ParityGate,
  type M4ParityGateOptions,
  type M4ParityGateResult,
} from '@/test/m4FeatureParityGate';
import {
  GPUContext,
  type GpuBrushCommitReadbackMode,
  persistResidencyBudgetFromProbe,
  runFormatCompare,
  runM0Baseline,
  runTileSizeCompare,
  type GpuBrushCommitMetricsSnapshot,
} from '@/gpu';

interface UseGlobalExportsParams {
  layerRendererRef: RefObject<LayerRenderer | null>;
  compositeAndRender: () => void;
  fillActiveLayer: (color: string) => void;
  handleClearSelection: () => void;
  handleUndo: () => void;
  handleRedo: () => void;
  handleClearLayer: () => void;
  handleDuplicateLayer: (from: string, to: string) => void;
  handleRemoveLayer: (id: string) => void;
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
  'move',
  'select',
  'lasso',
  'zoom',
]);

const PRESSURE_CURVES = new Set<PressureCurve>(['linear', 'soft', 'hard', 'sCurve']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
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

export function useGlobalExports({
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
  getGpuLayerStackCacheStats,
  getGpuBrushCommitMetricsSnapshot,
  resetGpuBrushCommitMetrics,
  getGpuBrushCommitReadbackMode,
  setGpuBrushCommitReadbackMode,
  getGpuBrushNoReadbackPilot,
  setGpuBrushNoReadbackPilot,
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
      __getFlattenedImage?: () => Promise<string | undefined>;
      __getThumbnail?: () => Promise<string | undefined>;
      __loadLayerImages?: (
        layersData: Array<{ id: string; imageData?: string; offsetX?: number; offsetY?: number }>,
        benchmarkSessionId?: string
      ) => Promise<void>;
      __canvasUndo?: () => void;
      __canvasRedo?: () => void;
      __canvasClearLayer?: () => void;
      __canvasDuplicateLayer?: (from: string, to: string) => void;
      __canvasRemoveLayer?: (id: string) => void;
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
      __strokeCaptureStart?: () => boolean;
      __strokeCaptureStop?: () => StrokeCaptureData | null;
      __strokeCaptureLast?: () => StrokeCaptureData | null;
      __strokeCaptureReplay?: (
        capture?: StrokeCaptureData | string,
        options?: StrokeReplayOptions
      ) => Promise<{ events: number; durationMs: number } | null>;
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

    win.__canvasFillLayer = fillActiveLayer;
    win.__canvasClearSelection = handleClearSelection;
    win.__canvasUndo = handleUndo;
    win.__canvasRedo = handleRedo;
    win.__canvasClearLayer = handleClearLayer;
    win.__canvasDuplicateLayer = handleDuplicateLayer;
    win.__canvasRemoveLayer = handleRemoveLayer;
    win.__canvasResize = handleResizeCanvas;
    win.__gpuM0Baseline = async () => {
      const device = GPUContext.getInstance().device;
      if (!device) {
        console.warn('[M0Baseline] GPU device not available');
        return;
      }
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

      const result = await runFormatCompare(device, {
        includeLinearNoDither: options?.includeLinearNoDither ?? true,
        size: options?.size,
        ditherStrength: options?.ditherStrength,
      });

      try {
        const { mkdir, writeFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');
        const { join, tempDir } = await import('@tauri-apps/api/path');

        const folder = 'paintboard-gpu-compare';
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
          const { BaseDirectory, mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs');
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
          const { BaseDirectory, exists, readTextFile } = await import('@tauri-apps/plugin-fs');
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

    win.__gpuM4ParityGate = createM4ParityGate({
      replay: async (capture, options): Promise<{ events: number; durationMs: number } | null> => {
        const fn = win.__strokeCaptureReplay;
        if (typeof fn !== 'function') {
          throw new Error('Missing API: window.__strokeCaptureReplay');
        }
        return fn(capture, options);
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

    // Get single layer image data as Base64 PNG data URL
    win.__getLayerImageData = async (layerId: string): Promise<string | undefined> => {
      if (exportGpuLayerImageData) {
        try {
          const image = await exportGpuLayerImageData(layerId);
          if (image) {
            return imageDataToDataUrl(image);
          }
        } catch (error) {
          console.warn('[M5] GPU layer export failed, fallback to CPU path', error);
        }
      }

      await syncGpuLayerToCpu?.(layerId);
      if (!layerRendererRef.current) return undefined;
      const layer = layerRendererRef.current.getLayer(layerId);
      if (!layer) return undefined;

      // Export canvas as PNG data URL
      return layer.canvas.toDataURL('image/png');
    };

    // Get flattened (composited) image
    win.__getFlattenedImage = async (): Promise<string | undefined> => {
      if (exportGpuFlattenedImageData) {
        try {
          const image = await exportGpuFlattenedImageData();
          if (image) {
            return imageDataToDataUrl(image);
          }
        } catch (error) {
          console.warn('[M5] GPU flattened export failed, fallback to CPU path', error);
        }
      }

      await syncAllGpuLayersToCpu?.();
      if (!layerRendererRef.current) return undefined;
      const compositeCanvas = layerRendererRef.current.composite();
      return compositeCanvas.toDataURL('image/png');
    };

    // Get thumbnail (256x256)
    win.__getThumbnail = async (): Promise<string | undefined> => {
      let compositeCanvas: HTMLCanvasElement | null = null;
      if (exportGpuFlattenedImageData) {
        try {
          const image = await exportGpuFlattenedImageData();
          if (image) {
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.putImageData(image, 0, 0);
              compositeCanvas = canvas;
            }
          }
        } catch (error) {
          console.warn('[M5] GPU thumbnail export failed, fallback to CPU path', error);
        }
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
          const url = `http://project.localhost/layer/${layerData.id}`;
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
        const { invoke } = await import('@tauri-apps/api/core');
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
      delete win.__getFlattenedImage;
      delete win.__getThumbnail;
      delete win.__loadLayerImages;
      delete win.__canvasUndo;
      delete win.__canvasRedo;
      delete win.__canvasClearLayer;
      delete win.__canvasDuplicateLayer;
      delete win.__canvasRemoveLayer;
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
      delete win.__strokeCaptureStart;
      delete win.__strokeCaptureStop;
      delete win.__strokeCaptureLast;
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
    handleClearLayer,
    handleDuplicateLayer,
    handleRemoveLayer,
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
