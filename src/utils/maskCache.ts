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
import type { TextureSettings } from '@/components/BrushPanel/types';
import type { PatternData } from './patternManager';
import { calculateTextureInfluence, sampleNoiseValue } from './textureRendering';
import type { DualBlendMode } from '@/stores/tool';

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

export const ERF_LUT_SIZE = 1024;
export const ERF_LUT_MAX = 4.0;
export const erfLUT: Float32Array = new Float32Array(ERF_LUT_SIZE + 1);

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

/**
 * MaskCache class for pre-computed brush masks
 */
export class MaskCache {
  private static readonly HARD_EDGE_AA_WIDTH = 1.2;
  private static readonly SOFT_MAX_EXTENT = 1.8;
  private static readonly DEFAULT_SOFT_EXPONENT = 2.5;
  private static readonly DEFAULT_FEATHER_WIDTH = 0.25;
  private static readonly GAUSSIAN_SOFT_EXPONENT = 2.3;
  private static readonly GAUSSIAN_FEATHER_WIDTH = 0.3;

  // Cached mask data (normalized 0-1 values)
  private mask: Float32Array | null = null;
  private maskWidth: number = 0;
  private maskHeight: number = 0;

  // Cached parameters for invalidation check
  private cachedParams: MaskCacheParams | null = null;

  // Pre-computed offset from mask center
  private centerX: number = 0;
  private centerY: number = 0;

  getMaskWidth(): number {
    return this.maskWidth;
  }

  getMaskHeight(): number {
    return this.maskHeight;
  }

  /**
   * Calculate hard edge anti-aliasing using Inner Mode (Krita-style)
   * AA band is at [radius-aaWidth, radius], where radius is the absolute boundary.
   * Slightly wider than 1px to better match PS hard-round softness.
   */
  private static calcHardEdgeAA(physicalDist: number, radius: number): number {
    const aaWidth = MaskCache.HARD_EDGE_AA_WIDTH;
    const aaStart = radius - aaWidth;
    if (physicalDist <= aaStart) return 1.0;
    if (physicalDist >= radius) return 0;
    return 1.0 - (physicalDist - aaStart) / aaWidth;
  }

  private static clamp01(v: number): number {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    return v;
  }

  private static smoothStep(edge0: number, edge1: number, x: number): number {
    if (edge1 <= edge0) return x < edge0 ? 0 : 1;
    const t = MaskCache.clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3.0 - 2.0 * t);
  }

  /**
   * PS-like soft round profile:
   * - Keeps hardness-controlled solid core
   * - Uses exponential falloff outside core
   * - Adds terminal feather near max extent to avoid hard clipping
   */
  private static calcSoftRoundMask(
    normDist: number,
    hardness: number,
    exponent: number,
    maxExtent: number,
    featherWidth: number
  ): number {
    if (normDist > maxExtent) return 0;
    if (normDist <= hardness) return 1;

    const denom = Math.max(1e-6, 1 - hardness);
    const t = (normDist - hardness) / denom;
    let alpha = Math.exp(-exponent * t * t);

    if (featherWidth > 1e-6) {
      const featherStart = Math.max(1.0, maxExtent - featherWidth);
      if (normDist > featherStart) {
        const fadeOut = 1.0 - MaskCache.smoothStep(featherStart, maxExtent, normDist);
        alpha *= fadeOut;
      }
    }

    return MaskCache.clamp01(alpha);
  }

  private static sampleBilinear(
    data: Float32Array,
    width: number,
    height: number,
    x: number,
    y: number
  ): number {
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;

    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const fx = x - x0;
    const fy = y - y0;

    const idx00 = y0 * width + x0;
    const v00 = data[idx00] ?? 0;
    const v10 = x1 < width ? (data[idx00 + 1] ?? 0) : 0;
    const v01 = y1 < height ? (data[idx00 + width] ?? 0) : 0;
    const v11 = x1 < width && y1 < height ? (data[idx00 + width + 1] ?? 0) : 0;

    const v0 = v00 + (v10 - v00) * fx;
    const v1 = v01 + (v11 - v01) * fx;
    return v0 + (v1 - v0) * fy;
  }

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

  private static blendOverlay(base: number, blend: number): number {
    const b = Math.max(0, Math.min(1, base));
    const s = Math.max(0, Math.min(1, blend));
    if (b < 0.5) return 2.0 * b * s;
    return 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
  }

  /**
   * Blend Function for Dual Brush (Photoshop Dual Brush panel compatible)
   * Only 8 modes are supported: Multiply, Darken, Overlay,
   * Color Dodge, Color Burn, Linear Burn, Hard Mix, Linear Height
   */
  private static blendDual(primary: number, secondary: number, mode: DualBlendMode): number {
    const s = Math.max(0, Math.min(1, secondary));
    const p = Math.max(0, Math.min(1, primary));

    switch (mode) {
      case 'multiply':
        return p * s;
      case 'darken':
        return Math.min(p, s);
      case 'overlay':
        return MaskCache.blendOverlay(p, s);
      case 'colorDodge':
        return s >= 1.0 ? 1.0 : Math.min(1.0, p / (1.0 - s));
      case 'colorBurn':
        return s <= 0 ? 0 : Math.max(0, 1.0 - (1.0 - p) / s);
      case 'linearBurn':
        return Math.max(0, p + s - 1.0);
      case 'hardMix':
        // Hard Mix: result is 0 or 1 based on linear light threshold
        return p + s >= 1.0 ? 1.0 : 0.0;
      case 'linearHeight':
        // Linear Height: similar to height/emboss effect
        // Treats secondary as height map, scales primary
        return p * (0.5 + s * 0.5);
      default:
        return p * s;
    }
  }

  private static applyNoiseOverlayToMaskAlpha(
    maskAlpha: number,
    canvasX: number,
    canvasY: number,
    noiseStrength: number,
    noiseSettings?: TextureSettings | null,
    noisePattern?: PatternData
  ): number {
    if (!noiseSettings || !noisePattern) return maskAlpha;
    if (noiseStrength <= 0.001) return maskAlpha;

    // PS-like: only meaningful on soft edge (0<alpha<1)
    if (maskAlpha <= 0.001 || maskAlpha >= 0.999) return maskAlpha;

    const noiseVal = sampleNoiseValue(canvasX, canvasY, noiseSettings, noisePattern);
    const over = MaskCache.blendOverlay(maskAlpha, noiseVal);
    return maskAlpha + (over - maskAlpha) * noiseStrength;
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
    const useEllipticalDistance = Math.abs(roundness - 1) > 1e-3;

    const radiusX = size / 2;
    const radiusY = radiusX * roundness;
    const maxRadius = Math.max(radiusX, radiusY);

    let extentMultiplier: number;
    if (hardness >= 0.99) {
      extentMultiplier = 1.0;
    } else {
      extentMultiplier = MaskCache.SOFT_MAX_EXTENT;
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
          let boundaryRadius = radiusX;
          let physicalDist = normDist * radiusX;
          if (useEllipticalDistance) {
            const dist = Math.hypot(localX, localY);
            if (normDist > 1e-6) {
              boundaryRadius = dist / normDist;
            }
            physicalDist = dist;
          }
          maskValue = MaskCache.calcHardEdgeAA(physicalDist, boundaryRadius);
        } else if (maskType === 'gaussian') {
          // Gaussian mode: default-style profile with slightly softer tail than default mode.
          maskValue = MaskCache.calcSoftRoundMask(
            normDist,
            hardness,
            MaskCache.GAUSSIAN_SOFT_EXPONENT,
            MaskCache.SOFT_MAX_EXTENT,
            MaskCache.GAUSSIAN_FEATHER_WIDTH
          );
        } else {
          // Default mode: preserve existing character, but add terminal feather to remove hard clipping.
          maskValue = MaskCache.calcSoftRoundMask(
            normDist,
            hardness,
            MaskCache.DEFAULT_SOFT_EXPONENT,
            MaskCache.SOFT_MAX_EXTENT,
            MaskCache.DEFAULT_FEATHER_WIDTH
          );
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
   * @param wetEdge - Wet edge strength (0-1), creates hollow center effect
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
    b: number,
    _wetEdge: number = 0, // Unused
    textureSettings?: TextureSettings | null,
    pattern?: PatternData,
    noiseSettings?: TextureSettings | null,
    noisePattern?: PatternData,
    dualMask?: Float32Array | null,
    dualMode?: DualBlendMode
  ): Rect {
    if (!this.mask) {
      return { left: 0, top: 0, right: 0, bottom: 0 };
    }

    // Calculate buffer position (top-left of mask in buffer coordinates)
    const halfWidth = this.maskWidth / 2;
    const halfHeight = this.maskHeight / 2;
    const bufferLeft = Math.round(cx - halfWidth);
    const bufferTop = Math.round(cy - halfHeight);
    const offsetX = cx - (bufferLeft + halfWidth);
    const offsetY = cy - (bufferTop + halfHeight);
    const useSubpixel = Math.abs(offsetX) > 1e-3 || Math.abs(offsetY) > 1e-3;

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

    const hasNoise = Boolean(noiseSettings && noisePattern);
    const noiseStrength = noiseSettings ? noiseSettings.depth / 100.0 : 0;
    const hasTexturePerTip = Boolean(textureSettings && pattern && textureSettings.textureEachTip);
    const activeTextureSettings = hasTexturePerTip ? textureSettings : null;
    const activePattern = hasTexturePerTip ? pattern : null;

    // Fast blending loop
    if (!useSubpixel) {
      for (let my = startY; my < endY; my++) {
        const bufferRowStart = (bufferTop + my) * bufferWidth;
        const maskRowStart = my * this.maskWidth;

        for (let mx = startX; mx < endX; mx++) {
          let maskValue = this.mask[maskRowStart + mx]!;
          if (maskValue < 0.001) continue;

          const idx = (bufferRowStart + bufferLeft + mx) * 4;
          const dstAlpha = (buffer[idx + 3] ?? 0) / 255;

          // Texture modulation (applied to Alpha Darken opacity ceiling, not tip alpha)
          let textureMod = 1.0;
          if (activeTextureSettings && activePattern) {
            // TextureSettings.depth is 0-100
            const depth = activeTextureSettings.depth / 100.0;
            textureMod = calculateTextureInfluence(
              bufferLeft + mx,
              bufferTop + my,
              activeTextureSettings,
              activePattern,
              depth,
              maskValue,
              dstAlpha
            );
          }

          if (hasNoise) {
            maskValue = MaskCache.applyNoiseOverlayToMaskAlpha(
              maskValue,
              bufferLeft + mx,
              bufferTop + my,
              noiseStrength,
              noiseSettings,
              noisePattern
            );
          }

          // Standard Alpha Darken blend
          let srcAlpha = maskValue;

          // Apply Dual Brush Mask if present
          let dualMod = 1.0;
          if (dualMask && dualMode) {
            const dualVal = dualMask[maskRowStart + mx]!;
            // Apply to Opacity: Calculate density based on full coverage (1.0)
            // This ensures Dual Brush acts as a ceiling/texture rather than flow modifier
            dualMod = MaskCache.blendDual(1.0, dualVal, dualMode);
          }

          srcAlpha *= flow;
          this.blendPixel(buffer, idx, srcAlpha, dabOpacity * dualMod * textureMod, r, g, b);
        }
      }
    } else {
      for (let my = startY; my < endY; my++) {
        const bufferRowStart = (bufferTop + my) * bufferWidth;

        for (let mx = startX; mx < endX; mx++) {
          const sampleX = mx - offsetX;
          const sampleY = my - offsetY;
          let maskValue = MaskCache.sampleBilinear(
            this.mask,
            this.maskWidth,
            this.maskHeight,
            sampleX,
            sampleY
          );
          if (maskValue < 0.001) continue;

          const idx = (bufferRowStart + bufferLeft + mx) * 4;
          const dstAlpha = (buffer[idx + 3] ?? 0) / 255;

          // Texture modulation (applied to Alpha Darken opacity ceiling, not tip alpha)
          let textureMod = 1.0;
          if (activeTextureSettings && activePattern) {
            // TextureSettings.depth is 0-100
            const depth = activeTextureSettings.depth / 100.0;
            textureMod = calculateTextureInfluence(
              bufferLeft + mx,
              bufferTop + my,
              activeTextureSettings,
              activePattern,
              depth,
              maskValue,
              dstAlpha
            );
          }

          if (hasNoise) {
            maskValue = MaskCache.applyNoiseOverlayToMaskAlpha(
              maskValue,
              bufferLeft + mx,
              bufferTop + my,
              noiseStrength,
              noiseSettings,
              noisePattern
            );
          }

          // Standard Alpha Darken blend
          let srcAlpha = maskValue;

          // Apply Dual Brush Mask if present
          let dualMod = 1.0;
          if (dualMask && dualMode) {
            const dualVal = MaskCache.sampleBilinear(
              dualMask,
              this.maskWidth,
              this.maskHeight,
              sampleX,
              sampleY
            );
            // Apply to Opacity: Calculate density based on full coverage (1.0)
            // This ensures Dual Brush acts as a ceiling/texture rather than flow modifier
            dualMod = MaskCache.blendDual(1.0, dualVal, dualMode);
          }

          srcAlpha *= flow;
          this.blendPixel(buffer, idx, srcAlpha, dabOpacity * dualMod * textureMod, r, g, b);
        }
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
   *
   * @param wetEdge - Wet edge strength (0-1), creates hollow center effect
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
    b: number,
    _wetEdge: number = 0, // Unused: wet edge is handled at stroke buffer level
    textureSettings?: TextureSettings | null,
    pattern?: PatternData,
    noiseSettings?: TextureSettings | null,
    noisePattern?: PatternData,
    dualMask?: Float32Array | null,
    dualMode?: DualBlendMode
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

    const hasNoise = Boolean(noiseSettings && noisePattern);
    const noiseStrength = noiseSettings ? noiseSettings.depth / 100.0 : 0;
    const hasTexturePerTip = Boolean(textureSettings && pattern && textureSettings.textureEachTip);
    const activeTextureSettings = hasTexturePerTip ? textureSettings : null;
    const activePattern = hasTexturePerTip ? pattern : null;

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

        // Inner Mode (Krita-style): AA band at [radius-1.0, radius]
        let maskValue = MaskCache.calcHardEdgeAA(physicalDist, radiusX);

        if (maskValue < 0.001) continue;

        const idx = (rowStart + px) * 4;
        const dstAlpha = (buffer[idx + 3] ?? 0) / 255;

        // Texture modulation (applied to Alpha Darken opacity ceiling, not tip alpha)
        let textureMod = 1.0;
        if (activeTextureSettings && activePattern) {
          const depth = activeTextureSettings.depth / 100.0;
          textureMod = calculateTextureInfluence(
            px,
            py,
            activeTextureSettings,
            activePattern,
            depth,
            maskValue,
            dstAlpha
          );
        }

        if (hasNoise) {
          maskValue = MaskCache.applyNoiseOverlayToMaskAlpha(
            maskValue,
            px,
            py,
            noiseStrength,
            noiseSettings,
            noisePattern
          );
        }

        // Dual Brush modulation
        let dualMod = 1.0;
        if (dualMask && dualMode) {
          // For hard brush, we need to map pixel position to mask coordinates
          // Since hard brush doesn't use mask cache, we sample from dualMask using center-relative coords
          const maskWidth = Math.ceil(radius * 2 + 2);
          const maskHeight = Math.ceil(radius * 2 + 2);
          const maskCx = maskWidth / 2;
          const maskCy = maskHeight / 2;
          const mxFloat = px - cx + maskCx;
          const myFloat = py - cy + maskCy;
          const mx = Math.floor(mxFloat);
          const my = Math.floor(myFloat);
          if (mx >= 0 && mx < maskWidth && my >= 0 && my < maskHeight) {
            const dualVal = dualMask[my * maskWidth + mx] ?? 0;
            dualMod = MaskCache.blendDual(1.0, dualVal, dualMode);
          }
        }

        // Standard Alpha Darken blend (wet edge is handled at stroke buffer level)
        const srcAlpha = maskValue * flow;
        this.blendPixel(buffer, idx, srcAlpha, dabOpacity * dualMod * textureMod, r, g, b);
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
   * Stamp the mask into a float alpha buffer (for Dual Brush mask generation)
   */
  stampToMask(
    buffer: Float32Array,
    bufferWidth: number,
    bufferHeight: number,
    cx: number,
    cy: number,
    opacity: number
  ): void {
    if (!this.mask) return;
    const dabOpacity = Math.max(0, Math.min(1, opacity));

    // Calculate buffer position (top-left of mask in buffer coordinates)
    const halfWidth = this.maskWidth / 2;
    const halfHeight = this.maskHeight / 2;
    const bufferLeft = Math.round(cx - halfWidth);
    const bufferTop = Math.round(cy - halfHeight);
    const offsetX = cx - (bufferLeft + halfWidth);
    const offsetY = cy - (bufferTop + halfHeight);
    const useSubpixel = Math.abs(offsetX) > 1e-3 || Math.abs(offsetY) > 1e-3;

    // Clipping
    const startX = Math.max(0, -bufferLeft);
    const startY = Math.max(0, -bufferTop);
    const endX = Math.min(this.maskWidth, bufferWidth - bufferLeft);
    const endY = Math.min(this.maskHeight, bufferHeight - bufferTop);

    if (startX >= endX || startY >= endY) return;

    // Blending loop - Alpha Darken style accumulation (flow fixed to 1.0 by caller)
    if (!useSubpixel) {
      for (let my = startY; my < endY; my++) {
        const bufferRowStart = (bufferTop + my) * bufferWidth;
        const maskRowStart = my * this.maskWidth;

        for (let mx = startX; mx < endX; mx++) {
          const maskValue = this.mask[maskRowStart + mx]!;
          if (maskValue < 0.001) continue;

          const idx = bufferRowStart + bufferLeft + mx;

          const dst = buffer[idx] ?? 0;
          const out = dst >= dabOpacity - 0.001 ? dst : dst + (dabOpacity - dst) * maskValue;
          buffer[idx] = out;
        }
      }
    } else {
      for (let my = startY; my < endY; my++) {
        const bufferRowStart = (bufferTop + my) * bufferWidth;

        for (let mx = startX; mx < endX; mx++) {
          const sampleX = mx - offsetX;
          const sampleY = my - offsetY;
          const maskValue = MaskCache.sampleBilinear(
            this.mask,
            this.maskWidth,
            this.maskHeight,
            sampleX,
            sampleY
          );
          if (maskValue < 0.001) continue;

          const idx = bufferRowStart + bufferLeft + mx;

          const dst = buffer[idx] ?? 0;
          const out = dst >= dabOpacity - 0.001 ? dst : dst + (dabOpacity - dst) * maskValue;
          buffer[idx] = out;
        }
      }
    }
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
