/**
 * useBrushRenderer - Hook for Flow/Opacity three-level brush rendering pipeline
 *
 * This hook manages the stroke buffer and dab stamping to achieve
 * Photoshop-like brush behavior with proper Flow/Opacity separation.
 */

import { useRef, useCallback } from 'react';
import { StrokeAccumulator, BrushStamper, DabParams, MaskType } from '@/utils/strokeBuffer';
import { applyPressureCurve, PressureCurve } from '@/stores/tool';
import { HARD_BRUSH_THRESHOLD } from '@/constants';

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
  const strokeModeRef = useRef<'hard' | 'soft'>('soft');

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
   */
  const beginStroke = useCallback(() => {
    const buffer = ensureStrokeBuffer();
    buffer.beginStroke();
    stamperRef.current.beginStroke();
  }, [ensureStrokeBuffer]);

  /**
   * Process a point during stroke and render dabs to stroke buffer
   * Note: Pressure fade-in is handled in Rust backend (PressureSmoother)
   */
  const processPoint = useCallback(
    (x: number, y: number, pressure: number, config: BrushRenderConfig): void => {
      const buffer = strokeBufferRef.current;
      if (!buffer || !buffer.isActive()) return;

      const stamper = stamperRef.current;

      // Apply pressure curve (fade-in already applied by backend)
      const adjustedPressure = applyPressureCurve(pressure, config.pressureCurve);

      // Calculate dynamic size for stamper spacing calculation
      const size = config.pressureSizeEnabled ? config.size * adjustedPressure : config.size;

      // Get dab positions from stamper
      const dabs = stamper.processPoint(x, y, pressure, size, config.spacing);

      // Stamp each dab to the stroke buffer
      // Stamp each dab to the stroke buffer
      for (const dab of dabs) {
        const dabPressure = applyPressureCurve(dab.pressure, config.pressureCurve);
        const dabSize = config.pressureSizeEnabled ? config.size * dabPressure : config.size;
        const dabFlow = config.pressureFlowEnabled ? config.flow * dabPressure : config.flow;

        // Hybrid Strategy:
        // - Hard Brushes (>= Threshold): Use Opacity Ceiling (Clamp) to maintain solid edges.
        // - Soft Brushes (< Threshold): Use Post-Multiply to allow smooth gradients.
        const isHardBrush = config.hardness >= HARD_BRUSH_THRESHOLD;
        strokeModeRef.current = isHardBrush ? 'hard' : 'soft';

        let finalFlow = dabFlow;
        let ceiling: number | undefined = undefined;

        if (isHardBrush) {
          // Hard Mode: Clamp (Old behavior)
          // Opacity pressure affects the ceiling
          ceiling = config.pressureOpacityEnabled ? config.opacity * dabPressure : config.opacity;
          finalFlow = dabFlow; // Flow stays as flow
        } else {
          // Soft Mode: Post-Multiply (New behavior)
          // Opacity pressure modulates flow
          const opacityScale = config.pressureOpacityEnabled ? dabPressure : 1.0;
          finalFlow = dabFlow * opacityScale;
          ceiling = undefined;
        }

        const dabParams: DabParams = {
          x: dab.x,
          y: dab.y,
          size: Math.max(1, dabSize),
          flow: finalFlow,
          hardness: config.hardness / 100, // Convert from 0-100 to 0-1
          maskType: config.maskType,
          color: config.color,
          opacityCeiling: ceiling,
          roundness: config.roundness / 100, // Convert from 0-100 to 0-1
          angle: config.angle,
        };

        buffer.stampDab(dabParams);
      }
    },
    []
  );

  /**
   * End stroke and composite to layer with opacity ceiling
   */
  const endStroke = useCallback((layerCtx: CanvasRenderingContext2D, opacity: number) => {
    const buffer = strokeBufferRef.current;
    if (!buffer) return;

    // Reset stamper state (no artificial fadeout - rely on natural pressure)
    stamperRef.current.finishStroke(0);

    // Hybrid Strategy: Determine endStroke opacity
    // If Hard mode, opacity was applied at proper ceiling. End stroke should be composite at full strength.
    // If Soft mode, opacity is applied here as a multiplier as ceiling was 1.0.
    const finalOpacity = strokeModeRef.current === 'hard' ? 1.0 : opacity;

    buffer.endStroke(layerCtx, finalOpacity);
  }, []);

  /**
   * Get the stroke buffer canvas for preview rendering
   */
  const getPreviewCanvas = useCallback(() => {
    return strokeBufferRef.current?.getCanvas() ?? null;
  }, []);

  /**
   * Check if stroke is active
   */
  const isStrokeActive = useCallback(() => {
    return strokeBufferRef.current?.isActive() ?? false;
  }, []);

  return {
    beginStroke,
    processPoint,
    endStroke,
    getPreviewCanvas,
    isStrokeActive,
  };
}
