/**
 * useBrushRenderer - Hook for Flow/Opacity three-level brush rendering pipeline
 *
 * This hook manages the stroke buffer and dab stamping to achieve
 * Photoshop-like brush behavior with proper Flow/Opacity separation.
 */

import { useRef, useCallback } from 'react';
import { StrokeAccumulator, BrushStamper, DabParams, MaskType } from '@/utils/strokeBuffer';
import { applyPressureCurve, PressureCurve } from '@/stores/tool';

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
}

// Pressure fade-in is now handled in Rust backend (PressureSmoother)
// Frontend no longer needs its own fade-in logic

export function useBrushRenderer({ width, height }: UseBrushRendererProps) {
  const strokeBufferRef = useRef<StrokeAccumulator | null>(null);
  const stamperRef = useRef<BrushStamper>(new BrushStamper());

  // Initialize or resize stroke buffer
  const ensureStrokeBuffer = useCallback(() => {
    if (!strokeBufferRef.current) {
      strokeBufferRef.current = new StrokeAccumulator(width, height);
    } else {
      const dims = strokeBufferRef.current.getDimensions();
      if (dims.width !== width || dims.height !== height) {
        strokeBufferRef.current.resize(width, height);
      }
    }
    return strokeBufferRef.current;
  }, [width, height]);

  /**
   * Begin a new brush stroke
   * @param hardness - Brush hardness (0-100), determines if Rust SIMD path is used
   */
  const beginStroke = useCallback(
    (hardness: number = 100) => {
      const buffer = ensureStrokeBuffer();
      buffer.beginStroke(hardness / 100); // Convert 0-100 to 0-1
      stamperRef.current.beginStroke();
    },
    [ensureStrokeBuffer]
  );

  /**
   * Process a point and render dabs to stroke buffer
   * Uses Rust SIMD backend for soft brushes (hardness < 95)
   */
  const processPoint = useCallback(
    (x: number, y: number, pressure: number, config: BrushRenderConfig): void => {
      const buffer = strokeBufferRef.current;
      if (!buffer || !buffer.isActive()) return;

      const stamper = stamperRef.current;
      const useRustPath = buffer.isUsingRustPath();

      // Apply pressure curve (fade-in already applied by backend)
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
          hardness: config.hardness / 100, // Convert from 0-100 to 0-1
          maskType: config.maskType,
          color: config.color,
          dabOpacity,
          roundness: config.roundness / 100, // Convert from 0-100 to 0-1
          angle: config.angle,
        };

        // Use Rust SIMD for soft brushes, JS for hard brushes
        if (useRustPath) {
          // Fire and forget - Rust path is async but we don't wait
          void buffer.stampDabRust(dabParams);
        } else {
          buffer.stampDab(dabParams);
        }
      }
    },
    []
  );

  /**
   * End stroke and composite to layer (opacity already baked at dab level)
   */
  const endStroke = useCallback((layerCtx: CanvasRenderingContext2D) => {
    const buffer = strokeBufferRef.current;
    if (!buffer) return;

    stamperRef.current.finishStroke(0);
    buffer.endStroke(layerCtx, 1.0);
  }, []);

  const getPreviewCanvas = useCallback(() => {
    return strokeBufferRef.current?.getCanvas() ?? null;
  }, []);

  const getPreviewOpacity = useCallback(() => 1.0, []);

  const isStrokeActive = useCallback(() => {
    return strokeBufferRef.current?.isActive() ?? false;
  }, []);

  return {
    beginStroke,
    processPoint,
    endStroke,
    getPreviewCanvas,
    getPreviewOpacity,
    isStrokeActive,
  };
}
