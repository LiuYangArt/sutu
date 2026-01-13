/**
 * StrokeAccumulator - Frontend implementation of the three-level rendering pipeline
 *
 * This implements the Flow/Opacity separation mechanism:
 * - Flow: Per-dab opacity, accumulates within a stroke
 * - Opacity: Ceiling for the entire stroke, applied when compositing to layer
 *
 * Architecture:
 * 1. Dab Level: Individual brush stamps with Flow-controlled alpha
 * 2. Stroke Accumulator: Accumulates dabs within a single stroke
 * 3. Layer Level: Composites stroke with Opacity as ceiling
 */

export type MaskType = 'gaussian' | 'default';

export interface DabParams {
  x: number;
  y: number;
  size: number;
  flow: number; // Per-dab opacity (0-1)
  hardness: number; // Edge hardness (0-1)
  maskType?: MaskType; // Mask type: 'gaussian' (erf-based, default) or 'default' (simple)
  color: string; // Hex color
  opacityCeiling?: number; // Optional opacity ceiling (0-1). If set, limits max accumulation.
  roundness?: number; // Brush roundness (0-1, 1 = circle, <1 = ellipse)
  angle?: number; // Brush angle in degrees (0-360)
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Error function approximation (Abramowitz and Stegun formula 7.1.26)
 * Used for Krita-style Gaussian mask falloff
 * Accuracy: |error| < 1.5e-7
 */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1.0 / (1.0 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return sign * y;
}

/**
 * Parse hex color to RGB components (0-255)
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) {
    return { r: 0, g: 0, b: 0 };
  }
  return {
    r: parseInt(result[1]!, 16),
    g: parseInt(result[2]!, 16),
    b: parseInt(result[3]!, 16),
  };
}

/**
 * StrokeAccumulator class for accumulating dabs within a single stroke
 */
export class StrokeAccumulator {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private active: boolean = false;
  private dirtyRect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('Failed to create 2D context for StrokeAccumulator');
    }
    this.ctx = ctx;
    this.clear();
  }

  /**
   * Resize the buffer (clears content)
   */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.clear();
  }

  /**
   * Begin a new stroke
   */
  beginStroke(): void {
    this.clear();
    this.active = true;
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.dirtyRect = {
      left: this.width,
      top: this.height,
      right: 0,
      bottom: 0,
    };
    this.active = false;
  }

  /**
   * Check if stroke is active
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Expand dirty rect to include a dab
   */
  private expandDirtyRect(x: number, y: number, radius: number): void {
    const margin = Math.ceil(radius) + 1;
    this.dirtyRect.left = Math.min(this.dirtyRect.left, Math.floor(x - margin));
    this.dirtyRect.top = Math.min(this.dirtyRect.top, Math.floor(y - margin));
    this.dirtyRect.right = Math.max(this.dirtyRect.right, Math.ceil(x + margin));
    this.dirtyRect.bottom = Math.max(this.dirtyRect.bottom, Math.ceil(y + margin));
  }

  /**
   * Stamp an elliptical dab onto the buffer with opacity ceiling and anti-aliasing
   * Supports roundness (ellipse) and angle (rotation)
   */
  stampDab(params: DabParams): void {
    const {
      x,
      y,
      size,
      flow,
      hardness,
      maskType = 'gaussian', // Default to Krita-style erf Gaussian
      color,
      opacityCeiling, // Hybrid Strategy: Used for Hard brushes to prevent edge thinning
      roundness = 1,
      angle = 0,
    } = params;
    const radiusX = size / 2;
    const radiusY = radiusX * roundness; // Scale Y radius for roundness

    if (radiusX < 0.5) return;

    // Use the larger radius for calculations
    const maxRadius = Math.max(radiusX, radiusY);

    // Krita-style Gaussian logic adjustments for softer edges
    const fade = maskType === 'gaussian' ? (1.0 - hardness) * 2.0 : 0; // Enhance fade range for smoother falloff

    // Dynamic extent multiplier based on mask type
    let extentMultiplier: number;
    if (hardness >= 0.99) {
      extentMultiplier = 1.0;
    } else if (maskType === 'gaussian') {
      // Gaussian (erf) mask decays much faster than simple exp()
      // Extend calculation area significantly for soft brushes
      extentMultiplier = 1.0 + fade;
    } else {
      // Default simple Gaussian: 1.5x fallback
      extentMultiplier = 1.5;
    }

    const effectiveRadius = maxRadius * extentMultiplier + 1; // +1 for AA margin

    // Expand dirty rect with the EFFECTIVE radius (including soft brush extension)
    this.expandDirtyRect(x, y, effectiveRadius);

    const rgb = hexToRgb(color);

    // Pre-calculate rotation values (angle in degrees to radians)
    const angleRad = (angle * Math.PI) / 180;
    const cosA = Math.cos(-angleRad); // Negative for inverse rotation
    const sinA = Math.sin(-angleRad);

    // Calculate bounding box for pixel operations
    const left = Math.max(0, Math.floor(x - effectiveRadius));
    const top = Math.max(0, Math.floor(y - effectiveRadius));
    const right = Math.min(this.width, Math.ceil(x + effectiveRadius));
    const bottom = Math.min(this.height, Math.ceil(y + effectiveRadius));
    const rectWidth = right - left;
    const rectHeight = bottom - top;

    if (rectWidth <= 0 || rectHeight <= 0) return;

    // Get current buffer data for the dab region
    const bufferData = this.ctx.getImageData(left, top, rectWidth, rectHeight);

    // Process each pixel in the dab region
    for (let py = 0; py < rectHeight; py++) {
      for (let px = 0; px < rectWidth; px++) {
        const worldX = left + px;
        const worldY = top + py;

        // Calculate offset from dab center (sample at pixel center)
        const dx = worldX + 0.5 - x;
        const dy = worldY + 0.5 - y;

        // Apply inverse rotation to get position in brush-local coordinates
        const localX = dx * cosA - dy * sinA;
        const localY = dx * sinA + dy * cosA;

        // Calculate normalized distance for ellipse
        // dist = 1.0 at the edge of the ellipse
        const normX = localX / radiusX;
        const normY = localY / radiusY;
        const normDist = Math.sqrt(normX * normX + normY * normY);

        // Calculate dab alpha based on hardness and mask type
        const dabAlpha = this.calculateMaskAlpha(normDist, radiusX, flow, hardness, maskType, fade);

        if (dabAlpha <= 0.001) continue;

        if (dabAlpha <= 0.001) continue;

        const idx = (py * rectWidth + px) * 4;

        // Get current buffer pixel
        const dstR = bufferData.data[idx] ?? 0;
        const dstG = bufferData.data[idx + 1] ?? 0;
        const dstB = bufferData.data[idx + 2] ?? 0;
        const dstA = (bufferData.data[idx + 3] ?? 0) / 255;

        // Hybrid Strategy: Opacity Ceiling for Hard Brushes
        // If opacityCeiling is set (for Hard brushes), simple clamping is used.
        if (opacityCeiling !== undefined && dstA >= opacityCeiling - 0.001) {
          continue;
        }

        // Porter-Duff "over" compositing
        const srcA = dabAlpha;
        let outA = srcA + dstA * (1 - srcA);

        // Apply opacity ceiling if defined
        if (opacityCeiling !== undefined && outA > opacityCeiling) {
          outA = opacityCeiling;
        }

        if (outA > 0) {
          // Recalculate effective source contribution using the clamped outA
          // effectiveSrcA is derived from the standard Over formula: outA = srcA_eff + dstA * (1 - srcA_eff)
          // But here we clamped outA.
          // Correct approach for clamping:
          // We effectively reduce srcA to fit the ceiling.
          // outA = newSrcA + dstA * (1 - newSrcA)
          // Solve for newSrcA:
          // outA - dstA = newSrcA * (1 - dstA)
          // newSrcA = (outA - dstA) / (1 - dstA)

          let effectiveSrcA: number;
          if (opacityCeiling !== undefined && outA >= opacityCeiling) {
            // Clamped state
            if (dstA >= 0.999) {
              effectiveSrcA = 0;
            } else {
              effectiveSrcA = (outA - dstA) / (1.0 - dstA);
            }
            // Clamp effectiveSrcA to [0, 1] just in case
            effectiveSrcA = Math.max(0, Math.min(1, effectiveSrcA));
          } else {
            // Standard composition (Post-Multiply mode or pre-ceiling)
            // In this case effectiveSrcA is just srcA as per standard formula?
            // Actually, the original accumulation logic:
            // outR = (srcR * srcA + dstR * dstA * (1 - srcA)) / outA
            // Here effectiveSrcA = srcA.
            effectiveSrcA = srcA;
          }

          let outR: number, outG: number, outB: number;

          if (effectiveSrcA > 0.001 && outA > 0.001) {
            // Note: Use effectiveSrcA for color mixing
            outR = (rgb.r * effectiveSrcA + dstR * dstA * (1 - effectiveSrcA)) / outA;
            outG = (rgb.g * effectiveSrcA + dstG * dstA * (1 - effectiveSrcA)) / outA;
            outB = (rgb.b * effectiveSrcA + dstB * dstA * (1 - effectiveSrcA)) / outA;
          } else {
            // No effective contribution, keep destination color
            outR = dstR;
            outG = dstG;
            outB = dstB;
          }

          bufferData.data[idx] = Math.round(Math.min(255, Math.max(0, outR)));
          bufferData.data[idx + 1] = Math.round(Math.min(255, Math.max(0, outG)));
          bufferData.data[idx + 2] = Math.round(Math.min(255, Math.max(0, outB)));

          // Dithering
          const ditherPattern = ((worldX + worldY) % 2) * 0.5 - 0.25;
          const ditheredAlpha = outA * 255 + ditherPattern;
          bufferData.data[idx + 3] = Math.round(Math.min(255, Math.max(0, ditheredAlpha)));
        }
      }
    }

    // Write back to buffer
    this.ctx.putImageData(bufferData, left, top);
  }

  /**
   * End the stroke and composite to layer with opacity ceiling
   *
   * @param layerCtx - Target layer context
   * @param opacity - Maximum opacity (ceiling) for this stroke
   * @returns The dirty rectangle that was modified
   */
  endStroke(layerCtx: CanvasRenderingContext2D, opacity: number): Rect {
    if (!this.active) {
      return { left: 0, top: 0, right: 0, bottom: 0 };
    }

    this.active = false;

    // Clamp dirty rect to buffer bounds
    const rect: Rect = {
      left: Math.max(0, this.dirtyRect.left),
      top: Math.max(0, this.dirtyRect.top),
      right: Math.min(this.width, this.dirtyRect.right),
      bottom: Math.min(this.height, this.dirtyRect.bottom),
    };

    const rectWidth = rect.right - rect.left;
    const rectHeight = rect.bottom - rect.top;

    if (rectWidth <= 0 || rectHeight <= 0) {
      return rect;
    }

    // Get stroke buffer data
    const strokeData = this.ctx.getImageData(rect.left, rect.top, rectWidth, rectHeight);

    // Get layer data
    const layerData = layerCtx.getImageData(rect.left, rect.top, rectWidth, rectHeight);

    // Apply opacity multiplier (Post-Multiply)
    // The opacity controls the layer-level accumulation, not the dab-level clamping
    const opacityFloat = Math.max(0, Math.min(1, opacity));

    for (let i = 0; i < strokeData.data.length; i += 4) {
      const strokeAlpha = strokeData.data[i + 3] ?? 0;

      if (strokeAlpha === 0) continue;

      // Apply opacity scaling
      const scaledAlpha = strokeAlpha * opacityFloat;
      const srcAlpha = scaledAlpha / 255;

      // Get stroke color (unpremultiply if needed)
      const srcR = strokeData.data[i] ?? 0;
      const srcG = strokeData.data[i + 1] ?? 0;
      const srcB = strokeData.data[i + 2] ?? 0;

      // Get layer color
      const dstR = layerData.data[i] ?? 0;
      const dstG = layerData.data[i + 1] ?? 0;
      const dstB = layerData.data[i + 2] ?? 0;
      const dstAlpha = (layerData.data[i + 3] ?? 0) / 255;

      // Porter-Duff "over" compositing
      const outAlpha = srcAlpha + dstAlpha * (1 - srcAlpha);

      if (outAlpha > 0) {
        layerData.data[i] = Math.round(
          (srcR * srcAlpha + dstR * dstAlpha * (1 - srcAlpha)) / outAlpha
        );
        layerData.data[i + 1] = Math.round(
          (srcG * srcAlpha + dstG * dstAlpha * (1 - srcAlpha)) / outAlpha
        );
        layerData.data[i + 2] = Math.round(
          (srcB * srcAlpha + dstB * dstAlpha * (1 - srcAlpha)) / outAlpha
        );
        layerData.data[i + 3] = Math.round(outAlpha * 255);
      }
    }

    // Write back to layer
    layerCtx.putImageData(layerData, rect.left, rect.top);

    return rect;
  }

  /**
   * Get the dirty rectangle
   */
  getDirtyRect(): Rect {
    return { ...this.dirtyRect };
  }

  /**
   * Get buffer dimensions
   */
  getDimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /**
   * Calculate dab alpha based on hardness and mask type
   */
  private calculateMaskAlpha(
    normDist: number,
    radiusX: number,
    flow: number,
    hardness: number,
    maskType: string,
    fade: number
  ): number {
    let dabAlpha: number;

    if (hardness >= 0.99) {
      // Hard brush: full alpha inside, AA at edge
      // Improved AA: linear falloff over 1px at the exact physical edge
      const physicalDist = normDist * radiusX;
      const distFromEdge = physicalDist - radiusX;

      if (distFromEdge > 1.0) {
        return 0; // Outside AA zone
      } else if (distFromEdge > 0.0) {
        // Anti-aliasing zone (0 to 1px outside nominal radius)
        // Linear falloff from 1.0 to 0.0 over 1px
        dabAlpha = flow * (1.0 - distFromEdge);
      } else {
        dabAlpha = flow;
      }
    } else if (maskType === 'gaussian') {
      // Krita-style Gaussian (erf-based)
      // Use enhanced fade calculation (up to 2.0)
      // Avoid 0/1 singularities exactly like Krita
      const safeFade = Math.max(1e-6, Math.min(2.0, fade));

      // Krita's magic constants
      const SQRT_2 = Math.SQRT2;
      // center computation from KisGaussCircleMaskGenerator
      const center = (2.5 * (6761.0 * safeFade - 10000.0)) / (SQRT_2 * 6761.0 * safeFade);
      // alphafactor computation
      const alphafactor = 255.0 / (2.0 * erf(center));

      // distfactor computation
      // Note: radiusX is effectiveSrcWidth / 2
      const distfactor = (SQRT_2 * 12500.0) / (6761.0 * safeFade * radiusX);

      // Calculate scaled distance
      const physicalDist = normDist * radiusX;

      // Anti-aliasing logic (Krita KisAntialiasingFadeMaker style)
      // For brushes with significant hardness, we force linear bleed at the edge (1px)
      // to prevent aliasing.
      const aaStart = radiusX - 1.0;

      if (hardness > 0.5 && physicalDist > aaStart) {
        // Inside the 1px edge processing zone
        if (physicalDist > radiusX) {
          // Outside nominal radius: cut off
          return 0;
        }

        // Calculate alpha at aaStart to ensure continuity
        const distAtStart = aaStart * distfactor;
        const valAtStart = alphafactor * (erf(distAtStart + center) - erf(distAtStart - center));
        const baseAlphaAtStart = Math.max(0, Math.min(1, valAtStart / 255.0));

        // Linear interpolation from baseAlphaAtStart down to 0 at radiusX
        // dist goes from aaStart to radiusX -> t goes 0 to 1
        const t = physicalDist - aaStart;
        dabAlpha = flow * baseAlphaAtStart * (1.0 - t);
      } else {
        // Normal Gaussian calculation
        const scaledDist = physicalDist * distfactor;
        const val = alphafactor * (erf(scaledDist + center) - erf(scaledDist - center));
        // Use double precision equivalent in JS (number is double)
        const rawAlpha = Math.max(0, Math.min(1, val / 255.0));

        dabAlpha = flow * rawAlpha;
      }
    } else {
      // 'default': Simple Gaussian exp(-k*t²) (Original PaintBoard implementation)
      // Soft brush: Gaussian falloff from center, extends beyond nominal edge
      // Map hardness to control inner core vs. falloff zone
      const innerRadius = hardness; // 0-1, where falloff begins

      // For soft brushes, extend processing area beyond nominal radius
      const maxExtent = 1.5; // Process up to 1.5x nominal radius for soft brushes
      if (normDist > maxExtent) {
        return 0;
      }

      if (normDist <= innerRadius) {
        // Inside hard core
        dabAlpha = flow;
      } else {
        // Gaussian falloff zone
        const t = (normDist - innerRadius) / (1 - innerRadius);
        const gaussianK = 2.5;
        dabAlpha = flow * Math.exp(-gaussianK * t * t);
      }
    }

    return dabAlpha;
  }

  /**
   * Get the internal canvas (for preview rendering)
   */
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }
}

/**
 * BrushStamper - Generates dabs at regular intervals along the stroke path
 *
 * Key behavior for first stroke issue:
 * - Delays emitting dabs until pen has moved MIN_MOVEMENT_DISTANCE
 * - Prevents pressure buildup at stationary position from causing blobs
 *
 * Pressure smoothing:
 * - Uses exponential moving average (EMA) to smooth pressure transitions
 * - Prevents "stair-step" artifacts at low pressure
 * - Adds adaptive dab density when pressure changes rapidly
 */
export class BrushStamper {
  private accumulatedDistance: number = 0;
  private lastPoint: { x: number; y: number; pressure: number } | null = null;
  private isStrokeStart: boolean = true;
  private strokeStartPoint: { x: number; y: number } | null = null;
  private hasMovedEnough: boolean = false;

  // Smoothed pressure using EMA
  private smoothedPressure: number = 0;

  // Minimum movement in pixels before we start the stroke
  // This prevents pressure buildup at stationary position
  private static readonly MIN_MOVEMENT_DISTANCE = 3;

  // Pressure smoothing factor (0-1): lower = more smoothing
  // 0.35 provides good balance between responsiveness and smoothness
  private static readonly PRESSURE_SMOOTHING = 0.35;

  // Additional dabs when pressure changes rapidly (prevents stepping)
  private static readonly PRESSURE_CHANGE_THRESHOLD = 0.1;

  /**
   * Reset for a new stroke
   */
  beginStroke(): void {
    this.accumulatedDistance = 0;
    this.lastPoint = null;
    this.isStrokeStart = true;
    this.strokeStartPoint = null;
    this.hasMovedEnough = false;
    this.smoothedPressure = 0;
  }

  /**
   * Apply exponential moving average to smooth pressure
   */
  private smoothPressure(rawPressure: number): number {
    if (this.smoothedPressure === 0) {
      // First pressure reading - initialize directly
      this.smoothedPressure = rawPressure;
    } else {
      // EMA: smoothed = alpha * raw + (1-alpha) * previous
      this.smoothedPressure =
        BrushStamper.PRESSURE_SMOOTHING * rawPressure +
        (1 - BrushStamper.PRESSURE_SMOOTHING) * this.smoothedPressure;
    }
    return this.smoothedPressure;
  }

  /**
   * Process a new input point and return dab positions
   * Applies pressure smoothing via EMA to prevent stepping artifacts
   * IMPORTANT: EMA is only applied AFTER the pen has moved enough to prevent "big head" issue
   */
  processPoint(
    x: number,
    y: number,
    pressure: number,
    size: number,
    spacing: number
  ): Array<{ x: number; y: number; pressure: number }> {
    const dabs: Array<{ x: number; y: number; pressure: number }> = [];

    // First point: just record position, don't emit dab yet
    // DON'T apply EMA here - we haven't moved yet
    if (this.isStrokeStart) {
      this.isStrokeStart = false;
      this.strokeStartPoint = { x, y };
      this.lastPoint = { x, y, pressure: 0 }; // Start with 0 pressure
      this.smoothedPressure = 0; // Reset EMA
      // Don't emit first dab - wait for movement
      return dabs;
    }

    if (!this.lastPoint || !this.strokeStartPoint) {
      this.lastPoint = { x, y, pressure: 0 };
      this.strokeStartPoint = { x, y };
      return dabs;
    }

    // Check if we've moved enough from stroke start
    if (!this.hasMovedEnough) {
      const dxFromStart = x - this.strokeStartPoint.x;
      const dyFromStart = y - this.strokeStartPoint.y;
      const distFromStart = Math.sqrt(dxFromStart * dxFromStart + dyFromStart * dyFromStart);

      if (distFromStart < BrushStamper.MIN_MOVEMENT_DISTANCE) {
        // Haven't moved enough yet - DON'T update pressure at all
        // This prevents pressure buildup at stationary position
        // Just update position for distance tracking
        this.lastPoint.x = x;
        this.lastPoint.y = y;
        // DON'T call smoothPressure() - that would accumulate pressure
        return dabs;
      }

      // We've moved enough - NOW initialize EMA with current pressure
      this.hasMovedEnough = true;
      this.smoothedPressure = pressure; // Initialize EMA with current pressure
      this.lastPoint = { x, y, pressure };
      dabs.push({ x, y, pressure });
      return dabs;
    }

    // Apply pressure smoothing only AFTER we've started moving
    const smoothedPressure = this.smoothPressure(pressure);

    // Calculate distance from last point
    const dx = x - this.lastPoint.x;
    const dy = y - this.lastPoint.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Check for rapid pressure change - reduce spacing for smoother transition
    const pressureChange = Math.abs(smoothedPressure - this.lastPoint.pressure);
    let effectiveSpacing = spacing;
    if (pressureChange > BrushStamper.PRESSURE_CHANGE_THRESHOLD) {
      // Reduce spacing when pressure is changing rapidly
      // This adds more dabs during transitions for smoother appearance
      effectiveSpacing = spacing * 0.5;
    }

    // Spacing threshold based on current size (not pressure-scaled to avoid inconsistent spacing)
    const threshold = Math.max(size * effectiveSpacing, 1);

    this.accumulatedDistance += distance;

    // Emit dabs at regular intervals
    while (this.accumulatedDistance >= threshold) {
      const t = 1 - (this.accumulatedDistance - threshold) / distance;
      const dabX = this.lastPoint.x + dx * t;
      const dabY = this.lastPoint.y + dy * t;

      // Use smoothstep interpolation for pressure (smoother than linear)
      const smoothT = t * t * (3 - 2 * t);
      const dabPressure =
        this.lastPoint.pressure + (smoothedPressure - this.lastPoint.pressure) * smoothT;

      dabs.push({ x: dabX, y: dabY, pressure: dabPressure });
      this.accumulatedDistance -= threshold;
    }

    this.lastPoint = { x, y, pressure: smoothedPressure };
    return dabs;
  }

  /**
   * Finish stroke and reset state
   *
   * Note: We don't artificially add fadeout dabs here. Natural pressure decay
   * from the tablet hardware should create proper tapered ends. If the pen is
   * lifted too quickly, we accept a blunt end rather than adding unnatural
   * artificial taper that creates visual discontinuity.
   */
  finishStroke(_brushSize: number): Array<{ x: number; y: number; pressure: number }> {
    this.beginStroke();
    return []; // No artificial fadeout - rely on natural pressure data
  }
}
