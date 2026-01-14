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
import { StrokeAccumulator, BrushStamper, DabParams, MaskType } from '@/utils/strokeBuffer';
import { applyPressureCurve, PressureCurve, RenderMode } from '@/stores/tool';
import {
  GPUContext,
  GPUStrokeAccumulator,
  shouldUseGPU,
  reportGPUFallback,
  type RenderBackend,
} from '@/gpu';

export interface BrushRenderConfig {
  size: number;
  flow: number;
  opacity: number;
  hardness: number;
  maskType: MaskType; // Mask type: 'gaussian' or 'default'
  spacing: number;
  roundness: number; // 0-1 (1 = circle, <1 = ellipse)
  angle: number; // 0-360 degrees
  color: string;
  pressureSizeEnabled: boolean;
  pressureFlowEnabled: boolean;
  pressureOpacityEnabled: boolean;
  pressureCurve: PressureCurve;
}

export interface UseBrushRendererProps {
  width: number;
  height: number;
  /** User-selected render mode */
  renderMode: RenderMode;
}

export interface UseBrushRendererResult {
  beginStroke: (hardness?: number) => void;
  processPoint: (x: number, y: number, pressure: number, config: BrushRenderConfig) => void;
  endStroke: (layerCtx: CanvasRenderingContext2D) => Promise<void>;
  getPreviewCanvas: () => HTMLCanvasElement | null;
  getPreviewOpacity: () => number;
  isStrokeActive: () => boolean;
  /** Actual backend in use (may differ from requested if GPU unavailable) */
  backend: RenderBackend;
  /** Whether GPU is available */
  gpuAvailable: boolean;
}

export function useBrushRenderer({
  width,
  height,
  renderMode,
}: UseBrushRendererProps): UseBrushRendererResult {
  const [gpuAvailable, setGpuAvailable] = useState(false);

  // CPU backend (Canvas 2D)
  const cpuBufferRef = useRef<StrokeAccumulator | null>(null);

  // GPU backend (WebGPU)
  const gpuBufferRef = useRef<GPUStrokeAccumulator | null>(null);

  // Shared stamper (generates dab positions)
  const stamperRef = useRef<BrushStamper>(new BrushStamper());

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
          setGpuAvailable(true);
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

  // Determine actual backend based on renderMode and GPU availability
  const backend: RenderBackend = (() => {
    if (!gpuAvailable || !gpuBufferRef.current) {
      return 'canvas2d';
    }
    return renderMode === 'gpu' ? 'gpu' : 'canvas2d';
  })();

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
   */
  const beginStroke = useCallback(
    (hardness: number = 100) => {
      stamperRef.current.beginStroke();

      if (backend === 'gpu' && gpuBufferRef.current) {
        gpuBufferRef.current.beginStroke();
      } else {
        const buffer = ensureCPUBuffer();
        buffer.beginStroke(hardness / 100);
      }
    },
    [backend, ensureCPUBuffer]
  );

  /**
   * Process a point and render dabs to stroke buffer
   */
  const processPoint = useCallback(
    (x: number, y: number, pressure: number, config: BrushRenderConfig): void => {
      const stamper = stamperRef.current;

      // Apply pressure curve
      const adjustedPressure = applyPressureCurve(pressure, config.pressureCurve);

      // Calculate dynamic size for stamper spacing calculation
      const size = config.pressureSizeEnabled ? config.size * adjustedPressure : config.size;

      // Get dab positions from stamper
      const dabs = stamper.processPoint(x, y, pressure, size, config.spacing);

      for (const dab of dabs) {
        const dabPressure = applyPressureCurve(dab.pressure, config.pressureCurve);
        const dabSize = config.pressureSizeEnabled ? config.size * dabPressure : config.size;
        const dabFlow = config.pressureFlowEnabled ? config.flow * dabPressure : config.flow;

        const dabOpacity = config.pressureOpacityEnabled
          ? config.opacity * dabPressure
          : config.opacity;

        const dabParams: DabParams = {
          x: dab.x,
          y: dab.y,
          size: Math.max(1, dabSize),
          flow: dabFlow,
          hardness: config.hardness / 100,
          maskType: config.maskType,
          color: config.color,
          dabOpacity,
          roundness: config.roundness / 100,
          angle: config.angle,
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
    },
    [backend]
  );

  /**
   * End stroke and composite to layer
   * Returns a Promise that resolves when compositing is complete
   */
  const endStroke = useCallback(
    async (layerCtx: CanvasRenderingContext2D): Promise<void> => {
      stamperRef.current.finishStroke(0);

      if (backend === 'gpu' && gpuBufferRef.current) {
        await gpuBufferRef.current.endStroke(layerCtx, 1.0);
      } else if (cpuBufferRef.current) {
        cpuBufferRef.current.endStroke(layerCtx, 1.0);
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
   * Get preview opacity (always 1.0 as opacity is baked into dabs)
   */
  const getPreviewOpacity = useCallback(() => 1.0, []);

  /**
   * Check if stroke is active
   */
  const isStrokeActive = useCallback(() => {
    if (backend === 'gpu' && gpuBufferRef.current) {
      return gpuBufferRef.current.isActive();
    }
    return cpuBufferRef.current?.isActive() ?? false;
  }, [backend]);

  return {
    beginStroke,
    processPoint,
    endStroke,
    getPreviewCanvas,
    getPreviewOpacity,
    isStrokeActive,
    backend,
    gpuAvailable,
  };
}
