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
 *
 * Performance optimization:
 * - Soft brushes (hardness < 95%) use Rust SIMD backend for mask calculation
 * - Persistent buffer avoids frequent getImageData/putImageData calls
 */

import { invoke } from '@tauri-apps/api/core';
import { MaskCache, type MaskCacheParams } from './maskCache';

export type MaskType = 'gaussian' | 'default';

export interface DabParams {
  x: number;
  y: number;
  size: number;
  flow: number; // Per-dab accumulation rate (0-1)
  hardness: number; // Edge hardness (0-1)
  maskType?: MaskType; // Mask type: 'gaussian' (erf-based, default) or 'default' (simple)
  color: string; // Hex color
  dabOpacity?: number; // Krita-style: multiplier for entire dab (preserves gradient)
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

  // Persistent ImageData buffer - avoids getImageData/putImageData per dab
  // This is the key optimization: we keep the buffer in memory during the stroke
  private imageData: ImageData | null = null;
  private bufferData: Uint8ClampedArray | null = null;

  // Mask cache for pre-computed brush masks (Krita-style optimization)
  private maskCache: MaskCache = new MaskCache();

  // Canvas sync throttling - sync every N dabs instead of every dab
  private syncCounter: number = 0;
  private static readonly SYNC_INTERVAL = 4; // Sync every 4 dabs (reduced from 2)

  // Accumulated dirty rect for batched syncing
  private pendingDirtyRect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

  // Reusable ImageData for sync operations - avoids allocation per sync
  private syncImageData: ImageData | null = null;
  private syncImageDataWidth: number = 0;
  private syncImageDataHeight: number = 0;

  // Legacy fields (kept for compatibility)
  private persistentBuffer: Uint8ClampedArray | null = null;
  private useRustPath: boolean = false;

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
   * @param hardness - Brush hardness (0-1), determines if Rust SIMD path is used
   */
  beginStroke(_hardness: number = 1): void {
    this.clear();
    this.active = true;

    // Initialize persistent ImageData buffer for the entire canvas
    // This avoids getImageData/putImageData per dab - major performance win
    this.imageData = this.ctx.createImageData(this.width, this.height);
    this.bufferData = this.imageData.data;

    // DISABLED: Rust SIMD path has too much IPC overhead
    this.useRustPath = false;
    this.persistentBuffer = null;
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
    this.pendingDirtyRect = {
      left: this.width,
      top: this.height,
      right: 0,
      bottom: 0,
    };
    this.syncCounter = 0;
    this.active = false;
    this.imageData = null;
    this.bufferData = null;
    this.persistentBuffer = null;
    this.useRustPath = false;
    // Don't clear syncImageData - it can be reused across strokes
  }

  /**
   * Check if stroke is active
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Expand dirty rect from Rust dirty rect tuple (left, top, width, height)
   */
  private expandDirtyRectFromRust(rect: [number, number, number, number]): void {
    const [left, top, width, height] = rect;
    if (width === 0 || height === 0) return;
    this.dirtyRect.left = Math.min(this.dirtyRect.left, left);
    this.dirtyRect.top = Math.min(this.dirtyRect.top, top);
    this.dirtyRect.right = Math.max(this.dirtyRect.right, left + width);
    this.dirtyRect.bottom = Math.max(this.dirtyRect.bottom, top + height);
  }

  /**
   * Stamp a dab using Rust SIMD backend (for soft brushes)
   * Uses persistent buffer to avoid IPC overhead per dab
   */
  async stampDabRust(params: DabParams): Promise<void> {
    if (!this.persistentBuffer) {
      // Fallback to JS path if buffer not initialized
      this.stampDab(params);
      return;
    }

    const rgb = hexToRgb(params.color);
    const radius = params.size / 2;

    try {
      const [newBuffer, dirtyRect] = await invoke<[number[], [number, number, number, number]]>(
        'stamp_soft_dab',
        {
          buffer: Array.from(this.persistentBuffer),
          bufferWidth: this.width,
          bufferHeight: this.height,
          cx: params.x,
          cy: params.y,
          radius: radius,
          hardness: params.hardness,
          roundness: params.roundness ?? 1,
          color: [rgb.r, rgb.g, rgb.b] as [number, number, number],
          flow: params.flow,
          dabOpacity: params.dabOpacity ?? 1,
        }
      );

      // Update persistent buffer
      this.persistentBuffer = new Uint8ClampedArray(newBuffer);
      this.expandDirtyRectFromRust(dirtyRect);
    } catch (error) {
      console.error('Rust dab stamp failed, falling back to JS:', error);
      this.stampDab(params);
    }
  }

  /**
   * Check if using Rust SIMD path
   */
  isUsingRustPath(): boolean {
    return this.useRustPath;
  }

  /**
   * Sync persistent buffer to canvas (call before endStroke when using Rust path)
   */
  private syncBufferToCanvas(): void {
    if (!this.persistentBuffer) return;

    // Create ImageData from the persistent buffer
    const imageData = this.ctx.createImageData(this.width, this.height);
    imageData.data.set(this.persistentBuffer);
    this.ctx.putImageData(imageData, 0, 0);
  }

  /**
   * Stamp an elliptical dab onto the buffer with anti-aliasing
   * Uses cached mask for performance (Krita-style optimization)
   * Hard brushes (hardness >= 0.99) use a fast path that skips mask caching
   *
   * Krita-style unified formula: dabAlpha = maskShape * flow * dabOpacity
   * - maskShape: pure geometric gradient (0-1), center always = 1.0
   * - flow: per-dab accumulation rate
   * - dabOpacity: per-dab transparency multiplier
   */
  stampDab(params: DabParams): void {
    const {
      x,
      y,
      size,
      flow,
      hardness,
      maskType = 'gaussian',
      color,
      dabOpacity = 1.0,
      roundness = 1,
      angle = 0,
    } = params;

    if (size < 1) return;
    if (!this.bufferData) return;

    const rgb = hexToRgb(color);
    let dabDirtyRect: Rect;

    // Fast path for hard brushes - skip mask caching entirely
    if (hardness >= 0.99) {
      dabDirtyRect = this.maskCache.stampHardBrush(
        this.bufferData,
        this.width,
        this.height,
        x,
        y,
        size / 2, // radius
        roundness,
        angle,
        flow,
        dabOpacity,
        rgb.r,
        rgb.g,
        rgb.b
      );
    } else {
      // Soft brushes use cached mask
      const cacheParams: MaskCacheParams = {
        size,
        hardness,
        roundness,
        angle,
        maskType,
      };

      // Only regenerate mask when parameters change (major performance win)
      if (this.maskCache.needsUpdate(cacheParams)) {
        this.maskCache.generateMask(cacheParams);
      }

      // Use cached mask for fast blending
      dabDirtyRect = this.maskCache.stampToBuffer(
        this.bufferData,
        this.width,
        this.height,
        x,
        y,
        flow,
        dabOpacity,
        rgb.r,
        rgb.g,
        rgb.b
      );
    }

    // Expand main dirty rect
    if (dabDirtyRect.right > dabDirtyRect.left && dabDirtyRect.bottom > dabDirtyRect.top) {
      this.dirtyRect.left = Math.min(this.dirtyRect.left, dabDirtyRect.left);
      this.dirtyRect.top = Math.min(this.dirtyRect.top, dabDirtyRect.top);
      this.dirtyRect.right = Math.max(this.dirtyRect.right, dabDirtyRect.right);
      this.dirtyRect.bottom = Math.max(this.dirtyRect.bottom, dabDirtyRect.bottom);

      // Accumulate pending dirty rect for batched sync
      this.pendingDirtyRect.left = Math.min(this.pendingDirtyRect.left, dabDirtyRect.left);
      this.pendingDirtyRect.top = Math.min(this.pendingDirtyRect.top, dabDirtyRect.top);
      this.pendingDirtyRect.right = Math.max(this.pendingDirtyRect.right, dabDirtyRect.right);
      this.pendingDirtyRect.bottom = Math.max(this.pendingDirtyRect.bottom, dabDirtyRect.bottom);
    }

    // Throttled canvas sync - sync every N dabs instead of every dab
    this.syncCounter++;
    if (this.syncCounter >= StrokeAccumulator.SYNC_INTERVAL) {
      this.syncPendingToCanvas();
      this.syncCounter = 0;
    }
  }

  /**
   * Sync pending dirty region to canvas for preview
   */
  private syncPendingToCanvas(): void {
    if (!this.bufferData) return;

    const left = Math.max(0, this.pendingDirtyRect.left);
    const top = Math.max(0, this.pendingDirtyRect.top);
    const right = Math.min(this.width, this.pendingDirtyRect.right);
    const bottom = Math.min(this.height, this.pendingDirtyRect.bottom);

    const width = right - left;
    const height = bottom - top;

    if (width <= 0 || height <= 0) return;

    // Reuse ImageData if dimensions match, otherwise allocate new one
    if (
      !this.syncImageData ||
      this.syncImageDataWidth !== width ||
      this.syncImageDataHeight !== height
    ) {
      this.syncImageData = new ImageData(width, height);
      this.syncImageDataWidth = width;
      this.syncImageDataHeight = height;
    }

    // Extract region from persistent buffer and sync to canvas
    const regionData = this.syncImageData;
    for (let py = 0; py < height; py++) {
      const srcStart = ((top + py) * this.width + left) * 4;
      const dstStart = py * width * 4;
      regionData.data.set(this.bufferData.subarray(srcStart, srcStart + width * 4), dstStart);
    }
    this.ctx.putImageData(regionData, left, top);

    // Reset pending dirty rect
    this.pendingDirtyRect = {
      left: this.width,
      top: this.height,
      right: 0,
      bottom: 0,
    };
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

    // Flush any pending canvas sync before compositing
    this.syncPendingToCanvas();

    // Sync persistent buffer to canvas (for Rust path)
    if (this.useRustPath) {
      this.syncBufferToCanvas();
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
