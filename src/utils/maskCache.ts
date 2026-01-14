/**
 * MaskCache - Pre-computed brush mask cache for performance optimization
 *
 * This implements Krita-style dab caching: the brush mask is computed once
 * when parameters change, then reused for all subsequent dabs with the same
 * settings. This reduces per-dab computation from ~50 ops/pixel to ~10 ops/pixel.
 *
 * Key insight: For soft brushes, the mask shape only depends on:
 * - size, hardness, roundness, angle, maskType
 * If these don't change, the mask can be reused.
 */

import type { Rect } from './strokeBuffer';

export type MaskType = 'gaussian' | 'default';

export interface MaskCacheParams {
  size: number; // Brush diameter in pixels
  hardness: number; // 0-1 (0 = soft, 1 = hard)
  roundness: number; // 0-1 (1 = circle, <1 = ellipse)
  angle: number; // Rotation in degrees
  maskType: MaskType;
}

// ============================================================================
// erf Lookup Table (copied from strokeBuffer.ts for independence)
// ============================================================================

const ERF_LUT_SIZE = 1024;
const ERF_LUT_MAX = 4.0;
const ERF_LUT_SCALE = ERF_LUT_SIZE / ERF_LUT_MAX;
const erfLUT: Float32Array = new Float32Array(ERF_LUT_SIZE + 1);

// Initialize LUT at module load time
(function initErfLUT() {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  for (let i = 0; i <= ERF_LUT_SIZE; i++) {
    const x = (i / ERF_LUT_SIZE) * ERF_LUT_MAX;
    const t = 1.0 / (1.0 + p * x);
    const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    erfLUT[i] = y;
  }
})();

function erfFast(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  if (ax >= ERF_LUT_MAX) return sign;
  const idx = ax * ERF_LUT_SCALE;
  const i = idx | 0;
  const frac = idx - i;
  const y = erfLUT[i]! + frac * (erfLUT[i + 1]! - erfLUT[i]!);
  return sign * y;
}

/**
 * MaskCache class for pre-computed brush masks
 */
export class MaskCache {
  // Cached mask data (normalized 0-1 values)
  private mask: Float32Array | null = null;
  private maskWidth: number = 0;
  private maskHeight: number = 0;

  // Cached parameters for invalidation check
  private cachedParams: MaskCacheParams | null = null;

  // Pre-computed offset from mask center
  private centerX: number = 0;
  private centerY: number = 0;

  /**
   * Alpha Darken blend a single pixel
   * Shared by stampToBuffer and stampHardBrush to avoid duplication
   */
  private blendPixel(
    buffer: Uint8ClampedArray,
    idx: number,
    srcAlpha: number,
    dabOpacity: number,
    r: number,
    g: number,
    b: number
  ): void {
    const dstR = buffer[idx]!;
    const dstG = buffer[idx + 1]!;
    const dstB = buffer[idx + 2]!;
    const dstA = buffer[idx + 3]! / 255;

    // Alpha Darken: lerp toward ceiling
    const outA = dstA >= dabOpacity - 0.001 ? dstA : dstA + (dabOpacity - dstA) * srcAlpha;

    if (outA > 0.001) {
      // Color blend: lerp if existing, else use source directly
      const hasColor = dstA > 0.001;
      buffer[idx] = (hasColor ? dstR + (r - dstR) * srcAlpha : r) + 0.5;
      buffer[idx + 1] = (hasColor ? dstG + (g - dstG) * srcAlpha : g) + 0.5;
      buffer[idx + 2] = (hasColor ? dstB + (b - dstB) * srcAlpha : b) + 0.5;
      buffer[idx + 3] = outA * 255 + 0.5;
    }
  }

  /**
   * Check if the mask needs to be regenerated
   */
  needsUpdate(params: MaskCacheParams): boolean {
    if (!this.cachedParams || !this.mask) return true;

    // Size tolerance: allow small variations to improve cache hit rate
    // Krita uses precision levels; we use a simpler percentage-based approach
    const sizeTolerance = this.cachedParams.size * 0.02; // 2% tolerance

    return (
      Math.abs(params.size - this.cachedParams.size) > sizeTolerance ||
      Math.abs(params.hardness - this.cachedParams.hardness) > 0.01 ||
      Math.abs(params.roundness - this.cachedParams.roundness) > 0.01 ||
      Math.abs(params.angle - this.cachedParams.angle) > 0.5 ||
      params.maskType !== this.cachedParams.maskType
    );
  }

  /**
   * Generate and cache the brush mask
   * This is the expensive operation - only called when parameters change
   */
  generateMask(params: MaskCacheParams): void {
    const { size, hardness, roundness, angle, maskType } = params;

    const radiusX = size / 2;
    const radiusY = radiusX * roundness;
    const maxRadius = Math.max(radiusX, radiusY);

    // Calculate extent multiplier based on hardness and mask type
    const fade = maskType === 'gaussian' ? (1.0 - hardness) * 2.0 : 0;
    let extentMultiplier: number;
    if (hardness >= 0.99) {
      extentMultiplier = 1.0;
    } else if (maskType === 'gaussian') {
      extentMultiplier = 1.0 + fade;
    } else {
      extentMultiplier = 1.5;
    }

    const effectiveRadius = maxRadius * extentMultiplier + 1;

    // Mask dimensions (always odd for centered pixel)
    this.maskWidth = Math.ceil(effectiveRadius * 2) | 1;
    this.maskHeight = Math.ceil(effectiveRadius * 2) | 1;
    this.centerX = this.maskWidth / 2;
    this.centerY = this.maskHeight / 2;

    // Allocate mask buffer
    this.mask = new Float32Array(this.maskWidth * this.maskHeight);

    // Pre-calculate rotation
    const angleRad = (angle * Math.PI) / 180;
    const cosA = Math.cos(-angleRad);
    const sinA = Math.sin(-angleRad);

    // Pre-calculate Gaussian parameters (only for gaussian mask type)
    const safeFade = Math.max(1e-6, Math.min(2.0, fade));
    const SQRT_2 = Math.SQRT2;
    const center = (2.5 * (6761.0 * safeFade - 10000.0)) / (SQRT_2 * 6761.0 * safeFade);
    const alphafactor = 255.0 / (2.0 * erfFast(center));
    const distfactor = (SQRT_2 * 12500.0) / (6761.0 * safeFade * radiusX);

    // Generate mask
    for (let py = 0; py < this.maskHeight; py++) {
      const dy = py + 0.5 - this.centerY;

      for (let px = 0; px < this.maskWidth; px++) {
        const dx = px + 0.5 - this.centerX;

        // Apply inverse rotation
        const localX = dx * cosA - dy * sinA;
        const localY = dx * sinA + dy * cosA;

        // Normalized distance for ellipse
        const normX = localX / radiusX;
        const normY = localY / radiusY;
        const normDist = Math.sqrt(normX * normX + normY * normY);

        // Calculate mask shape
        let maskValue: number;

        if (hardness >= 0.99) {
          // Hard brush with 1px anti-aliased edge
          const distFromEdge = normDist * radiusX - radiusX;
          if (distFromEdge > 1.0) {
            maskValue = 0;
          } else if (distFromEdge > 0.0) {
            maskValue = 1.0 - distFromEdge;
          } else {
            maskValue = 1.0;
          }
        } else if (maskType === 'gaussian') {
          // Krita-style Gaussian (erf-based) mask
          const physicalDist = normDist * radiusX;
          const aaStart = radiusX - 1.0;

          if (hardness > 0.5 && physicalDist > aaStart) {
            if (physicalDist > radiusX) {
              maskValue = 0;
            } else {
              const distAtStart = aaStart * distfactor;
              const valAtStart =
                alphafactor * (erfFast(distAtStart + center) - erfFast(distAtStart - center));
              const baseAlphaAtStart = Math.max(0, Math.min(1, valAtStart / 255.0));
              maskValue = baseAlphaAtStart * (1.0 - (physicalDist - aaStart));
            }
          } else {
            const scaledDist = physicalDist * distfactor;
            const val = alphafactor * (erfFast(scaledDist + center) - erfFast(scaledDist - center));
            maskValue = Math.max(0, Math.min(1, val / 255.0));
          }
        } else {
          // Simple Gaussian exp(-k*t²)
          const maxExtent = 1.5;
          if (normDist > maxExtent) {
            maskValue = 0;
          } else if (normDist <= hardness) {
            maskValue = 1.0;
          } else {
            const t = (normDist - hardness) / (1 - hardness);
            maskValue = Math.exp(-2.5 * t * t);
          }
        }

        this.mask[py * this.maskWidth + px] = maskValue;
      }
    }

    // Store cached parameters
    this.cachedParams = { ...params };
  }

  /**
   * Stamp the cached mask to a buffer using Alpha Darken blending
   * This is the fast path - only does simple blending, no mask calculation
   *
   * @returns The dirty rectangle that was modified
   */
  stampToBuffer(
    buffer: Uint8ClampedArray,
    bufferWidth: number,
    bufferHeight: number,
    cx: number,
    cy: number,
    flow: number,
    dabOpacity: number,
    r: number,
    g: number,
    b: number
  ): Rect {
    if (!this.mask) {
      return { left: 0, top: 0, right: 0, bottom: 0 };
    }

    // Calculate buffer position (top-left of mask in buffer coordinates)
    const halfWidth = this.maskWidth / 2;
    const halfHeight = this.maskHeight / 2;
    const bufferLeft = Math.round(cx - halfWidth);
    const bufferTop = Math.round(cy - halfHeight);

    // Clipping
    const startX = Math.max(0, -bufferLeft);
    const startY = Math.max(0, -bufferTop);
    const endX = Math.min(this.maskWidth, bufferWidth - bufferLeft);
    const endY = Math.min(this.maskHeight, bufferHeight - bufferTop);

    if (startX >= endX || startY >= endY) {
      return { left: 0, top: 0, right: 0, bottom: 0 };
    }

    // Dirty rect in buffer coordinates
    const dirtyLeft = bufferLeft + startX;
    const dirtyTop = bufferTop + startY;
    const dirtyRight = bufferLeft + endX;
    const dirtyBottom = bufferTop + endY;

    // Fast blending loop
    for (let my = startY; my < endY; my++) {
      const bufferRowStart = (bufferTop + my) * bufferWidth;
      const maskRowStart = my * this.maskWidth;

      for (let mx = startX; mx < endX; mx++) {
        const maskValue = this.mask[maskRowStart + mx]!;
        if (maskValue < 0.001) continue;

        const srcAlpha = maskValue * flow;
        const idx = (bufferRowStart + bufferLeft + mx) * 4;
        this.blendPixel(buffer, idx, srcAlpha, dabOpacity, r, g, b);
      }
    }

    return {
      left: dirtyLeft,
      top: dirtyTop,
      right: dirtyRight,
      bottom: dirtyBottom,
    };
  }

  /**
   * Fast path for hard brushes (hardness >= 0.99)
   * Skips mask cache entirely - directly calculates circle with 1px AA edge
   * This is 3-5x faster for hard brushes because:
   * - No mask array access
   * - No mask generation
   * - Simple distance calculation instead of erf
   */
  stampHardBrush(
    buffer: Uint8ClampedArray,
    bufferWidth: number,
    bufferHeight: number,
    cx: number,
    cy: number,
    radius: number,
    roundness: number,
    angle: number,
    flow: number,
    dabOpacity: number,
    r: number,
    g: number,
    b: number
  ): Rect {
    const radiusX = radius;
    const radiusY = radius * roundness;

    // Bounding box with 1px padding for AA edge
    const extent = Math.max(radiusX, radiusY) + 1;
    const left = Math.floor(cx - extent);
    const top = Math.floor(cy - extent);
    const right = Math.ceil(cx + extent);
    const bottom = Math.ceil(cy + extent);

    // Clipping
    const startX = Math.max(0, left);
    const startY = Math.max(0, top);
    const endX = Math.min(bufferWidth, right);
    const endY = Math.min(bufferHeight, bottom);

    if (startX >= endX || startY >= endY) {
      return { left: 0, top: 0, right: 0, bottom: 0 };
    }

    // Pre-calculate rotation
    const angleRad = (angle * Math.PI) / 180;
    const cosA = Math.cos(-angleRad);
    const sinA = Math.sin(-angleRad);

    // Inverse radius squared for fast distance check
    const invRx2 = 1 / (radiusX * radiusX);
    const invRy2 = 1 / (radiusY * radiusY);

    for (let py = startY; py < endY; py++) {
      const dy = py + 0.5 - cy;
      const rowStart = py * bufferWidth;

      for (let px = startX; px < endX; px++) {
        const dx = px + 0.5 - cx;

        // Apply inverse rotation for ellipse
        const localX = dx * cosA - dy * sinA;
        const localY = dx * sinA + dy * cosA;

        // Normalized distance (ellipse equation: (x/rx)² + (y/ry)² = 1)
        const normDistSq = localX * localX * invRx2 + localY * localY * invRy2;

        // Skip if clearly outside ellipse (with 2px margin for AA)
        // Use physical distance for AA, not normalized distance
        const normDist = Math.sqrt(normDistSq);

        // Physical distance from center along the ellipse normal
        const physicalDist = normDist * radiusX; // Approximate for circular brush
        const edgeDist = radiusX; // Edge is at radius

        // Calculate mask value: hard inside, 1px AA at edge
        let maskValue: number;
        if (physicalDist <= edgeDist - 0.5) {
          // Fully inside
          maskValue = 1.0;
        } else if (physicalDist >= edgeDist + 0.5) {
          // Fully outside
          maskValue = 0;
        } else {
          // Within 1px AA band: linear falloff
          maskValue = 0.5 - (physicalDist - edgeDist);
        }

        if (maskValue < 0.001) continue;

        const srcAlpha = maskValue * flow;
        const idx = (rowStart + px) * 4;
        this.blendPixel(buffer, idx, srcAlpha, dabOpacity, r, g, b);
      }
    }

    return {
      left: startX,
      top: startY,
      right: endX,
      bottom: endY,
    };
  }

  /**
   * Get mask dimensions
   */
  getDimensions(): { width: number; height: number } {
    return { width: this.maskWidth, height: this.maskHeight };
  }

  /**
   * Clear the cache
   */
  clear(): void {
    this.mask = null;
    this.cachedParams = null;
    this.maskWidth = 0;
    this.maskHeight = 0;
  }
}
