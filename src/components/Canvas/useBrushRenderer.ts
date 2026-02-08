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
} from '@/utils/strokeBuffer';
import {
  applyPressureCurve,
  PressureCurve,
  BrushTexture,
  ShapeDynamicsSettings,
  ScatterSettings,
  ColorDynamicsSettings,
  TransferSettings,
  DualBrushSettings,
  useToolStore,
} from '@/stores/tool';
import type { TextureSettings } from '@/components/BrushPanel/types';
import { RenderMode } from '@/stores/settings';
import { LatencyProfiler } from '@/benchmark';
import {
  GPUContext,
  GPUStrokeAccumulator,
  shouldUseGPU,
  reportGPUFallback,
  type RenderBackend,
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
import { computeDabColor, isColorDynamicsActive } from '@/utils/colorDynamics';
import { computeDabTransfer, isTransferActive } from '@/utils/transferDynamics';
import { useSelectionStore } from '@/stores/selection';
import { useToastStore } from '@/stores/toast';

const MIN_ROUNDNESS = 0.01;

function clampRoundness(roundness: number): number {
  return Math.max(MIN_ROUNDNESS, Math.min(1, roundness));
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

export interface BrushRenderConfig {
  size: number;
  flow: number;
  opacity: number;
  hardness: number;
  maskType: MaskType; // Mask type: 'gaussian' or 'default'
  spacing: number; // Fraction of tip short edge (0-10)
  roundness: number; // 0-100 (100 = circle, <100 = ellipse)
  angle: number; // 0-360 degrees
  color: string;
  backgroundColor: string; // For F/B jitter
  pressureSizeEnabled: boolean;
  pressureFlowEnabled: boolean;
  pressureOpacityEnabled: boolean;
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
  // Dual Brush settings (Photoshop-compatible)
  dualBrushEnabled: boolean;
  dualBrush?: DualBrushSettings;
  // When true, selection clipping is fully handled in GPU compositing shader.
  selectionHandledByGpu?: boolean;
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
    dynamics?: { tiltX?: number; tiltY?: number; rotation?: number }
  ) => void;
  endStroke: (layerCtx: CanvasRenderingContext2D) => Promise<void>;
  getPreviewCanvas: () => HTMLCanvasElement | null;
  getPreviewOpacity: () => number;
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

  // Shared stamper (generates dab positions)
  const stamperRef = useRef<BrushStamper>(new BrushStamper());

  // Secondary brush stamper (independent path for Dual Brush)
  const secondaryStamperRef = useRef<BrushStamper>(new BrushStamper());

  // Optimization 7: Finishing lock to prevent "tailgating" race condition
  // When stroke 2 starts during stroke 1's await prepareEndStroke(),
  // stroke 2's clear() would wipe stroke 1's previewCanvas before composite.
  const finishingPromiseRef = useRef<Promise<void> | null>(null);
  const gpuCommitLockActiveRef = useRef(false);
  const gpuCommitLockResolveRef = useRef<(() => void) | null>(null);
  const strokeCancelledRef = useRef(false);
  const dualBrushTextureIdRef = useRef<string | null>(null);

  // Shape Dynamics: Track previous dab position for direction calculation
  const prevDabPosRef = useRef<{ x: number; y: number } | null>(null);
  const prevSecondaryDabPosRef = useRef<{ x: number; y: number } | null>(null);
  // Shape Dynamics: Capture initial direction at stroke start
  const initialDirectionRef = useRef<number>(0);
  const lastDabPosRef = useRef<{ x: number; y: number } | null>(null);

  // Stroke Opacity (Photoshop-like): applied when compositing stroke buffer to layer.
  // We store it in a ref because endStroke() does not receive config.
  const strokeOpacityRef = useRef<number>(1.0);

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
      stamperRef.current.beginStroke();
      secondaryStamperRef.current.beginStroke();

      // Shape Dynamics: Reset direction tracking for new stroke
      prevDabPosRef.current = null;
      prevSecondaryDabPosRef.current = null;
      initialDirectionRef.current = 0;
      lastDabPosRef.current = null;
      strokeOpacityRef.current = 1.0;

      if (backend === 'gpu' && gpuBufferRef.current) {
        gpuBufferRef.current.beginStroke();
      } else {
        const buffer = ensureCPUBuffer();
        buffer.beginStroke(hardness / 100, wetEdge);
      }
    },
    [backend, ensureCPUBuffer]
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
      dynamics?: { tiltX?: number; tiltY?: number; rotation?: number }
    ): void => {
      if (strokeCancelledRef.current) {
        return;
      }

      // Start CPU encode timing
      if (pointIndex !== undefined) {
        benchmarkProfiler?.markCpuEncodeStart();
      }

      const stamper = stamperRef.current;

      // Apply pressure curve
      const adjustedPressure = applyPressureCurve(pressure, config.pressureCurve);
      const tiltX = dynamics?.tiltX ?? 0;
      const tiltY = dynamics?.tiltY ?? 0;
      const rotation = dynamics?.rotation ?? 0;

      // Store stroke-level opacity (applied at endStroke/compositeToLayer)
      const strokeOpacity = Math.max(0, Math.min(1, config.opacity));
      strokeOpacityRef.current = strokeOpacity;
      const hasStrokeOpacity = strokeOpacity > 1e-6;

      // Calculate base size (pressure toggle)
      const size = config.pressureSizeEnabled ? config.size * adjustedPressure : config.size;

      // Shape Dynamics size control should affect spacing (jitter does not)
      let spacingSize = size;
      if (config.shapeDynamicsEnabled && config.shapeDynamics?.sizeControl !== 'off') {
        const spacingInput: DynamicsInput = {
          pressure: adjustedPressure,
          tiltX,
          tiltY,
          rotation,
          direction: 0,
          initialDirection: 0,
          fadeProgress: 0,
        };
        spacingSize = computeControlledSize(size, config.shapeDynamics!, spacingInput);
      }

      // Get dab positions from stamper
      const spacingBase = computeSpacingBasePx(spacingSize, config.roundness / 100, config.texture);
      const spacingPx = spacingBase * config.spacing;
      const buildupMode = config.buildupEnabled;
      const dabs = stamper.processPoint(x, y, pressure, spacingPx, buildupMode);

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
          pressure,
          secondarySpacingPx,
          buildupMode
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

      // Shape Dynamics: Check if we need to apply dynamics
      const useShapeDynamics =
        config.shapeDynamicsEnabled &&
        config.shapeDynamics &&
        isShapeDynamicsActive(config.shapeDynamics);

      // Scatter: Check if we need to apply scatter
      const useScatter = config.scatterEnabled && config.scatter && isScatterActive(config.scatter);

      // Color Dynamics: Check if we need to apply dynamics
      const useColorDynamics =
        config.colorDynamicsEnabled &&
        config.colorDynamics &&
        isColorDynamicsActive(config.colorDynamics);

      // Transfer: Check if we need to apply transfer dynamics
      const useTransfer =
        config.transferEnabled && config.transfer && isTransferActive(config.transfer);

      // Selection constraint: get state once before loop for performance
      const selectionState = useSelectionStore.getState();
      const hasSelection = selectionState.hasSelection;
      const skipCpuSelectionCheck = backend === 'gpu' && config.selectionHandledByGpu === true;

      for (const dab of dabs) {
        // Selection constraint: skip dabs outside selection
        if (
          !skipCpuSelectionCheck &&
          hasSelection &&
          !selectionState.isPointInSelection(dab.x, dab.y)
        ) {
          continue;
        }

        lastDabPosRef.current = { x: dab.x, y: dab.y };

        const dabPressure = applyPressureCurve(dab.pressure, config.pressureCurve);
        let dabSize = config.pressureSizeEnabled ? config.size * dabPressure : config.size;

        // Shape Dynamics: Calculate direction and apply dynamics
        let dabRoundness = config.roundness / 100;
        let dabAngle = config.angle;
        let dabFlipX = false;
        let dabFlipY = false;

        // Calculate direction from previous dab (needed for Shape Dynamics, Scatter, Color Dynamics, and Transfer)
        let direction = 0;
        if (prevDabPosRef.current) {
          direction = calculateDirection(
            prevDabPosRef.current.x,
            prevDabPosRef.current.y,
            dab.x,
            dab.y
          );
          // Capture initial direction on first movement
          if (initialDirectionRef.current === 0 && direction !== 0) {
            initialDirectionRef.current = direction;
          }
        }

        // Prepare dynamics input (shared by Shape Dynamics, Scatter, Color Dynamics, and Transfer)
        const dynamicsInput: DynamicsInput = {
          pressure: dabPressure,
          tiltX,
          tiltY,
          rotation,
          direction,
          initialDirection: initialDirectionRef.current,
          fadeProgress: 0, // TODO: Implement fade tracking based on stroke distance
        };

        // Calculate Flow and Opacity using Transfer system or legacy pressure toggles
        let dabFlow: number;
        let dabOpacity: number;

        if (useTransfer && config.transfer) {
          // Use Transfer dynamics system (Photoshop-compatible)
          const transferResult = computeDabTransfer(
            strokeOpacity,
            config.flow,
            config.transfer,
            dynamicsInput
          );
          dabFlow = transferResult.flow;
          dabOpacity = hasStrokeOpacity ? transferResult.opacity / strokeOpacity : 0.0;
        } else {
          // Legacy pressure toggles (backward compatibility)
          dabFlow = config.pressureFlowEnabled ? config.flow * dabPressure : config.flow;
          dabOpacity = hasStrokeOpacity ? (config.pressureOpacityEnabled ? dabPressure : 1.0) : 0.0;
        }

        if (useShapeDynamics && config.shapeDynamics) {
          // Compute dynamic shape
          const shape = computeDabShape(
            dabSize,
            config.angle,
            config.roundness, // 0-100
            config.shapeDynamics,
            dynamicsInput
          );

          dabSize = shape.size;
          dabAngle = shape.angle;
          dabRoundness = shape.roundness; // Already 0-1
          dabFlipX = shape.flipX;
          dabFlipY = shape.flipY;
        }

        // Update previous dab position for next direction calculation
        prevDabPosRef.current = { x: dab.x, y: dab.y };

        // Color Dynamics: Calculate dynamic color
        let dabColor = config.color;
        if (useColorDynamics && config.colorDynamics) {
          const colorResult = computeDabColor(
            config.color,
            config.backgroundColor,
            config.colorDynamics,
            dynamicsInput
          );
          dabColor = colorResult.color;
        }

        // Apply Scatter: generate one or more scattered positions
        const scatteredPositions = useScatter
          ? applyScatter(
              {
                x: dab.x,
                y: dab.y,
                strokeAngle: (direction * Math.PI) / 180, // Convert degrees to radians
                diameter: dabSize,
                dynamics: dynamicsInput,
              },
              config.scatter!
            )
          : [{ x: dab.x, y: dab.y }];

        if (config.dualBrushEnabled && config.dualBrush?.texture?.imageData) {
          // console.log('[useBrushRenderer] DualBrush has imageData prepared');
        }

        // Stamp dab at each scattered position
        for (const pos of scatteredPositions) {
          const dabParams: DabParams = {
            x: pos.x,
            y: pos.y,
            size: Math.max(1, dabSize),
            flow: dabFlow,
            hardness: config.hardness / 100,
            maskType: config.maskType,
            color: dabColor,
            dabOpacity,
            roundness: dabRoundness,
            angle: dabAngle,
            texture: config.texture ?? undefined,
            flipX: dabFlipX,
            flipY: dabFlipY,
            wetEdge: config.wetEdgeEnabled ? config.wetEdge : 0,
            textureSettings: config.textureEnabled ? config.textureSettings : undefined,
            noiseEnabled: config.noiseEnabled,
            dualBrush:
              config.dualBrushEnabled && config.dualBrush
                ? {
                    ...config.dualBrush,
                    enabled: config.dualBrushEnabled, // Sync enabled state
                    brushTexture: config.dualBrush.texture,
                  }
                : undefined,
            baseSize: config.size,
            spacing: config.spacing,
          };

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
        }
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
    [backend, benchmarkProfiler, ensureCPUBuffer]
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
      stamperRef.current.finishStroke(0);

      if (strokeCancelledRef.current) {
        strokeCancelledRef.current = false;
        return;
      }

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
            gpuBuffer.compositeToLayer(layerCtx, strokeOpacityRef.current);
            gpuBuffer.clear();
          } finally {
            finishingPromiseRef.current = null;
          }
        })();

        await finishingPromiseRef.current;
      } else if (cpuBufferRef.current) {
        cpuBufferRef.current.endStroke(layerCtx, strokeOpacityRef.current);
      }
    },
    [backend]
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
      scratch: null,
    };
  }, [backend, releaseGpuCommitLock]);

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
  };
}
