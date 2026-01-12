/**
 * StrokeBuffer - Frontend implementation of the three-level rendering pipeline
 *
 * This implements the Flow/Opacity separation mechanism:
 * - Flow: Per-dab opacity, accumulates within a stroke
 * - Opacity: Ceiling for the entire stroke, applied when compositing to layer
 *
 * Architecture:
 * 1. Dab Level: Individual brush stamps with Flow-controlled alpha
 * 2. Stroke Buffer: Accumulates dabs within a single stroke
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
    r: parseInt(result[1] ?? '0', 16),
    g: parseInt(result[2] ?? '0', 16),
    b: parseInt(result[3] ?? '0', 16),
  };
}

/**
 * StrokeBuffer class for accumulating dabs within a single stroke
 */
export class StrokeBuffer {
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
      throw new Error('Failed to create 2D context for StrokeBuffer');
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
   * Stamp a circular dab onto the buffer with opacity ceiling support
   */
  stampDab(params: DabParams): void {
    const { x, y, size, flow, hardness, color, opacityCeiling } = params;
    const radius = size / 2;

    if (radius < 0.5) return;

    this.expandDirtyRect(x, y, radius);

    const rgb = hexToRgb(color);

    // Calculate bounding box for pixel operations
    const left = Math.max(0, Math.floor(x - radius));
    const top = Math.max(0, Math.floor(y - radius));
    const right = Math.min(this.width, Math.ceil(x + radius));
    const bottom = Math.min(this.height, Math.ceil(y + radius));
    const rectWidth = right - left;
    const rectHeight = bottom - top;

    if (rectWidth <= 0 || rectHeight <= 0) return;

    // Get current buffer data for the dab region
    const bufferData = this.ctx.getImageData(left, top, rectWidth, rectHeight);
    const maxAlpha = opacityCeiling !== undefined ? Math.round(opacityCeiling * 255) : 255;

    // Process each pixel in the dab region
    for (let py = 0; py < rectHeight; py++) {
      for (let px = 0; px < rectWidth; px++) {
        const worldX = left + px;
        const worldY = top + py;

        // Calculate distance from dab center
        const dx = worldX + 0.5 - x;
        const dy = worldY + 0.5 - y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > radius) continue;

        // Calculate dab alpha based on hardness
        let dabAlpha: number;
        if (hardness >= 0.99) {
          dabAlpha = flow;
        } else {
          const innerRadius = radius * hardness;
          if (dist <= innerRadius) {
            dabAlpha = flow;
          } else {
            // Linear falloff from inner to outer radius
            const t = (dist - innerRadius) / (radius - innerRadius);
            dabAlpha = flow * (1 - t);
          }
        }

        if (dabAlpha <= 0) continue;

        const idx = (py * rectWidth + px) * 4;

        // Get current buffer pixel
        const dstR = bufferData.data[idx] ?? 0;
        const dstG = bufferData.data[idx + 1] ?? 0;
        const dstB = bufferData.data[idx + 2] ?? 0;
        const dstA = (bufferData.data[idx + 3] ?? 0) / 255;

        // Porter-Duff "over" compositing
        const srcA = dabAlpha;
        const outA = srcA + dstA * (1 - srcA);

        if (outA > 0) {
          const outR = (rgb.r * srcA + dstR * dstA * (1 - srcA)) / outA;
          const outG = (rgb.g * srcA + dstG * dstA * (1 - srcA)) / outA;
          const outB = (rgb.b * srcA + dstB * dstA * (1 - srcA)) / outA;

          // Apply opacity ceiling - clamp alpha to maxAlpha
          const clampedAlpha = Math.min(Math.round(outA * 255), maxAlpha);

          bufferData.data[idx] = Math.round(outR);
          bufferData.data[idx + 1] = Math.round(outG);
          bufferData.data[idx + 2] = Math.round(outB);
          bufferData.data[idx + 3] = clampedAlpha;
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
 */
export class BrushStamper {
  private accumulatedDistance: number = 0;
  private lastPoint: { x: number; y: number; pressure: number } | null = null;
  private isStrokeStart: boolean = true;

  /**
   * Reset for a new stroke
   */
  beginStroke(): void {
    this.accumulatedDistance = 0;
    this.lastPoint = null;
    this.isStrokeStart = true;
  }

  /**
   * Process a new input point and return dab positions
   * Note: Pressure fade-in is now handled in useBrushRenderer before calling this
   */
  processPoint(
    x: number,
    y: number,
    pressure: number,
    size: number,
    spacing: number
  ): Array<{ x: number; y: number; pressure: number }> {
    const dabs: Array<{ x: number; y: number; pressure: number }> = [];

    // First point: emit initial dab
    if (this.isStrokeStart) {
      this.isStrokeStart = false;
      this.lastPoint = { x, y, pressure };
      dabs.push({ x, y, pressure });
      return dabs;
    }

    if (!this.lastPoint) {
      this.lastPoint = { x, y, pressure };
      return dabs;
    }

    // Calculate distance from last point
    const dx = x - this.lastPoint.x;
    const dy = y - this.lastPoint.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Spacing threshold
    const threshold = Math.max(size * spacing, 1);

    this.accumulatedDistance += distance;

    // Emit dabs at regular intervals
    while (this.accumulatedDistance >= threshold) {
      const t = 1 - (this.accumulatedDistance - threshold) / distance;
      const dabX = this.lastPoint.x + dx * t;
      const dabY = this.lastPoint.y + dy * t;
      const dabPressure = this.lastPoint.pressure + (pressure - this.lastPoint.pressure) * t;

      dabs.push({ x: dabX, y: dabY, pressure: dabPressure });
      this.accumulatedDistance -= threshold;
    }

    this.lastPoint = { x, y, pressure };
    return dabs;
  }

  /**
   * Finish stroke
   */
  finishStroke(): void {
    this.beginStroke();
  }
}
