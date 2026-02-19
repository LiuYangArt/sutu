/**
 * useBrushRenderer - Hook for Flow/Opacity three-level brush rendering pipeline
 *
 * This hook manages the stroke buffer and dab stamping to achieve
 * Photoshop-like brush behavior with proper Flow/Opacity separation.
 *
 * Supports two backends:
 * - WebGPU (GPU acceleration for large brushes)
 * - Canvas 2D (fallback for unsupported environments)
 */

import { useRef, useCallback, useEffect, useState } from 'react';
import {
  StrokeAccumulator,
  DabParams,
  MaskType,
  type Rect,
  type StrokeFinalizeDebugSnapshot,
} from '@/utils/strokeBuffer';
import {
  PressureCurve,
  BrushTexture,
  ShapeDynamicsSettings,
  ScatterSettings,
  ColorDynamicsSettings,
  TransferSettings,
  DualBrushSettings,
  DEFAULT_SHAPE_DYNAMICS,
  DEFAULT_TRANSFER_SETTINGS,
  useToolStore,
} from '@/stores/tool';
import type { TextureSettings } from '@/components/BrushPanel/types';
import { RenderMode } from '@/stores/settings';
import { LatencyProfiler } from '@/benchmark/LatencyProfiler';
import {
  GPUContext,
  GPUStrokeAccumulator,
  shouldUseGPU,
  reportGPUFallback,
  type RenderBackend,
  type StrokeCompositeMode,
  type GpuScratchHandle,
  type GpuStrokePrepareResult,
} from '@/gpu';
import {
  computeDabShape,
  calculateDirection,
  isShapeDynamicsActive,
  computeControlledSize,
  type DynamicsInput,
} from '@/utils/shapeDynamics';
import { applyScatter, isScatterActive } from '@/utils/scatterDynamics';
import {
  computeDabColor,
  createColorJitterSample,
  isColorDynamicsActive,
  type ColorJitterSample,
} from '@/utils/colorDynamics';
import { computeDabTransfer, isTransferActive } from '@/utils/transferDynamics';
import { computeTextureDepth } from '@/utils/textureDynamics';
import { useSelectionStore } from '@/stores/selection';
import { useToastStore } from '@/stores/toast';
import { logTabletTrace } from '@/utils/tabletTrace';
import {
  DualBrushSecondaryPipeline,
  KritaPressurePipeline,
  type KritaPressurePipelineConfig,
  combineCurveOption,
  createLinearSensorLut,
  createDefaultGlobalPressureLut,
  evaluateDynamicSensor,
  sampleGlobalPressureCurve,
  normalizeInputPhase,
  normalizeInputSource,
  type PaintInfo,
} from '@/engine/kritaParityInput';

const MIN_ROUNDNESS = 0.01;
const STROKE_PROGRESS_DISTANCE_PX = 1200;
const STROKE_PROGRESS_TIME_MS = 1500;
const STROKE_PROGRESS_DAB_COUNT = 180;
const MAX_RAW_TIME_DELTA_US = 1_000_000;

function resolveStrokeProgress(metrics: {
  distancePx: number;
  dabCount: number;
  startTimestampMs: number | null;
  currentTimestampMs: number | null;
}): {
  fadeProgress: number;
  distanceProgress: number;
  timeProgress: number;
  strokeProgress: number;
} {
  const distanceProgress = Math.max(
    0,
    Math.min(1, metrics.distancePx / STROKE_PROGRESS_DISTANCE_PX)
  );
  const timeElapsedMs =
    metrics.startTimestampMs !== null && metrics.currentTimestampMs !== null
      ? Math.max(0, metrics.currentTimestampMs - metrics.startTimestampMs)
      : 0;
  const timeProgress = Math.max(0, Math.min(1, timeElapsedMs / STROKE_PROGRESS_TIME_MS));
  const dabProgress = Math.max(0, Math.min(1, metrics.dabCount / STROKE_PROGRESS_DAB_COUNT));
  const strokeProgress = Math.max(distanceProgress, timeProgress, dabProgress);
  return {
    fadeProgress: strokeProgress,
    distanceProgress,
    timeProgress,
    strokeProgress,
  };
}

function clampRoundness(roundness: number): number {
  return Math.max(MIN_ROUNDNESS, Math.min(1, roundness));
}

function clampFiniteDeltaUs(deltaUs: number): number {
  if (!Number.isFinite(deltaUs) || deltaUs <= 0) return 0;
  return Math.min(MAX_RAW_TIME_DELTA_US, Math.round(deltaUs));
}

function computeTipDimensions(
  size: number,
  roundness: number,
  texture?: BrushTexture | null
): { width: number; height: number } {
  const safeSize = Math.max(1, size);
  const roundnessScale = clampRoundness(roundness);

  if (texture?.width && texture?.height) {
    const aspect = texture.width / texture.height;
    let baseW = safeSize;
    let baseH = safeSize;

    if (aspect >= 1) {
      baseW = safeSize;
      baseH = safeSize / aspect;
    } else {
      baseH = safeSize;
      baseW = safeSize * aspect;
    }

    return {
      width: baseW,
      height: baseH * roundnessScale,
    };
  }

  return {
    width: safeSize,
    height: safeSize * roundnessScale,
  };
}

function computeSpacingBasePx(
  size: number,
  roundness: number,
  texture?: BrushTexture | null
): number {
  const { width, height } = computeTipDimensions(size, roundness, texture);
  return Math.min(width, height);
}

function cloneDualBrushSettings(
  settings: DualBrushSettings | null | undefined
): DualBrushSettings | null {
  if (!settings) return null;
  return {
    ...settings,
    texture: settings.texture
      ? {
          ...settings.texture,
          cursorBounds: settings.texture.cursorBounds
            ? {
                ...settings.texture.cursorBounds,
              }
            : undefined,
        }
      : undefined,
  };
}

function createPipelineConfig(params: {
  pressureLut: Float32Array;
  speedPxPerMs: number;
  smoothingSamples: number;
  spacingPx: number;
  timedSpacingEnabled: boolean;
  maxIntervalMs: number;
}): KritaPressurePipelineConfig {
  return {
    pressure_enabled: true,
    global_pressure_lut: params.pressureLut,
    use_device_time_for_speed: false,
    max_allowed_speed_px_per_ms: params.speedPxPerMs,
    speed_smoothing_samples: params.smoothingSamples,
    spacing_px: params.spacingPx,
    max_interval_us: Math.max(1_000, Math.round(params.maxIntervalMs * 1000)),
    timed_spacing_enabled: params.timedSpacingEnabled,
  };
}

function createInitialPipelineConfig(): KritaPressurePipelineConfig {
  return createPipelineConfig({
    pressureLut: createDefaultGlobalPressureLut(),
    speedPxPerMs: 30,
    smoothingSamples: 3,
    spacingPx: 1,
    timedSpacingEnabled: false,
    maxIntervalMs: PIPELINE_BUILDUP_INTERVAL_MS,
  });
}

interface EffectiveDynamicsConfig {
  shapeDynamics: ShapeDynamicsSettings | null;
  transfer: TransferSettings | null;
}

function resolveEffectiveDynamicsConfig(config: BrushRenderConfig): EffectiveDynamicsConfig {
  let shapeDynamics: ShapeDynamicsSettings | null = null;
  const baseShape = config.shapeDynamics ?? DEFAULT_SHAPE_DYNAMICS;
  if (config.shapeDynamicsEnabled) {
    shapeDynamics = config.pressureSizeEnabled
      ? { ...baseShape, sizeControl: 'penPressure' }
      : baseShape;
  } else if (config.pressureSizeEnabled) {
    shapeDynamics = {
      ...DEFAULT_SHAPE_DYNAMICS,
      sizeControl: 'penPressure',
      minimumDiameter: 0,
    };
  }

  const baseTransfer = config.transfer ?? DEFAULT_TRANSFER_SETTINGS;
  let transfer: TransferSettings | null = null;
  if (config.transferEnabled) {
    transfer = baseTransfer;
  } else if (config.pressureFlowEnabled || config.pressureOpacityEnabled) {
    transfer = DEFAULT_TRANSFER_SETTINGS;
  }

  if (transfer) {
    const forcedTransfer: TransferSettings = {
      ...transfer,
      flowControl: config.pressureFlowEnabled ? 'penPressure' : transfer.flowControl,
      opacityControl: config.pressureOpacityEnabled ? 'penPressure' : transfer.opacityControl,
    };
    transfer = isTransferActive(forcedTransfer) ? forcedTransfer : null;
  }

  return {
    shapeDynamics,
    transfer,
  };
}

function resolveRenderableDabSizeAndOpacity(
  rawSize: number,
  baseDabOpacity: number
): { size: number; dabOpacity: number } {
  const safeOpacity = Number.isFinite(baseDabOpacity) ? Math.max(0, baseDabOpacity) : 0;
  const safeSize = Number.isFinite(rawSize) ? rawSize : 0;
  if (safeSize >= 1) {
    return { size: safeSize, dabOpacity: safeOpacity };
  }

  // Keep sub-pixel width information via alpha coverage while rendering a 1px footprint.
  const clampedSubPixelSize = Math.max(0.01, safeSize);
  const coverage = Math.min(1, clampedSubPixelSize * clampedSubPixelSize);
  return {
    size: 1,
    dabOpacity: safeOpacity * coverage,
  };
}

const PIPELINE_DISTANCE_INTERVAL_MS = 16;
const PIPELINE_BUILDUP_INTERVAL_MS = 200;

const LINEAR_PRESSURE_SENSOR_LUT = createLinearSensorLut();
const LINEAR_PRESSURE_SENSOR_CONFIG = Object.freeze({
  enabled: true,
  input: 'pressure' as const,
  domain: 'scaling' as const,
  curve_lut: LINEAR_PRESSURE_SENSOR_LUT,
});

export interface BrushRenderConfig {
  size: number;
  flow: number;
  opacity: number;
  hardness: number;
  maskType: MaskType; // Unified soft-edge profile: gaussian
  spacing: number; // Fraction of tip short edge (0-10)
  roundness: number; // 0-100 (100 = circle, <100 = ellipse)
  angle: number; // 0-360 degrees
  color: string;
  backgroundColor: string; // For F/B jitter
  pressureSizeEnabled: boolean;
  pressureFlowEnabled: boolean;
  pressureOpacityEnabled: boolean;
  globalPressureLut?: Float32Array;
  maxBrushSpeedPxPerMs?: number;
  brushSpeedSmoothingSamples?: number;
  lowPressureAdaptiveSmoothingEnabled?: boolean;
  pressureCurve: PressureCurve;
  texture?: BrushTexture | null; // Texture for sampled brushes (from ABR import)
  // Shape Dynamics settings (Photoshop-compatible)
  shapeDynamicsEnabled: boolean;
  shapeDynamics?: ShapeDynamicsSettings;
  // Scatter settings (Photoshop-compatible)
  scatterEnabled: boolean;
  scatter?: ScatterSettings;
  // Color Dynamics settings (Photoshop-compatible)
  colorDynamicsEnabled: boolean;
  colorDynamics?: ColorDynamicsSettings;
  // Wet Edge settings (Photoshop-compatible)
  wetEdgeEnabled: boolean;
  wetEdge: number; // Wet edge strength (0-1)
  // Build-up settings (Photoshop-compatible)
  buildupEnabled: boolean;
  // Transfer settings (Photoshop-compatible)
  transferEnabled: boolean;
  transfer?: TransferSettings;
  // Texture settings (Photoshop-compatible pattern texture)
  textureEnabled: boolean;
  textureSettings?: TextureSettings | null;
  // Noise settings (Photoshop-compatible)
  noiseEnabled: boolean;
  noiseSize?: number; // 1-100 (%)
  noiseSizeJitter?: number; // 0-100 (%)
  noiseDensityJitter?: number; // 0-100 (%)
  // Dual Brush settings (Photoshop-compatible)
  dualBrushEnabled: boolean;
  dualBrush?: DualBrushSettings;
  // When true, selection clipping is fully handled in GPU compositing shader.
  selectionHandledByGpu?: boolean;
  strokeCompositeMode: StrokeCompositeMode;
}

export interface UseBrushRendererProps {
  width: number;
  height: number;
  /** User-selected render mode */
  renderMode: RenderMode;
  /** Optional LatencyProfiler for benchmarking */
  benchmarkProfiler?: LatencyProfiler;
}

export interface UseBrushRendererResult {
  beginStroke: (hardness?: number, wetEdge?: number) => Promise<void>;
  processPoint: (
    x: number,
    y: number,
    pressure: number,
    config: BrushRenderConfig,
    pointIndex?: number,
    dynamics?: { tiltX?: number; tiltY?: number; rotation?: number },
    inputMeta?: {
      timestampMs?: number;
      source?: 'wintab' | 'macnative' | 'pointerevent';
      phase?: 'down' | 'move' | 'up' | 'hover';
      hostTimeUs?: number;
      deviceTimeUs?: number;
    }
  ) => void;
  endStroke: (layerCtx: CanvasRenderingContext2D) => Promise<void>;
  getPreviewCanvas: () => HTMLCanvasElement | null;
  getPreviewOpacity: () => number;
  getPreviewCompositeMode: () => StrokeCompositeMode;
  isStrokeActive: () => boolean;
  getLastDabPosition: () => { x: number; y: number } | null;
  /** Flush pending dabs to GPU (call once per frame) */
  flushPending: () => void;
  /** Actual backend in use (may differ from requested if GPU unavailable) */
  backend: RenderBackend;
  /** Whether GPU is available */
  gpuAvailable: boolean;
  getDebugRects: () => Array<{ rect: Rect; label: string; color: string }> | null;
  setGpuPreviewReadbackEnabled: (enabled: boolean) => void;
  getScratchHandle: () => GpuScratchHandle | null;
  prepareStrokeEndGpu: () => Promise<GpuStrokePrepareResult>;
  clearScratchGpu: () => void;
  /** @deprecated Use getScratchHandle instead. */
  getGpuScratchTexture: () => GPUTexture | null;
  /** @deprecated Use prepareStrokeEndGpu instead. */
  prepareEndStrokeGpu: () => Promise<void>;
  /** @deprecated Use clearScratchGpu instead. */
  clearGpuScratch: () => void;
  /** @deprecated Use prepareStrokeEndGpu() result.dirtyRect instead. */
  getGpuDirtyRect: () => Rect | null;
  /** @deprecated Use getScratchHandle() result.renderScale instead. */
  getGpuRenderScale: () => number;
  getGpuDiagnosticsSnapshot: () => unknown;
  resetGpuDiagnostics: () => boolean;
  getStrokeFinalizeDebugSnapshot: () => StrokeFinalizeDebugSnapshot | null;
}

type StrokeFinalizeTrigger = 'end-stroke' | 'prepare-gpu';

interface StrokeDualBrushLockState {
  locked: boolean;
  enabled: boolean;
  dualBrush: DualBrushSettings | null;
}

export function useBrushRenderer({
  width,
  height,
  renderMode,
  benchmarkProfiler,
}: UseBrushRendererProps): UseBrushRendererResult {
  const [gpuAvailable, setGpuAvailable] = useState(false);
  const [forceCpu, setForceCpu] = useState(false);
  const pushToast = useToastStore((s) => s.pushToast);
  const dualBrush = useToolStore((s) => s.dualBrush);

  // CPU backend (Canvas 2D)
  const cpuBufferRef = useRef<StrokeAccumulator | null>(null);

  // GPU backend (WebGPU)
  const gpuBufferRef = useRef<GPUStrokeAccumulator | null>(null);

  const primaryPipelineRef = useRef<KritaPressurePipeline>(
    new KritaPressurePipeline(createInitialPipelineConfig())
  );
  const secondaryPipelineRef = useRef<DualBrushSecondaryPipeline>(
    new DualBrushSecondaryPipeline(createInitialPipelineConfig())
  );

  // Optimization 7: Finishing lock to prevent "tailgating" race condition
  // When stroke 2 starts during stroke 1's await prepareEndStroke(),
  // stroke 2's clear() would wipe stroke 1's previewCanvas before composite.
  const finishingPromiseRef = useRef<Promise<void> | null>(null);
  const gpuCommitLockActiveRef = useRef(false);
  const gpuCommitLockResolveRef = useRef<(() => void) | null>(null);
  const strokeFinalizeRef = useRef<{
    finalized: boolean;
    trigger: StrokeFinalizeTrigger | null;
  }>({
    finalized: false,
    trigger: null,
  });
  const strokeCancelledRef = useRef(false);
  const strokeDualBrushLockRef = useRef<StrokeDualBrushLockState>({
    locked: false,
    enabled: false,
    dualBrush: null,
  });
  const strokeFinalizeDebugSnapshotRef = useRef<StrokeFinalizeDebugSnapshot | null>(null);
  const dualBrushTextureIdRef = useRef<string | null>(null);

  // Shape Dynamics: Track previous dab position for direction calculation
  const prevDabPosRef = useRef<{ x: number; y: number } | null>(null);
  const prevSecondaryDabPosRef = useRef<{ x: number; y: number } | null>(null);
  // Shape Dynamics: Capture initial direction at stroke start
  const initialDirectionRef = useRef<number | null>(null);
  const lastDabPosRef = useRef<{ x: number; y: number } | null>(null);

  // Stroke Opacity (Photoshop-like): applied when compositing stroke buffer to layer.
  // We store it in a ref because endStroke() does not receive config.
  const strokeOpacityRef = useRef<number>(1.0);
  const strokeCompositeModeRef = useRef<StrokeCompositeMode>('paint');
  const strokeCompositeModeLockedRef = useRef(false);
  const strokeColorJitterSampleRef = useRef<ColorJitterSample | null>(null);
  const lastConfigRef = useRef<BrushRenderConfig | null>(null);
  const lastPointerDynamicsRef = useRef<{ tiltX: number; tiltY: number; rotation: number }>({
    tiltX: 0,
    tiltY: 0,
    rotation: 0,
  });
  const lastSpacingPxRef = useRef(1);
  const strokeDabCountRef = useRef(0);
  const strokeDistanceRef = useRef(0);
  const strokeStartTimestampMsRef = useRef<number | null>(null);
  const strokeCurrentTimestampMsRef = useRef<number | null>(null);
  const normalizedTimeRef = useRef<{
    lastTimestampMs: number | null;
    lastRawHostUs: number | null;
    lastRawDeviceUs: number | null;
    hostUs: number;
    deviceUs: number;
  }>({
    lastTimestampMs: null,
    lastRawHostUs: null,
    lastRawDeviceUs: null,
    hostUs: 0,
    deviceUs: 0,
  });

  // Initialize WebGPU backend
  useEffect(() => {
    if (!shouldUseGPU()) {
      reportGPUFallback('WebGPU not available or disabled');
      return;
    }

    const initGPU = async () => {
      try {
        const ctx = GPUContext.getInstance();
        const supported = await ctx.initialize();

        if (supported && ctx.device) {
          gpuBufferRef.current = new GPUStrokeAccumulator(ctx.device, width, height);
          const initialDualBrush = useToolStore.getState().dualBrush;
          await gpuBufferRef.current.prewarmDualStroke(initialDualBrush);
          setGpuAvailable(true);
          benchmarkProfiler?.setDevice(ctx.device);
        } else {
          reportGPUFallback('WebGPU initialization failed');
        }
      } catch (error) {
        console.error('[useBrushRenderer] GPU init error:', error);
        reportGPUFallback('WebGPU initialization threw error');
      }
    };

    void initGPU();

    return () => {
      gpuBufferRef.current?.destroy();
      gpuBufferRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally run once; resize handled in separate effect
  }, []);

  // Handle resize for GPU buffer
  useEffect(() => {
    if (gpuAvailable && gpuBufferRef.current) {
      gpuBufferRef.current.resize(width, height);
    }
  }, [width, height, gpuAvailable]);

  useEffect(() => {
    if (!gpuAvailable || !gpuBufferRef.current) {
      return;
    }

    if (!dualBrush?.texture) {
      dualBrushTextureIdRef.current = null;
      return;
    }

    const textureId = dualBrush.texture.id;
    if (dualBrushTextureIdRef.current === textureId) {
      return;
    }

    dualBrushTextureIdRef.current = textureId;
    gpuBufferRef.current.prewarmDualBrushTexture(dualBrush.texture);
  }, [gpuAvailable, dualBrush?.texture]);

  // Determine actual backend based on renderMode and GPU availability
  const backend: RenderBackend =
    gpuAvailable && gpuBufferRef.current && renderMode === 'gpu' && !forceCpu ? 'gpu' : 'canvas2d';

  // Ensure CPU buffer exists (for fallback or canvas2d mode)
  const ensureCPUBuffer = useCallback(() => {
    if (!cpuBufferRef.current) {
      cpuBufferRef.current = new StrokeAccumulator(width, height);
    } else {
      const dims = cpuBufferRef.current.getDimensions();
      if (dims.width !== width || dims.height !== height) {
        cpuBufferRef.current.resize(width, height);
      }
    }
    return cpuBufferRef.current;
  }, [width, height]);

  /**
   * Begin a new brush stroke
   * Optimization 7: Wait for previous stroke to finish before starting new one
   * This prevents "tailgating" where new stroke's clear() wipes previous stroke's data
   */
  const beginStroke = useCallback(
    async (hardness: number = 100, wetEdge: number = 0): Promise<void> => {
      // Optimization 7: Wait for previous stroke to finish
      if (finishingPromiseRef.current) {
        await finishingPromiseRef.current;
      }

      strokeCancelledRef.current = false;
      primaryPipelineRef.current.reset();
      secondaryPipelineRef.current.reset();
      strokeDualBrushLockRef.current = {
        locked: false,
        enabled: false,
        dualBrush: null,
      };
      strokeFinalizeDebugSnapshotRef.current = null;

      // Shape Dynamics: Reset direction tracking for new stroke
      prevDabPosRef.current = null;
      prevSecondaryDabPosRef.current = null;
      initialDirectionRef.current = null;
      lastDabPosRef.current = null;
      strokeOpacityRef.current = 1.0;
      strokeCompositeModeRef.current = 'paint';
      strokeCompositeModeLockedRef.current = false;
      strokeColorJitterSampleRef.current = null;
      lastConfigRef.current = null;
      lastPointerDynamicsRef.current = { tiltX: 0, tiltY: 0, rotation: 0 };
      lastSpacingPxRef.current = 1;
      strokeDabCountRef.current = 0;
      strokeDistanceRef.current = 0;
      strokeStartTimestampMsRef.current = null;
      strokeCurrentTimestampMsRef.current = null;
      normalizedTimeRef.current = {
        lastTimestampMs: null,
        lastRawHostUs: null,
        lastRawDeviceUs: null,
        hostUs: 0,
        deviceUs: 0,
      };
      strokeFinalizeRef.current = {
        finalized: false,
        trigger: null,
      };

      if (backend === 'gpu' && gpuBufferRef.current) {
        gpuBufferRef.current.beginStroke();
      } else {
        const buffer = ensureCPUBuffer();
        buffer.beginStroke(hardness / 100, wetEdge);
      }
    },
    [backend, ensureCPUBuffer]
  );

  const mapStamperPressureToBrush = useCallback(
    (_config: BrushRenderConfig, stamperPressure: number): number => {
      if (!Number.isFinite(stamperPressure)) return 0;
      return Math.max(0, Math.min(1, stamperPressure));
    },
    []
  );

  const resolveDabFlowAndOpacity = useCallback(
    (
      config: BrushRenderConfig,
      dynamicsInput: DynamicsInput,
      effectiveTransfer: TransferSettings | null
    ) => {
      const strokeOpacity = strokeOpacityRef.current;
      const hasStrokeOpacity = strokeOpacity > 1e-6;
      if (effectiveTransfer) {
        const transferResult = computeDabTransfer(
          strokeOpacity,
          config.flow,
          effectiveTransfer,
          dynamicsInput
        );
        return {
          flow: transferResult.flow,
          dabOpacity: hasStrokeOpacity ? transferResult.opacity / strokeOpacity : 0,
        };
      }
      return {
        flow: config.flow,
        dabOpacity: hasStrokeOpacity ? 1 : 0,
      };
    },
    []
  );

  const stampDabToBackend = useCallback(
    (dabParams: DabParams): void => {
      if (backend === 'gpu' && gpuBufferRef.current) {
        gpuBufferRef.current.stampDab(dabParams);
      } else if (cpuBufferRef.current) {
        const cpuBuffer = cpuBufferRef.current;
        if (cpuBuffer.isUsingRustPath()) {
          void cpuBuffer.stampDabRust(dabParams);
        } else {
          cpuBuffer.stampDab(dabParams);
        }
      }
    },
    [backend]
  );

  const stampSecondaryDabs = useCallback(
    (
      dabs: Array<{ x: number; y: number }>,
      secondarySize: number,
      dualBrushSettings: DualBrushSettings
    ): void => {
      for (const secDab of dabs) {
        let secondaryDirection = 0;
        if (prevSecondaryDabPosRef.current) {
          secondaryDirection = calculateDirection(
            prevSecondaryDabPosRef.current.x,
            prevSecondaryDabPosRef.current.y,
            secDab.x,
            secDab.y
          );
        }
        prevSecondaryDabPosRef.current = { x: secDab.x, y: secDab.y };

        if (backend === 'gpu' && gpuBufferRef.current) {
          gpuBufferRef.current.stampSecondaryDab(
            secDab.x,
            secDab.y,
            secondarySize,
            dualBrushSettings,
            (secondaryDirection * Math.PI) / 180
          );
        } else {
          const cpuBuffer = ensureCPUBuffer();
          cpuBuffer.stampSecondaryDab(
            secDab.x,
            secDab.y,
            secondarySize,
            {
              ...dualBrushSettings,
              brushTexture: dualBrushSettings.texture,
            },
            (secondaryDirection * Math.PI) / 180
          );
        }
      }
    },
    [backend, ensureCPUBuffer]
  );

  const resolveStrokeLockedConfig = useCallback((config: BrushRenderConfig): BrushRenderConfig => {
    const dualBrushLock = strokeDualBrushLockRef.current;
    if (!dualBrushLock.locked) {
      const initialDualBrush =
        config.dualBrushEnabled && config.dualBrush
          ? cloneDualBrushSettings(config.dualBrush)
          : null;
      dualBrushLock.locked = true;
      dualBrushLock.enabled = Boolean(initialDualBrush);
      dualBrushLock.dualBrush = initialDualBrush;
    }

    if (dualBrushLock.enabled && dualBrushLock.dualBrush) {
      return { ...config, dualBrushEnabled: true, dualBrush: dualBrushLock.dualBrush };
    }

    return { ...config, dualBrushEnabled: false, dualBrush: undefined };
  }, []);

  const renderPrimaryDabs = useCallback(
    (
      dabs: Array<{
        x: number;
        y: number;
        pressure: number;
        timestampMs?: number;
        normalizedSpeed?: number;
        timeUs?: number;
      }>,
      config: BrushRenderConfig,
      dynamics: { tiltX: number; tiltY: number; rotation: number }
    ): void => {
      if (dabs.length === 0) {
        return;
      }

      const effectiveDynamics = resolveEffectiveDynamicsConfig(config);
      const effectiveShapeDynamics = effectiveDynamics.shapeDynamics;
      const effectiveTransfer = effectiveDynamics.transfer;
      const tiltX = dynamics.tiltX;
      const tiltY = dynamics.tiltY;
      const rotation = dynamics.rotation;

      const useShapeDynamics =
        effectiveShapeDynamics !== null && isShapeDynamicsActive(effectiveShapeDynamics);
      const delayFirstDabForInitialDirection =
        useShapeDynamics && effectiveShapeDynamics?.angleControl === 'initial';
      const useScatter = config.scatterEnabled && config.scatter && isScatterActive(config.scatter);
      const useColorDynamics =
        config.colorDynamicsEnabled &&
        config.colorDynamics &&
        isColorDynamicsActive(config.colorDynamics);
      const colorDynamicsApplyPerTip = config.colorDynamics?.applyPerTip !== false;
      let strokeColorJitterSample: ColorJitterSample | undefined;
      if (useColorDynamics && !colorDynamicsApplyPerTip) {
        if (!strokeColorJitterSampleRef.current) {
          strokeColorJitterSampleRef.current = createColorJitterSample();
        }
        strokeColorJitterSample = strokeColorJitterSampleRef.current;
      }

      const selectionState = useSelectionStore.getState();
      const hasSelection = selectionState.hasSelection;
      const skipCpuSelectionCheck = backend === 'gpu' && config.selectionHandledByGpu === true;

      for (const dab of dabs) {
        if (
          !skipCpuSelectionCheck &&
          hasSelection &&
          !selectionState.isPointInSelection(dab.x, dab.y)
        ) {
          continue;
        }

        lastDabPosRef.current = { x: dab.x, y: dab.y };
        strokeDabCountRef.current += 1;

        const dabTimestampMs =
          typeof dab.timestampMs === 'number' && Number.isFinite(dab.timestampMs)
            ? dab.timestampMs
            : null;
        if (dabTimestampMs !== null) {
          if (strokeStartTimestampMsRef.current === null) {
            strokeStartTimestampMsRef.current = dabTimestampMs;
          }
          strokeCurrentTimestampMsRef.current = dabTimestampMs;
        }

        const basePressure = mapStamperPressureToBrush(config, dab.pressure);
        const sensorInfo: PaintInfo = {
          x_px: dab.x,
          y_px: dab.y,
          pressure_01: basePressure,
          drawing_speed_01:
            typeof dab.normalizedSpeed === 'number' && Number.isFinite(dab.normalizedSpeed)
              ? Math.max(0, Math.min(1, dab.normalizedSpeed))
              : 0,
          time_us:
            typeof dab.timeUs === 'number' && Number.isFinite(dab.timeUs)
              ? Math.max(0, Math.round(dab.timeUs))
              : Math.max(0, Math.round((dab.timestampMs ?? 0) * 1000)),
        };
        const pressureSensor = evaluateDynamicSensor(sensorInfo, LINEAR_PRESSURE_SENSOR_CONFIG);
        const dabPressure = combineCurveOption({
          constant: 1,
          values: [pressureSensor],
          mode: 'multiply',
          min: 0,
          max: 1,
        });
        let dabSize = config.size;
        let dabRoundness = config.roundness / 100;
        let dabAngle = config.angle;
        let dabFlipX = false;
        let dabFlipY = false;

        let direction = 0;
        if (prevDabPosRef.current) {
          strokeDistanceRef.current += Math.hypot(
            dab.x - prevDabPosRef.current.x,
            dab.y - prevDabPosRef.current.y
          );
          direction = calculateDirection(
            prevDabPosRef.current.x,
            prevDabPosRef.current.y,
            dab.x,
            dab.y
          );
          if (initialDirectionRef.current === null) {
            initialDirectionRef.current = direction;
          }
        }

        if (
          delayFirstDabForInitialDirection &&
          initialDirectionRef.current === null &&
          prevDabPosRef.current === null
        ) {
          prevDabPosRef.current = { x: dab.x, y: dab.y };
          continue;
        }

        const dynamicsInput: DynamicsInput = {
          pressure: dabPressure,
          tiltX,
          tiltY,
          rotation,
          direction,
          initialDirection: initialDirectionRef.current ?? direction,
          ...resolveStrokeProgress({
            distancePx: strokeDistanceRef.current,
            dabCount: strokeDabCountRef.current,
            startTimestampMs: strokeStartTimestampMsRef.current,
            currentTimestampMs: strokeCurrentTimestampMsRef.current,
          }),
        };

        const { flow: dabFlow, dabOpacity } = resolveDabFlowAndOpacity(
          config,
          dynamicsInput,
          effectiveTransfer
        );

        if (useShapeDynamics && effectiveShapeDynamics) {
          const shape = computeDabShape(
            dabSize,
            config.angle,
            config.roundness,
            effectiveShapeDynamics,
            dynamicsInput
          );

          dabSize = shape.size;
          dabAngle = shape.angle;
          dabRoundness = shape.roundness;
          dabFlipX = shape.flipX;
          dabFlipY = shape.flipY;
        }

        prevDabPosRef.current = { x: dab.x, y: dab.y };

        let dabColor = config.color;
        if (useColorDynamics && config.colorDynamics) {
          const colorResult = computeDabColor(
            config.color,
            config.backgroundColor,
            config.colorDynamics,
            dynamicsInput,
            Math.random,
            strokeColorJitterSample
          );
          dabColor = colorResult.color;
        }

        const scatteredPositions = useScatter
          ? applyScatter(
              {
                x: dab.x,
                y: dab.y,
                strokeAngle: (direction * Math.PI) / 180,
                diameter: dabSize,
                dynamics: dynamicsInput,
              },
              config.scatter!
            )
          : [{ x: dab.x, y: dab.y }];

        for (const pos of scatteredPositions) {
          const effectiveTextureSettings =
            config.textureEnabled && config.textureSettings
              ? (() => {
                  const settings = config.textureSettings!;
                  const dynamicDepth = computeTextureDepth(settings.depth, settings, dynamicsInput);
                  if (Math.abs(dynamicDepth - settings.depth) <= 1e-6) {
                    return settings;
                  }
                  return {
                    ...settings,
                    depth: dynamicDepth,
                  };
                })()
              : undefined;

          const renderDab = resolveRenderableDabSizeAndOpacity(dabSize, dabOpacity);
          const dabParams: DabParams = {
            x: pos.x,
            y: pos.y,
            size: renderDab.size,
            flow: dabFlow,
            hardness: config.hardness / 100,
            maskType: config.maskType,
            color: dabColor,
            dabOpacity: renderDab.dabOpacity,
            roundness: dabRoundness,
            angle: dabAngle,
            texture: config.texture ?? undefined,
            flipX: dabFlipX,
            flipY: dabFlipY,
            wetEdge: config.wetEdgeEnabled ? config.wetEdge : 0,
            textureSettings: effectiveTextureSettings,
            noiseEnabled: config.noiseEnabled,
            noiseSize: config.noiseSize ?? 100,
            noiseSizeJitter: config.noiseSizeJitter ?? 0,
            noiseDensityJitter: config.noiseDensityJitter ?? 0,
            dualBrush:
              config.dualBrushEnabled && config.dualBrush
                ? {
                    ...config.dualBrush,
                    enabled: config.dualBrushEnabled,
                    brushTexture: config.dualBrush.texture,
                  }
                : undefined,
            baseSize: config.size,
            spacing: config.spacing,
          };

          stampDabToBackend(dabParams);
        }
      }
    },
    [backend, mapStamperPressureToBrush, resolveDabFlowAndOpacity, stampDabToBackend]
  );

  const setFinalizeDebugSnapshot = useCallback(
    (
      reason: 'no_active_stroke' | 'no_pending_segment' | 'emitted_segment',
      emittedDabCount: number
    ) => {
      strokeFinalizeDebugSnapshotRef.current = {
        reason,
        speedPxPerMs: 0,
        normalizedSpeed: 0,
        finalSegmentDistance: 0,
        emittedDabCount,
        remainingDistancePx: 0,
        remainingTimeMs: 0,
      };
    },
    []
  );

  const finalizeStrokeOnce = useCallback(
    (trigger: StrokeFinalizeTrigger): void => {
      if (strokeFinalizeRef.current.finalized) {
        return;
      }
      strokeFinalizeRef.current = {
        finalized: true,
        trigger,
      };
      const finalizeWithoutActiveStroke = (): void => {
        primaryPipelineRef.current.finalize();
        secondaryPipelineRef.current.finalize();
        setFinalizeDebugSnapshot('no_active_stroke', 0);
      };

      if (strokeCancelledRef.current) {
        finalizeWithoutActiveStroke();
        lastConfigRef.current = null;
        strokeCancelledRef.current = false;
        return;
      }

      const config = lastConfigRef.current;
      if (!config) {
        finalizeWithoutActiveStroke();
        return;
      }

      const finalizeInfos = primaryPipelineRef.current.finalize();
      const finalizeDabs = finalizeInfos.map((info) => ({
        x: info.x_px,
        y: info.y_px,
        pressure: info.pressure_01,
        timestampMs: info.time_us / 1000,
        normalizedSpeed: info.drawing_speed_01,
        timeUs: info.time_us,
      }));
      const dualBrushLock = strokeDualBrushLockRef.current;
      const secondaryFinalizeDabs = secondaryPipelineRef.current.finalize();
      if (dualBrushLock.enabled && dualBrushLock.dualBrush && secondaryFinalizeDabs.length > 0) {
        stampSecondaryDabs(
          secondaryFinalizeDabs,
          dualBrushLock.dualBrush.size,
          dualBrushLock.dualBrush
        );
      }
      if (finalizeDabs.length > 0) {
        renderPrimaryDabs(finalizeDabs, config, lastPointerDynamicsRef.current);
      }
      const emittedDabCount = finalizeDabs.length + secondaryFinalizeDabs.length;
      setFinalizeDebugSnapshot(
        emittedDabCount > 0 ? 'emitted_segment' : 'no_pending_segment',
        emittedDabCount
      );

      lastConfigRef.current = null;
    },
    [renderPrimaryDabs, setFinalizeDebugSnapshot, stampSecondaryDabs]
  );

  /**
   * Process a point and render dabs to stroke buffer
   */
  const processPoint = useCallback(
    (
      x: number,
      y: number,
      pressure: number,
      config: BrushRenderConfig,
      pointIndex?: number,
      dynamics?: { tiltX?: number; tiltY?: number; rotation?: number },
      inputMeta?: {
        timestampMs?: number;
        source?: 'wintab' | 'macnative' | 'pointerevent';
        phase?: 'down' | 'move' | 'up' | 'hover';
        hostTimeUs?: number;
        deviceTimeUs?: number;
      }
    ): void => {
      if (strokeCancelledRef.current) {
        return;
      }
      const effectiveConfig = resolveStrokeLockedConfig(config);
      lastConfigRef.current = effectiveConfig;

      // Start CPU encode timing
      if (pointIndex !== undefined) {
        benchmarkProfiler?.markCpuEncodeStart();
      }

      if (!strokeCompositeModeLockedRef.current) {
        strokeCompositeModeRef.current = effectiveConfig.strokeCompositeMode;
        strokeCompositeModeLockedRef.current = true;
      }

      const effectiveDynamics = resolveEffectiveDynamicsConfig(effectiveConfig);
      const effectiveShapeDynamics = effectiveDynamics.shapeDynamics;
      const tiltX = dynamics?.tiltX ?? 0;
      const tiltY = dynamics?.tiltY ?? 0;
      const rotation = dynamics?.rotation ?? 0;
      const timestampMs =
        typeof inputMeta?.timestampMs === 'number' && Number.isFinite(inputMeta.timestampMs)
          ? inputMeta.timestampMs
          : typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
      const normalizedSource =
        normalizeInputSource(inputMeta?.source ?? 'pointerevent') ?? 'pointerevent';
      const normalizedPhase = normalizeInputPhase(inputMeta?.phase ?? 'move');
      const rawHostTimeUs =
        typeof inputMeta?.hostTimeUs === 'number' && Number.isFinite(inputMeta.hostTimeUs)
          ? Math.max(0, Math.round(inputMeta.hostTimeUs))
          : Math.max(0, Math.round(timestampMs * 1000));
      const rawDeviceTimeUs =
        typeof inputMeta?.deviceTimeUs === 'number' && Number.isFinite(inputMeta.deviceTimeUs)
          ? Math.max(0, Math.round(inputMeta.deviceTimeUs))
          : rawHostTimeUs;

      const timeState = normalizedTimeRef.current;
      const fallbackDeltaUs =
        timeState.lastTimestampMs === null
          ? 0
          : clampFiniteDeltaUs((timestampMs - timeState.lastTimestampMs) * 1000);

      const nextHostDeltaUs =
        timeState.lastRawHostUs === null
          ? 0
          : clampFiniteDeltaUs(rawHostTimeUs - timeState.lastRawHostUs);
      const hostDeltaUs =
        nextHostDeltaUs === 0 && timeState.lastRawHostUs !== null
          ? fallbackDeltaUs
          : nextHostDeltaUs;
      timeState.hostUs += hostDeltaUs;
      timeState.lastRawHostUs = rawHostTimeUs;

      const nextDeviceDeltaUs =
        timeState.lastRawDeviceUs === null
          ? 0
          : clampFiniteDeltaUs(rawDeviceTimeUs - timeState.lastRawDeviceUs);
      const deviceDeltaUs =
        nextDeviceDeltaUs === 0 && timeState.lastRawDeviceUs !== null
          ? hostDeltaUs
          : nextDeviceDeltaUs;
      timeState.deviceUs += deviceDeltaUs;
      timeState.lastRawDeviceUs = rawDeviceTimeUs;
      timeState.lastTimestampMs = timestampMs;

      const hostTimeUs = timeState.hostUs;
      const deviceTimeUs = timeState.deviceUs;
      const pressureLut = effectiveConfig.globalPressureLut ?? createDefaultGlobalPressureLut();
      const globalPressureInput = sampleGlobalPressureCurve(pressureLut, pressure);
      const adjustedPressure = mapStamperPressureToBrush(effectiveConfig, globalPressureInput);
      const hasShapeSizeControl =
        effectiveShapeDynamics !== null && effectiveShapeDynamics.sizeControl !== 'off';

      // Store stroke-level opacity (applied at endStroke/compositeToLayer)
      const strokeOpacity = Math.max(0, Math.min(1, effectiveConfig.opacity));
      strokeOpacityRef.current = strokeOpacity;

      // Toolbar pressure-size acts as a force override for size control.
      // Effective shape dynamics converts sizeControl to penPressure when forced.
      const size = effectiveConfig.size;

      // Shape Dynamics size control should affect spacing (jitter does not)
      let spacingSize = size;
      if (hasShapeSizeControl) {
        const spacingProgress = resolveStrokeProgress({
          distancePx: strokeDistanceRef.current,
          dabCount: strokeDabCountRef.current,
          startTimestampMs: strokeStartTimestampMsRef.current,
          currentTimestampMs:
            typeof inputMeta?.timestampMs === 'number' && Number.isFinite(inputMeta.timestampMs)
              ? inputMeta.timestampMs
              : strokeCurrentTimestampMsRef.current,
        });
        const spacingInput: DynamicsInput = {
          pressure: adjustedPressure,
          tiltX,
          tiltY,
          rotation,
          direction: 0,
          initialDirection: 0,
          ...spacingProgress,
        };
        spacingSize = computeControlledSize(size, effectiveShapeDynamics!, spacingInput);
      }

      const spacingBase = computeSpacingBasePx(
        spacingSize,
        effectiveConfig.roundness / 100,
        effectiveConfig.texture
      );
      const spacingPx = spacingBase * effectiveConfig.spacing;
      lastSpacingPxRef.current = Math.max(0.5, spacingPx);
      const timedSpacingEnabled = effectiveConfig.buildupEnabled;
      const timedSpacingIntervalMs = timedSpacingEnabled
        ? PIPELINE_BUILDUP_INTERVAL_MS
        : PIPELINE_DISTANCE_INTERVAL_MS;
      primaryPipelineRef.current.updateConfig(
        createPipelineConfig({
          pressureLut,
          speedPxPerMs: effectiveConfig.maxBrushSpeedPxPerMs ?? 30,
          smoothingSamples: effectiveConfig.brushSpeedSmoothingSamples ?? 3,
          spacingPx: lastSpacingPxRef.current,
          timedSpacingEnabled,
          maxIntervalMs: timedSpacingIntervalMs,
        })
      );

      const rawSample = {
        x_px: x,
        y_px: y,
        pressure_01: pressure,
        tilt_x_deg: tiltX * 90,
        tilt_y_deg: tiltY * 90,
        rotation_deg: rotation,
        device_time_us: deviceTimeUs,
        host_time_us: hostTimeUs,
        source: normalizedSource,
        phase: normalizedPhase,
      };

      const pipelineResult = primaryPipelineRef.current.processSample(rawSample);
      const dabs = pipelineResult.paint_infos.map((info) => ({
        x: info.x_px,
        y: info.y_px,
        pressure: info.pressure_01,
        timestampMs: info.time_us / 1000,
        normalizedSpeed: info.drawing_speed_01,
        timeUs: info.time_us,
      }));
      const firstDab = dabs[0] ?? null;
      const lastDab = dabs[dabs.length - 1] ?? null;
      logTabletTrace('frontend.canvas.dab_emit', {
        point_index: typeof pointIndex === 'number' ? pointIndex : null,
        source: normalizedSource,
        phase: normalizedPhase,
        input_x_canvas: x,
        input_y_canvas: y,
        input_pressure_0_1: pressure,
        host_time_us: hostTimeUs,
        device_time_us: deviceTimeUs,
        dabs_count: dabs.length,
        first_dab_x: firstDab?.x ?? null,
        first_dab_y: firstDab?.y ?? null,
        first_dab_pressure_0_1: firstDab?.pressure ?? null,
        last_dab_x: lastDab?.x ?? null,
        last_dab_y: lastDab?.y ?? null,
        last_dab_pressure_0_1: lastDab?.pressure ?? null,
      });
      if (
        dabs.length === 0 &&
        (normalizedPhase === 'down' || normalizedPhase === 'move') &&
        pressure > 0.001
      ) {
        logTabletTrace('frontend.anomaly.input_without_dabs', {
          point_index: typeof pointIndex === 'number' ? pointIndex : null,
          source: normalizedSource,
          phase: normalizedPhase,
          input_x_canvas: x,
          input_y_canvas: y,
          input_pressure_0_1: pressure,
          host_time_us: hostTimeUs,
          device_time_us: deviceTimeUs,
        });
      }

      // ===== Dual Brush: Generate secondary dabs independently =====
      // Secondary brush has its own spacing and path, separate from primary brush
      const dualBrushSettings = effectiveConfig.dualBrush ?? null;
      const dualEnabled = effectiveConfig.dualBrushEnabled && Boolean(dualBrushSettings);

      if (backend === 'gpu' && gpuBufferRef.current) {
        gpuBufferRef.current.setDualBrushState(
          dualEnabled,
          dualBrushSettings?.mode ?? null,
          dualBrushSettings?.texture ?? null
        );
      }

      if (dualEnabled && dualBrushSettings) {
        // Secondary size is maintained by the store (Photoshop-like ratio behavior).
        const secondarySize = dualBrushSettings.size;

        // Use secondary brush's own spacing (this was the missing part!)
        const secondarySpacing = dualBrushSettings.spacing ?? 0.1;
        const secondaryRoundness = (dualBrushSettings.roundness ?? 100) / 100;
        const secondarySpacingBase = computeSpacingBasePx(
          secondarySize,
          secondaryRoundness,
          dualBrushSettings.texture
        );
        const secondarySpacingPx = secondarySpacingBase * secondarySpacing;
        secondaryPipelineRef.current.updateConfig(
          createPipelineConfig({
            pressureLut,
            speedPxPerMs: effectiveConfig.maxBrushSpeedPxPerMs ?? 30,
            smoothingSamples: effectiveConfig.brushSpeedSmoothingSamples ?? 3,
            spacingPx: Math.max(0.5, secondarySpacingPx),
            timedSpacingEnabled,
            maxIntervalMs: timedSpacingIntervalMs,
          })
        );

        const secondaryResult = secondaryPipelineRef.current.processSample(rawSample);
        stampSecondaryDabs(secondaryResult.paint_infos, secondarySize, dualBrushSettings);
      }

      lastPointerDynamicsRef.current = { tiltX, tiltY, rotation };

      renderPrimaryDabs(dabs, effectiveConfig, lastPointerDynamicsRef.current);

      // End CPU encode timing and trigger GPU sample if needed
      // NOTE: Disabled during active painting to avoid breaking batch processing
      // The RAF loop will handle flushing at the end of each frame
      if (pointIndex !== undefined && benchmarkProfiler) {
        // Force flush if this is a sample point to ensure accurate GPU timing
        // IMPORTANT: Only flush if NOT using GPU batch rendering
        // GPU batch rendering requires all dabs to be processed together before flush
        if (
          backend !== 'gpu' && // Only flush for CPU backend
          gpuBufferRef.current &&
          benchmarkProfiler.shouldSampleGpu(pointIndex)
        ) {
          gpuBufferRef.current.flush();
        }
        void benchmarkProfiler.markRenderSubmit(pointIndex);
      }
    },
    [
      backend,
      benchmarkProfiler,
      mapStamperPressureToBrush,
      renderPrimaryDabs,
      resolveStrokeLockedConfig,
      stampSecondaryDabs,
    ]
  );

  /**
   * End stroke and composite to layer
   * Returns a Promise that resolves when compositing is complete
   *
   * For GPU backend, uses atomic transaction pattern:
   * 1. Async: prepareEndStroke() - flush dabs, wait for GPU/preview ready
   * 2. Sync: compositeToLayer() + clear() - in same JS task to prevent flicker
   *
   * Optimization 7: Uses finishing lock to prevent tailgating race condition
   */
  const endStroke = useCallback(
    async (layerCtx: CanvasRenderingContext2D): Promise<void> => {
      if (strokeCancelledRef.current) {
        finalizeStrokeOnce('end-stroke');
        return;
      }

      finalizeStrokeOnce('end-stroke');

      if (backend === 'gpu' && gpuBufferRef.current) {
        const gpuBuffer = gpuBufferRef.current;

        // Optimization 7: Create finishing lock promise
        // This prevents new stroke from starting (and calling clear()) during our async work
        finishingPromiseRef.current = (async () => {
          try {
            // 1. Async: wait for GPU and preview to be ready
            await gpuBuffer.prepareEndStroke();

            // 2. Sync atomic transaction: composite + clear in same JS task
            // This prevents browser paint between composite and clear (no flicker)
            gpuBuffer.compositeToLayer(
              layerCtx,
              strokeOpacityRef.current,
              strokeCompositeModeRef.current
            );
            gpuBuffer.clear();
          } finally {
            finishingPromiseRef.current = null;
          }
        })();

        await finishingPromiseRef.current;
      } else if (cpuBufferRef.current) {
        cpuBufferRef.current.endStroke(
          layerCtx,
          strokeOpacityRef.current,
          strokeCompositeModeRef.current
        );
      }
    },
    [backend, finalizeStrokeOnce]
  );

  /**
   * Get preview canvas for stroke visualization
   */
  const getPreviewCanvas = useCallback(() => {
    if (backend === 'gpu' && gpuBufferRef.current) {
      return gpuBufferRef.current.getCanvas();
    }
    return cpuBufferRef.current?.getCanvas() ?? null;
  }, [backend]);

  /**
   * Get preview opacity (stroke-level opacity applied during compositing)
   */
  const getPreviewOpacity = useCallback(() => strokeOpacityRef.current, []);
  const getPreviewCompositeMode = useCallback(() => strokeCompositeModeRef.current, []);

  /**
   * Check if stroke is active
   */
  const isStrokeActive = useCallback(() => {
    if (backend === 'gpu' && gpuBufferRef.current) {
      return gpuBufferRef.current.isActive();
    }
    return cpuBufferRef.current?.isActive() ?? false;
  }, [backend]);

  const getLastDabPosition = useCallback(() => lastDabPosRef.current, []);

  const getDebugRects = useCallback(() => {
    if (backend === 'gpu' && gpuBufferRef.current) {
      return gpuBufferRef.current.getDebugRects();
    }
    return null;
  }, [backend]);

  const setGpuPreviewReadbackEnabled = useCallback((enabled: boolean) => {
    gpuBufferRef.current?.setPreviewReadbackEnabled(enabled);
  }, []);

  const getScratchHandle = useCallback((): GpuScratchHandle | null => {
    if (backend === 'gpu' && gpuBufferRef.current) {
      const texture = gpuBufferRef.current.getScratchTexture();
      if (!texture) return null;
      return {
        texture,
        renderScale: gpuBufferRef.current.getRenderScale(),
      };
    }
    return null;
  }, [backend]);

  const releaseGpuCommitLock = useCallback(() => {
    if (!gpuCommitLockActiveRef.current) return;
    gpuCommitLockActiveRef.current = false;
    const resolve = gpuCommitLockResolveRef.current;
    gpuCommitLockResolveRef.current = null;
    resolve?.();
    finishingPromiseRef.current = null;
  }, []);

  const prepareStrokeEndGpu = useCallback(async (): Promise<GpuStrokePrepareResult> => {
    if (backend === 'gpu' && gpuBufferRef.current) {
      finalizeStrokeOnce('prepare-gpu');

      // Align GPU commit path with legacy endStroke lock to prevent tailgating.
      if (!gpuCommitLockActiveRef.current && !finishingPromiseRef.current) {
        gpuCommitLockActiveRef.current = true;
        finishingPromiseRef.current = new Promise<void>((resolve) => {
          gpuCommitLockResolveRef.current = resolve;
        });
      }

      try {
        await gpuBufferRef.current.prepareEndStroke();
        const texture = gpuBufferRef.current.getScratchTexture();
        return {
          dirtyRect: gpuBufferRef.current.getDirtyRect(),
          strokeOpacity: strokeOpacityRef.current,
          compositeMode: strokeCompositeModeRef.current,
          scratch: texture
            ? {
                texture,
                renderScale: gpuBufferRef.current.getRenderScale(),
              }
            : null,
        };
      } catch (error) {
        releaseGpuCommitLock();
        throw error;
      }
    }
    return {
      dirtyRect: null,
      strokeOpacity: strokeOpacityRef.current,
      compositeMode: strokeCompositeModeRef.current,
      scratch: null,
    };
  }, [backend, finalizeStrokeOnce, releaseGpuCommitLock]);

  const clearScratchGpu = useCallback(() => {
    try {
      if (backend === 'gpu' && gpuBufferRef.current) {
        gpuBufferRef.current.clear();
      }
    } finally {
      releaseGpuCommitLock();
    }
  }, [backend, releaseGpuCommitLock]);

  // Backward-compatible aliases during API transition.
  const getGpuScratchTexture = useCallback(() => {
    return getScratchHandle()?.texture ?? null;
  }, [getScratchHandle]);

  const prepareEndStrokeGpu = useCallback(async () => {
    await prepareStrokeEndGpu();
  }, [prepareStrokeEndGpu]);

  const clearGpuScratch = useCallback(() => {
    clearScratchGpu();
  }, [clearScratchGpu]);

  const getGpuDirtyRect = useCallback(() => {
    if (backend === 'gpu' && gpuBufferRef.current) {
      return gpuBufferRef.current.getDirtyRect();
    }
    return null;
  }, [backend]);

  const getGpuRenderScale = useCallback(() => {
    if (backend === 'gpu' && gpuBufferRef.current) {
      return gpuBufferRef.current.getRenderScale();
    }
    return 1.0;
  }, [backend]);

  const getGpuDiagnosticsSnapshot = useCallback(() => {
    return gpuBufferRef.current?.getDiagnosticSnapshot() ?? null;
  }, []);

  const resetGpuDiagnostics = useCallback(() => {
    const gpu = gpuBufferRef.current;
    if (!gpu) {
      return false;
    }
    gpu.resetDiagnostics();
    return true;
  }, []);

  const getStrokeFinalizeDebugSnapshot = useCallback((): StrokeFinalizeDebugSnapshot | null => {
    const snapshot = strokeFinalizeDebugSnapshotRef.current;
    if (!snapshot) return null;
    return { ...snapshot };
  }, []);

  /**
   * Flush pending dabs to GPU (called once per frame by RAF loop)
   * This ensures all dabs accumulated during the frame are rendered together
   */
  const flushPending = useCallback(() => {
    if (backend === 'gpu' && gpuBufferRef.current) {
      gpuBufferRef.current.flush();

      const fallbackReason = gpuBufferRef.current.consumeFallbackRequest();
      if (fallbackReason && !forceCpu) {
        setForceCpu(true);
        strokeCancelledRef.current = true;
        gpuBufferRef.current.abortStroke();
        reportGPUFallback(fallbackReason);
        pushToast('GPU dual brush compute unavailable. Falling back to CPU.', {
          variant: 'error',
        });
      }
    }
    // CPU path doesn't need explicit flush - it renders immediately
  }, [backend, forceCpu, pushToast]);

  return {
    beginStroke,
    processPoint,
    endStroke,
    getPreviewCanvas,
    getPreviewOpacity,
    getPreviewCompositeMode,
    isStrokeActive,
    getLastDabPosition,
    getDebugRects,
    flushPending,
    backend,
    gpuAvailable,
    setGpuPreviewReadbackEnabled,
    getScratchHandle,
    prepareStrokeEndGpu,
    clearScratchGpu,
    getGpuScratchTexture,
    prepareEndStrokeGpu,
    clearGpuScratch,
    getGpuDirtyRect,
    getGpuRenderScale,
    getGpuDiagnosticsSnapshot,
    resetGpuDiagnostics,
    getStrokeFinalizeDebugSnapshot,
  };
}
