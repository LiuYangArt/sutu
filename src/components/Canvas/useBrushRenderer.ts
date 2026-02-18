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
  BrushStamper,
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
import {
  KritaPressurePipeline,
  combineCurveOption,
  createLinearSensorLut,
  createDefaultGlobalPressureLut,
  evaluateDynamicSensor,
  getKritaPressurePipelineMode,
  recordKritaPressureShadowDiff,
  sampleGlobalPressureCurve,
  normalizeInputPhase,
  normalizeInputSource,
  type PaintInfo,
} from '@/engine/kritaPressure';

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

/**
 * Isolate speed-driven heuristics from the current pressure-tail parity work.
 * We keep these runtime options fixed so tablet speed UI settings cannot
 * influence dab emission while debugging pressure-only tail behavior.
 */
const PRESSURE_TAIL_PARITY_STAMPER_OPTIONS = Object.freeze({
  maxBrushSpeedPxPerMs: 30,
  brushSpeedSmoothingSamples: 3,
  maxDabIntervalMs: 16,
});

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

  // Shared stamper (generates dab positions)
  const legacyPrimaryStamperRef = useRef<BrushStamper>(new BrushStamper());
  const primaryPipelineRef = useRef<KritaPressurePipeline>(
    new KritaPressurePipeline({
      pressure_enabled: true,
      global_pressure_lut: createDefaultGlobalPressureLut(),
      use_device_time_for_speed: false,
      max_allowed_speed_px_per_ms: 30,
      speed_smoothing_samples: 3,
      spacing_px: 1,
      max_interval_us: 16_000,
    })
  );

  // Secondary brush stamper (independent path for Dual Brush)
  const secondaryStamperRef = useRef<BrushStamper>(new BrushStamper());

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
      legacyPrimaryStamperRef.current.beginStroke();
      secondaryStamperRef.current.beginStroke();
      primaryPipelineRef.current.reset();

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

  const finalizeStrokeOnce = useCallback(
    (trigger: StrokeFinalizeTrigger): void => {
      if (strokeFinalizeRef.current.finalized) {
        return;
      }
      strokeFinalizeRef.current = {
        finalized: true,
        trigger,
      };

      if (strokeCancelledRef.current) {
        primaryPipelineRef.current.finalize();
        legacyPrimaryStamperRef.current.finishStroke(0);
        secondaryStamperRef.current.finishStroke(0);
        lastConfigRef.current = null;
        strokeCancelledRef.current = false;
        return;
      }

      const config = lastConfigRef.current;
      if (!config) {
        primaryPipelineRef.current.finalize();
        legacyPrimaryStamperRef.current.finishStroke(0);
        secondaryStamperRef.current.finishStroke(0);
        return;
      }

      const runtimeMode = getKritaPressurePipelineMode();
      const shouldRunLegacyShadow = runtimeMode.pressurePipelineV2Shadow;
      const finalizeInfos = primaryPipelineRef.current.finalize();
      const finalizeDabs = finalizeInfos.map((info) => ({
        x: info.x_px,
        y: info.y_px,
        pressure: info.pressure_01,
        timestampMs: info.time_us / 1000,
        normalizedSpeed: info.drawing_speed_01,
        timeUs: info.time_us,
      }));
      const legacyFinalize = shouldRunLegacyShadow
        ? legacyPrimaryStamperRef.current.finishStroke(lastSpacingPxRef.current, {
            ...PRESSURE_TAIL_PARITY_STAMPER_OPTIONS,
          })
        : [];
      const legacySpeed = legacyPrimaryStamperRef.current.getLastNormalizedSpeed();
      const legacyFinalizeDabs = legacyFinalize.map((dab) => ({
        x: dab.x,
        y: dab.y,
        pressure: dab.pressure,
        timestampMs: dab.timestampMs,
        normalizedSpeed: legacySpeed,
        timeUs:
          typeof dab.timestampMs === 'number' && Number.isFinite(dab.timestampMs)
            ? Math.max(0, Math.round(dab.timestampMs * 1000))
            : undefined,
      }));
      secondaryStamperRef.current.finishStroke(0);
      if (finalizeDabs.length > 0) {
        renderPrimaryDabs(finalizeDabs, config, lastPointerDynamicsRef.current);
      }

      if (runtimeMode.pressurePipelineV2Shadow) {
        const pairingCount = Math.min(finalizeDabs.length, legacyFinalizeDabs.length);
        const mixDelta =
          pairingCount > 0
            ? (() => {
                let total = 0;
                for (let i = 0; i < pairingCount; i += 1) {
                  const p = finalizeDabs[i];
                  const l = legacyFinalizeDabs[i];
                  if (!p || !l) continue;
                  total +=
                    Math.abs(p.pressure - l.pressure) +
                    Math.abs((p.timeUs ?? 0) - (l.timeUs ?? 0)) * 0.001;
                }
                return total / pairingCount;
              })()
            : Math.abs(finalizeDabs.length - legacyFinalizeDabs.length);
        const finalDelta =
          pairingCount > 0
            ? (() => {
                let total = 0;
                for (let i = 0; i < pairingCount; i += 1) {
                  const p = finalizeDabs[i];
                  const l = legacyFinalizeDabs[i];
                  if (!p || !l) continue;
                  total +=
                    Math.abs(p.x - l.x) + Math.abs(p.y - l.y) + Math.abs(p.pressure - l.pressure);
                }
                return total / pairingCount;
              })()
            : Math.abs(finalizeDabs.length - legacyFinalizeDabs.length);
        const finalizeTimestamp =
          finalizeDabs[finalizeDabs.length - 1]?.timestampMs ??
          legacyFinalizeDabs[legacyFinalizeDabs.length - 1]?.timestampMs ??
          (typeof performance !== 'undefined' ? performance.now() : Date.now());
        recordKritaPressureShadowDiff({
          timestamp_ms: finalizeTimestamp,
          source: 'pointerevent',
          phase: 'up',
          stage: {
            sampling: Math.abs(finalizeDabs.length - legacyFinalizeDabs.length),
            mix: mixDelta,
            final_dab: finalDelta,
          },
        });
      }

      lastConfigRef.current = null;
    },
    [renderPrimaryDabs]
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
      lastConfigRef.current = config;

      // Start CPU encode timing
      if (pointIndex !== undefined) {
        benchmarkProfiler?.markCpuEncodeStart();
      }

      if (!strokeCompositeModeLockedRef.current) {
        strokeCompositeModeRef.current = config.strokeCompositeMode;
        strokeCompositeModeLockedRef.current = true;
      }

      const stamper = legacyPrimaryStamperRef.current;
      const stamperOptions = {
        timestampMs: inputMeta?.timestampMs,
        ...PRESSURE_TAIL_PARITY_STAMPER_OPTIONS,
      };
      const effectiveDynamics = resolveEffectiveDynamicsConfig(config);
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
      const pressureLut = config.globalPressureLut ?? createDefaultGlobalPressureLut();
      const globalPressureInput = sampleGlobalPressureCurve(pressureLut, pressure);
      const adjustedPressure = mapStamperPressureToBrush(config, globalPressureInput);
      const hasShapeSizeControl =
        effectiveShapeDynamics !== null && effectiveShapeDynamics.sizeControl !== 'off';

      // Store stroke-level opacity (applied at endStroke/compositeToLayer)
      const strokeOpacity = Math.max(0, Math.min(1, config.opacity));
      strokeOpacityRef.current = strokeOpacity;

      // Toolbar pressure-size acts as a force override for size control.
      // Effective shape dynamics converts sizeControl to penPressure when forced.
      const size = config.size;

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

      const spacingBase = computeSpacingBasePx(spacingSize, config.roundness / 100, config.texture);
      const spacingPx = spacingBase * config.spacing;
      lastSpacingPxRef.current = Math.max(0.5, spacingPx);
      const maxIntervalMs = PRESSURE_TAIL_PARITY_STAMPER_OPTIONS.maxDabIntervalMs ?? 16;
      primaryPipelineRef.current.updateConfig({
        pressure_enabled: true,
        global_pressure_lut: pressureLut,
        use_device_time_for_speed: false,
        max_allowed_speed_px_per_ms: config.maxBrushSpeedPxPerMs ?? 30,
        speed_smoothing_samples: config.brushSpeedSmoothingSamples ?? 3,
        spacing_px: lastSpacingPxRef.current,
        max_interval_us: Math.max(1_000, Math.round(maxIntervalMs * 1000)),
      });

      const pipelineResult = primaryPipelineRef.current.processSample({
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
      });
      const globalPressure = pipelineResult.current_info.pressure_01;
      const dabs = pipelineResult.paint_infos.map((info) => ({
        x: info.x_px,
        y: info.y_px,
        pressure: info.pressure_01,
        timestampMs: info.time_us / 1000,
        normalizedSpeed: info.drawing_speed_01,
        timeUs: info.time_us,
      }));

      // Legacy stamper is shadow-only or debug primary when V2 primary is disabled.
      const legacyMode = getKritaPressurePipelineMode();
      const enableLegacyPrimaryShadow = legacyMode.pressurePipelineV2Shadow;
      const legacyDabs = enableLegacyPrimaryShadow
        ? stamper.processPoint(
            x,
            y,
            globalPressure,
            lastSpacingPxRef.current,
            config.buildupEnabled,
            stamperOptions
          )
        : [];

      // ===== Dual Brush: Generate secondary dabs independently =====
      // Secondary brush has its own spacing and path, separate from primary brush
      const dualBrush = config.dualBrush ?? null;
      const dualEnabled = config.dualBrushEnabled && Boolean(dualBrush);

      if (backend === 'gpu' && gpuBufferRef.current) {
        gpuBufferRef.current.setDualBrushState(
          dualEnabled,
          dualBrush?.mode ?? null,
          dualBrush?.texture ?? null
        );
      }

      if (dualEnabled && dualBrush) {
        const secondaryStamper = secondaryStamperRef.current;

        // Secondary size is maintained by the store (Photoshop-like ratio behavior).
        const secondarySize = dualBrush.size;

        // Use secondary brush's own spacing (this was the missing part!)
        const secondarySpacing = dualBrush.spacing ?? 0.1;
        const secondaryRoundness = (dualBrush.roundness ?? 100) / 100;
        const secondarySpacingBase = computeSpacingBasePx(
          secondarySize,
          secondaryRoundness,
          dualBrush.texture
        );
        const secondarySpacingPx = secondarySpacingBase * secondarySpacing;

        // Generate secondary dabs at this point
        const secondaryDabs = secondaryStamper.processPoint(
          x,
          y,
          globalPressure,
          secondarySpacingPx,
          config.buildupEnabled,
          stamperOptions
        );

        // Stamp each secondary dab to the stroke-level accumulator
        for (const secDab of secondaryDabs) {
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
              dualBrush,
              (secondaryDirection * Math.PI) / 180
            );
          } else {
            const cpuBuffer = ensureCPUBuffer();
            cpuBuffer.stampSecondaryDab(
              secDab.x,
              secDab.y,
              secondarySize,
              {
                ...dualBrush,
                brushTexture: dualBrush.texture,
              },
              (secondaryDirection * Math.PI) / 180
            );
          }
        }
      }

      lastPointerDynamicsRef.current = { tiltX, tiltY, rotation };
      const legacySpeed = stamper.getLastNormalizedSpeed();
      const legacyRenderDabs = legacyDabs.map((dab) => ({
        x: dab.x,
        y: dab.y,
        pressure: dab.pressure,
        timestampMs: dab.timestampMs,
        normalizedSpeed: legacySpeed,
        timeUs:
          typeof dab.timestampMs === 'number' && Number.isFinite(dab.timestampMs)
            ? Math.max(0, Math.round(dab.timestampMs * 1000))
            : undefined,
      }));

      renderPrimaryDabs(dabs, config, lastPointerDynamicsRef.current);

      if (legacyMode.pressurePipelineV2Shadow) {
        const pairingCount = Math.min(dabs.length, legacyRenderDabs.length);
        const pressureMixDelta =
          pairingCount > 0
            ? (() => {
                let total = 0;
                for (let i = 0; i < pairingCount; i += 1) {
                  total += Math.abs(
                    (dabs[i]?.pressure ?? 0) - (legacyRenderDabs[i]?.pressure ?? 0)
                  );
                }
                return total / pairingCount;
              })()
            : Math.abs(dabs.length - legacyRenderDabs.length);
        const timeMixDelta =
          pairingCount > 0
            ? (() => {
                let total = 0;
                for (let i = 0; i < pairingCount; i += 1) {
                  const pipelineTime = dabs[i]?.timeUs ?? 0;
                  const legacyTime = legacyRenderDabs[i]?.timeUs ?? 0;
                  total += Math.abs(pipelineTime - legacyTime) / 1000;
                }
                return total / pairingCount;
              })()
            : 0;
        const finalDabDelta =
          pairingCount > 0
            ? (() => {
                let total = 0;
                for (let i = 0; i < pairingCount; i += 1) {
                  const pipeline = dabs[i];
                  const legacy = legacyRenderDabs[i];
                  if (!pipeline || !legacy) continue;
                  total +=
                    Math.abs(pipeline.x - legacy.x) +
                    Math.abs(pipeline.y - legacy.y) +
                    Math.abs(pipeline.pressure - legacy.pressure);
                }
                return total / pairingCount;
              })()
            : Math.abs(dabs.length - legacyRenderDabs.length);
        recordKritaPressureShadowDiff({
          timestamp_ms: timestampMs,
          source: normalizedSource,
          phase: normalizedPhase,
          stage: {
            input: Math.abs(Math.max(0, Math.min(1, pressure)) - pressure),
            global_curve: Math.abs(globalPressure - adjustedPressure),
            speed: Math.abs(pipelineResult.current_info.drawing_speed_01 - legacySpeed),
            sampling: Math.abs(dabs.length - legacyRenderDabs.length),
            mix: pressureMixDelta + timeMixDelta * 0.001,
            sensor:
              pairingCount > 0
                ? (() => {
                    let total = 0;
                    for (let i = 0; i < pairingCount; i += 1) {
                      const pipelineDab = dabs[i];
                      const legacyDab = legacyRenderDabs[i];
                      if (!pipelineDab || !legacyDab) continue;
                      const pipelineSensor = combineCurveOption({
                        constant: 1,
                        values: [
                          evaluateDynamicSensor(
                            {
                              x_px: pipelineDab.x,
                              y_px: pipelineDab.y,
                              pressure_01: pipelineDab.pressure,
                              drawing_speed_01: pipelineDab.normalizedSpeed ?? 0,
                              time_us: pipelineDab.timeUs ?? 0,
                            },
                            LINEAR_PRESSURE_SENSOR_CONFIG
                          ),
                        ],
                        mode: 'multiply',
                        min: 0,
                        max: 1,
                      });
                      const legacySensor = combineCurveOption({
                        constant: 1,
                        values: [
                          evaluateDynamicSensor(
                            {
                              x_px: legacyDab.x,
                              y_px: legacyDab.y,
                              pressure_01: legacyDab.pressure,
                              drawing_speed_01: legacyDab.normalizedSpeed ?? 0,
                              time_us: legacyDab.timeUs ?? 0,
                            },
                            LINEAR_PRESSURE_SENSOR_CONFIG
                          ),
                        ],
                        mode: 'multiply',
                        min: 0,
                        max: 1,
                      });
                      total += Math.abs(pipelineSensor - legacySensor);
                    }
                    return total / pairingCount;
                  })()
                : 0,
            final_dab: finalDabDelta,
          },
        });
      }

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
    [backend, benchmarkProfiler, ensureCPUBuffer, mapStamperPressureToBrush, renderPrimaryDabs]
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
    return legacyPrimaryStamperRef.current.getStrokeFinalizeDebugSnapshot();
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
