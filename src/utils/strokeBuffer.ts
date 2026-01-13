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

export interface DabParams {
  x: number;
  y: number;
  size: number;
  flow: number; // Per-dab opacity (0-1)
  hardness: number; // Edge hardness (0-1)
  color: string; // Hex color
  opacityCeiling?: number; // Optional opacity ceiling (0-1), if set, limits max alpha
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
    const { x, y, size, flow, hardness, color, opacityCeiling, roundness = 1, angle = 0 } = params;
    const radiusX = size / 2;
    const radiusY = radiusX * roundness; // Scale Y radius for roundness

    if (radiusX < 0.5) return;

    // Use the larger radius for calculations
    const maxRadius = Math.max(radiusX, radiusY);

    // For soft brushes, extend beyond nominal radius (1.5x) for smooth falloff
    const extentMultiplier = hardness >= 0.99 ? 1.0 : 1.5;
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

    // Anti-aliasing: smooth transition over ~1px at the edge
    const aaWidth = Math.min(1.0, radiusX * 0.5); // AA width, max 1px, smaller for tiny brushes
    const maxAlphaFloat = opacityCeiling !== undefined ? opacityCeiling : 1.0;

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

        // Calculate dab alpha based on hardness
        // Soft brushes use Gaussian falloff that extends beyond nominal edge
        let dabAlpha: number;

        if (hardness >= 0.99) {
          // Hard brush: full alpha inside, AA at edge
          if (normDist > 1 + aaWidth / radiusX) {
            continue; // Outside AA zone
          } else if (normDist > 1) {
            // Anti-aliasing zone
            const edgeNormDist = normDist - 1;
            const coverage = Math.max(0, 1 - edgeNormDist / (aaWidth / radiusX));
            dabAlpha = flow * coverage;
          } else {
            dabAlpha = flow;
          }
        } else {
          // Soft brush: Gaussian falloff from center, extends beyond nominal edge
          // Map hardness to control inner core vs. falloff zone
          const innerRadius = hardness; // 0-1, where falloff begins

          // For soft brushes, extend processing area beyond nominal radius
          // Gaussian at t=2 gives exp(-2.5*4) ≈ 0.00005, effectively invisible
          const maxExtent = 1.5; // Process up to 1.5x nominal radius for soft brushes
          if (normDist > maxExtent) {
            continue;
          }

          if (normDist <= innerRadius) {
            // Inside hard core
            dabAlpha = flow;
          } else {
            // Gaussian falloff zone - continues smoothly beyond edge
            // t goes from 0 (at inner edge) and can exceed 1 for smooth falloff
            const t = (normDist - innerRadius) / (1 - innerRadius);

            // Use TRUE Gaussian falloff: exp(-k * t²)
            // k = 2.5 gives a very soft airbrush effect similar to Photoshop
            const gaussianK = 2.5;
            dabAlpha = flow * Math.exp(-gaussianK * t * t);
          }
        }

        if (dabAlpha <= 0.001) continue;

        const idx = (py * rectWidth + px) * 4;

        // Get current buffer pixel
        const dstR = bufferData.data[idx] ?? 0;
        const dstG = bufferData.data[idx + 1] ?? 0;
        const dstB = bufferData.data[idx + 2] ?? 0;
        const dstA = (bufferData.data[idx + 3] ?? 0) / 255;

        // If destination already at opacity ceiling, skip this pixel
        // This prevents color artifacts from alpha clamping
        if (opacityCeiling !== undefined && dstA >= opacityCeiling - 0.001) {
          continue;
        }

        // Porter-Duff "over" compositing
        const srcA = dabAlpha;
        let outA = srcA + dstA * (1 - srcA);

        // Apply opacity ceiling BEFORE color calculation to avoid brightening
        if (outA > maxAlphaFloat) {
          outA = maxAlphaFloat;
        }

        if (outA > 0) {
          // Recalculate effective source contribution after clamping
          // effectiveSrcA is how much of the source actually contributes
          const effectiveSrcA = outA - dstA * (1 - srcA);

          let outR: number, outG: number, outB: number;

          if (effectiveSrcA > 0.001 && outA > 0.001) {
            outR = (rgb.r * effectiveSrcA + dstR * dstA * (1 - srcA)) / outA;
            outG = (rgb.g * effectiveSrcA + dstG * dstA * (1 - srcA)) / outA;
            outB = (rgb.b * effectiveSrcA + dstB * dstA * (1 - srcA)) / outA;
          } else {
            // No effective contribution, keep destination color
            outR = dstR;
            outG = dstG;
            outB = dstB;
          }

          bufferData.data[idx] = Math.round(Math.min(255, Math.max(0, outR)));
          bufferData.data[idx + 1] = Math.round(Math.min(255, Math.max(0, outG)));
          bufferData.data[idx + 2] = Math.round(Math.min(255, Math.max(0, outB)));

          // Apply subtle ordered dithering to alpha to reduce banding at low values
          // This breaks up the "stair-step" effect visible at low opacity
          const ditherPattern = ((worldX + worldY) % 2) * 0.5 - 0.25; // -0.25 or +0.25
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

    // Apply opacity ceiling and composite
    const opacityCeiling = Math.round(opacity * 255);

    for (let i = 0; i < strokeData.data.length; i += 4) {
      const strokeAlpha = strokeData.data[i + 3] ?? 0;

      if (strokeAlpha === 0) continue;

      // Apply opacity ceiling
      const clampedAlpha = Math.min(strokeAlpha, opacityCeiling);
      const srcAlpha = clampedAlpha / 255;

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
