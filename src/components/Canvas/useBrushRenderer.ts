/**
 * useBrushRenderer - Hook for Flow/Opacity three-level brush rendering pipeline
 *
 * This hook manages the stroke buffer and dab stamping to achieve
 * Photoshop-like brush behavior with proper Flow/Opacity separation.
 */

import { useRef, useCallback } from 'react';
import { StrokeBuffer, BrushStamper, DabParams } from '@/utils/strokeBuffer';
import { applyPressureCurve, PressureCurve } from '@/stores/tool';

export interface BrushRenderConfig {
  size: number;
  flow: number;
  opacity: number;
  hardness: number;
  spacing: number;
  color: string;
  pressureSizeEnabled: boolean;
  pressureFlowEnabled: boolean;
  pressureCurve: PressureCurve;
}

export interface UseBrushRendererProps {
  width: number;
  height: number;
}

// Pressure fade-in settings to prevent heavy first dab from WinTab
const FADE_IN_POINTS = 3;
const FIRST_POINT_MAX_PRESSURE = 0.3;

export function useBrushRenderer({ width, height }: UseBrushRendererProps) {
  const strokeBufferRef = useRef<StrokeBuffer | null>(null);
  const stamperRef = useRef<BrushStamper>(new BrushStamper());
  const pointCountRef = useRef<number>(0);

  // Apply pressure fade-in to prevent heavy first dab
  const applyPressureFadeIn = useCallback((pressure: number): number => {
    const count = pointCountRef.current;
    if (count >= FADE_IN_POINTS) {
      return pressure;
    }

    // First point: cap at max first point pressure
    if (count === 0) {
      return Math.min(pressure, FIRST_POINT_MAX_PRESSURE);
    }

    // Subsequent fade-in points: interpolate from capped to full
    const t = count / FADE_IN_POINTS;
    const cappedPressure = Math.min(pressure, FIRST_POINT_MAX_PRESSURE);
    return cappedPressure + (pressure - cappedPressure) * t;
  }, []);

  // Initialize or resize stroke buffer
  const ensureStrokeBuffer = useCallback(() => {
    if (!strokeBufferRef.current) {
      strokeBufferRef.current = new StrokeBuffer(width, height);
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
    pointCountRef.current = 0; // Reset pressure fade-in counter
  }, [ensureStrokeBuffer]);

  /**
   * Process a point during stroke and render dabs to stroke buffer
   */
  const processPoint = useCallback(
    (x: number, y: number, pressure: number, config: BrushRenderConfig): void => {
      const buffer = strokeBufferRef.current;
      if (!buffer || !buffer.isActive()) return;

      const stamper = stamperRef.current;

      // Apply pressure fade-in BEFORE pressure curve to prevent heavy first dab
      const fadedPressure = applyPressureFadeIn(pressure);
      pointCountRef.current++;

      // Apply pressure curve
      const adjustedPressure = applyPressureCurve(fadedPressure, config.pressureCurve);

      // Calculate dynamic size for stamper spacing calculation
      const size = config.pressureSizeEnabled ? config.size * adjustedPressure : config.size;

      // Get dab positions from stamper (pass faded pressure, not raw)
      const dabs = stamper.processPoint(x, y, fadedPressure, size, config.spacing);

      // Stamp each dab to the stroke buffer
      for (const dab of dabs) {
        const dabPressure = applyPressureCurve(dab.pressure, config.pressureCurve);
        const dabSize = config.pressureSizeEnabled ? config.size * dabPressure : config.size;
        const dabFlow = config.pressureFlowEnabled ? config.flow * dabPressure : config.flow;

        const dabParams: DabParams = {
          x: dab.x,
          y: dab.y,
          size: Math.max(1, dabSize),
          flow: dabFlow,
          hardness: config.hardness / 100, // Convert from 0-100 to 0-1
          color: config.color,
          opacityCeiling: config.opacity, // Apply opacity ceiling during stamping for accurate preview
        };

        buffer.stampDab(dabParams);
      }
    },
    [applyPressureFadeIn]
  );

  /**
   * End stroke and composite to layer with opacity ceiling
   */
  const endStroke = useCallback((layerCtx: CanvasRenderingContext2D, opacity: number) => {
    const buffer = strokeBufferRef.current;
    if (!buffer) return;

    buffer.endStroke(layerCtx, opacity);
    stamperRef.current.finishStroke();
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
