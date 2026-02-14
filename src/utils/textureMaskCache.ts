/**
 * TextureMaskCache - Handles texture-based brush masks (from ABR imports)
 *
 * Unlike MaskCache which generates procedural masks, this class uses
 * pre-defined texture images as brush tips. The texture is scaled and
 * rotated according to brush settings.
 *
 * Key responsibilities:
 * - Load texture from protocol or decode base64 PNG (cached)
 * - Scale texture to current brush size
 * - Apply rotation and roundness transforms
 * - Stamp texture to buffer using Alpha Darken blending
 */

import type { Rect } from './strokeBuffer';
import type { BrushTexture } from '@/stores/tool';
import { loadBrushTexture } from './brushLoader';
import { decodeBase64ToImageData, decodeBase64ToImageDataSync } from './imageUtils';
import type { TextureSettings } from '@/components/BrushPanel/types';
import type { PatternData } from './patternManager';
import { calculateTextureInfluence, sampleNoiseValue } from './textureRendering';
import type { DualBlendMode } from '@/stores/tool';

// PS Dual Brush blend modes (only 8 supported)
function blendOverlay(primary: number, secondary: number): number {
  if (primary < 0.5) {
    return 2.0 * primary * secondary;
  }
  return 1.0 - 2.0 * (1.0 - primary) * (1.0 - secondary);
}

function blendDual(primary: number, secondary: number, mode: DualBlendMode): number {
  const s = Math.max(0, Math.min(1, secondary));
  const p = Math.max(0, Math.min(1, primary));

  switch (mode) {
    case 'multiply':
      return p * s;
    case 'darken':
      return Math.min(p, s);
    case 'overlay':
      return blendOverlay(p, s);
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

interface TextureMaskParams {
  /** Current brush size (diameter in pixels) */
  size: number;
  /** Brush roundness (0-1, 1 = use original aspect ratio) */
  roundness: number;
  /** Rotation angle in degrees */
  angle: number;
}

/**
 * TextureMaskCache - Caches scaled/rotated texture masks for performance
 */
export class TextureMaskCache {
  // Source texture (from BrushTexture) - cached ImageData
  private sourceImageData: ImageData | null = null;

  // Texture identity tracking (base64 data hash for change detection)
  private currentTextureId: string | null = null;

  // Cached scaled mask (grayscale, 0-1 values)
  private scaledMask: Float32Array | null = null;
  private scaledWidth: number = 0;
  private scaledHeight: number = 0;

  // Cached parameters for invalidation
  private cachedParams: TextureMaskParams | null = null;

  // Center offset for stamping
  private centerX: number = 0;
  private centerY: number = 0;

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

  private static applyNoiseOverlayToMaskAlpha(
    maskAlpha: number,
    canvasX: number,
    canvasY: number,
    strength: number,
    noiseSettings?: TextureSettings | null,
    noisePattern?: PatternData
  ): number {
    if (!noiseSettings || !noisePattern) return maskAlpha;
    if (strength <= 0.001) return maskAlpha;
    if (maskAlpha <= 0.001 || maskAlpha >= 0.999) return maskAlpha;

    const noiseVal = sampleNoiseValue(canvasX, canvasY, noiseSettings, noisePattern);
    const over = blendOverlay(maskAlpha, noiseVal);
    return maskAlpha + (over - maskAlpha) * strength;
  }

  /**
   * Helper: Check if texture is already current or has cached ImageData
   */
  getScaledWidth(): number {
    return this.scaledWidth;
  }

  getScaledHeight(): number {
    return this.scaledHeight;
  }

  private tryUseCachedTexture(texture: BrushTexture): boolean {
    const textureId = texture.id;

    // Fast path: same texture ID and data already loaded
    if (textureId === this.currentTextureId && this.sourceImageData) {
      return true;
    }

    // Check if texture object itself has cached ImageData
    if (texture.imageData) {
      this.sourceImageData = texture.imageData;
      this.currentTextureId = textureId;
      this.invalidateCache();
      return true;
    }

    return false;
  }

  /**
   * Set the source texture (call when brush preset changes)
   * Returns a Promise that resolves when texture is decoded
   */
  async setTexture(texture: BrushTexture): Promise<void> {
    if (this.tryUseCachedTexture(texture)) return;

    const textureId = texture.id;

    // 1. Try protocol load (optimized)
    let imageData = await loadBrushTexture(textureId, texture.width, texture.height);

    // 2. Fallback to Base64 if needed
    if (!imageData && texture.data) {
      imageData = await decodeBase64ToImageData(texture.data, texture.width, texture.height);
    }

    if (!imageData) {
      console.error(`[TextureMaskCache] Failed to load texture: ${textureId}`);
      return;
    }

    // Cache result
    texture.imageData = imageData;
    this.sourceImageData = imageData;
    this.currentTextureId = textureId;
    this.invalidateCache();
  }

  /**
   * Set texture synchronously (for immediate use, may fail)
   */
  setTextureSync(texture: BrushTexture): boolean {
    if (this.tryUseCachedTexture(texture)) return true;

    // Try synchronous Base64 fallback
    if (texture.data) {
      const imageData = decodeBase64ToImageDataSync(texture.data, texture.width, texture.height);
      if (imageData) {
        texture.imageData = imageData;
        this.sourceImageData = imageData;
        this.currentTextureId = texture.id;
        this.invalidateCache();
        return true;
      }
    }

    // Trigger async load in background
    this.setTexture(texture).catch(() => {
      // Silent fail - will be handled by next repaint
    });

    return false;
  }

  /**
   * Check if texture is loaded and ready
   */
  hasTexture(): boolean {
    return this.sourceImageData !== null;
  }

  /**
   * Invalidate the scaled mask cache
   */
  private invalidateCache(): void {
    this.scaledMask = null;
    this.cachedParams = null;
  }

  /**
   * Check if the scaled mask needs regeneration
   */
  needsUpdate(params: TextureMaskParams): boolean {
    if (!this.scaledMask || !this.cachedParams) return true;

    const sizeTolerance = this.cachedParams.size * 0.02; // 2% tolerance
    return (
      Math.abs(params.size - this.cachedParams.size) > sizeTolerance ||
      Math.abs(params.roundness - this.cachedParams.roundness) > 0.01 ||
      Math.abs(params.angle - this.cachedParams.angle) > 0.5
    );
  }

  /**
   * Generate scaled and rotated mask from source texture
   */
  generateMask(params: TextureMaskParams): void {
    if (!this.sourceImageData) return;

    const { size, roundness, angle } = params;
    const srcW = this.sourceImageData.width;
    const srcH = this.sourceImageData.height;
    const srcData = this.sourceImageData.data;

    // Maintain aspect ratio, then apply roundness (squeeze vertically)
    const aspectRatio = srcW / srcH;
    const roundnessScale = Math.max(0.01, Math.min(1, roundness));
    let baseW: number;
    let baseH: number;

    if (aspectRatio >= 1) {
      baseW = size;
      baseH = size / aspectRatio;
    } else {
      baseH = size;
      baseW = size * aspectRatio;
    }

    const targetW = baseW;
    const targetH = baseH * roundnessScale;

    // Add margin for rotation
    const diagonal = Math.sqrt(targetW * targetW + targetH * targetH);
    const margin = Math.ceil((diagonal - Math.min(targetW, targetH)) / 2) + 2;

    this.scaledWidth = Math.ceil(targetW + margin * 2);
    this.scaledHeight = Math.ceil(targetH + margin * 2);
    this.centerX = this.scaledWidth / 2;
    this.centerY = this.scaledHeight / 2;

    // Allocate mask buffer
    this.scaledMask = new Float32Array(this.scaledWidth * this.scaledHeight);

    // Pre-calculate rotation matrices
    const angleRad = (angle * Math.PI) / 180;
    const cosA = Math.cos(-angleRad);
    const sinA = Math.sin(-angleRad);
    const scaleX = srcW / targetW;
    const scaleY = srcH / targetH;

    // Sample from source texture with bilinear interpolation
    for (let py = 0; py < this.scaledHeight; py++) {
      const dy = py + 0.5 - this.centerY;

      for (let px = 0; px < this.scaledWidth; px++) {
        const dx = px + 0.5 - this.centerX;

        // Apply inverse rotation
        const localX = dx * cosA - dy * sinA;
        const localY = dx * sinA + dy * cosA;

        // Map to source texture coordinates
        const srcX = (localX + targetW / 2) * scaleX;
        const srcY = (localY + targetH / 2) * scaleY;

        // Bounds check
        if (srcX < 0 || srcX >= srcW || srcY < 0 || srcY >= srcH) {
          this.scaledMask[py * this.scaledWidth + px] = 0;
          continue;
        }

        // Bilinear interpolation
        const x0 = Math.floor(srcX);
        const y0 = Math.floor(srcY);
        const x1 = Math.min(x0 + 1, srcW - 1);
        const y1 = Math.min(y0 + 1, srcH - 1);
        const fx = srcX - x0;
        const fy = srcY - y0;

        // Optimized alpha channel sampling helper
        // Use R channel (index 0) since ABR textures are grayscale
        const v00 = srcData[(y0 * srcW + x0) * 4]! / 255;
        const v10 = srcData[(y0 * srcW + x1) * 4]! / 255;
        const v01 = srcData[(y1 * srcW + x0) * 4]! / 255;
        const v11 = srcData[(y1 * srcW + x1) * 4]! / 255;

        this.scaledMask[py * this.scaledWidth + px] =
          v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
      }
    }

    this.cachedParams = { ...params };
  }

  /**
   * Stamp the texture mask to buffer using Alpha Darken blending
   * Same blending logic as MaskCache for consistency
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
    textureSettings?: TextureSettings | null,
    pattern?: PatternData,
    noiseSettings?: TextureSettings | null,
    noisePattern?: PatternData,
    dualMask?: Float32Array | null,
    dualMode?: DualBlendMode
  ): Rect {
    if (!this.scaledMask) {
      return { left: 0, top: 0, right: 0, bottom: 0 };
    }

    // Calculate buffer position
    const halfWidth = this.scaledWidth / 2;
    const halfHeight = this.scaledHeight / 2;
    const bufferLeft = Math.round(cx - halfWidth);
    const bufferTop = Math.round(cy - halfHeight);
    const offsetX = cx - (bufferLeft + halfWidth);
    const offsetY = cy - (bufferTop + halfHeight);
    const useSubpixel = Math.abs(offsetX) > 1e-3 || Math.abs(offsetY) > 1e-3;
    const hasTexturePerTip = Boolean(textureSettings && pattern && textureSettings.textureEachTip);
    const textureDepth = textureSettings ? textureSettings.depth / 100.0 : 0;
    const noiseStrength = noiseSettings ? noiseSettings.depth / 100.0 : 0;

    // Clipping
    const startX = Math.max(0, -bufferLeft);
    const startY = Math.max(0, -bufferTop);
    const endX = Math.min(this.scaledWidth, bufferWidth - bufferLeft);
    const endY = Math.min(this.scaledHeight, bufferHeight - bufferTop);

    if (startX >= endX || startY >= endY) {
      return { left: 0, top: 0, right: 0, bottom: 0 };
    }

    // Dirty rect in buffer coordinates
    const dirtyLeft = bufferLeft + startX;
    const dirtyTop = bufferTop + startY;
    const dirtyRight = bufferLeft + endX;
    const dirtyBottom = bufferTop + endY;

    // Blending loop
    if (!useSubpixel) {
      for (let my = startY; my < endY; my++) {
        const bufferRowStart = (bufferTop + my) * bufferWidth;
        const maskRowStart = my * this.scaledWidth;

        for (let mx = startX; mx < endX; mx++) {
          let maskValue = this.scaledMask[maskRowStart + mx]!;
          if (maskValue < 0.001) continue;

          const bufferX = bufferLeft + mx;
          const bufferY = bufferTop + my;
          const idx = (bufferRowStart + bufferX) * 4;
          const dstA = (buffer[idx + 3] ?? 0) / 255;

          // Texture modulation for Each Tip ON: modulate tip alpha before Alpha Darken accumulation.
          if (hasTexturePerTip) {
            const textureMultiplier = calculateTextureInfluence(
              bufferX,
              bufferY,
              textureSettings!,
              pattern!,
              textureDepth,
              maskValue,
              0
            );
            maskValue = Math.max(0, Math.min(1, maskValue * textureMultiplier));
          }

          // Noise affects tip alpha via overlay (PS-like): only meaningful when 0 < alpha < 1
          maskValue = TextureMaskCache.applyNoiseOverlayToMaskAlpha(
            maskValue,
            bufferX,
            bufferY,
            noiseStrength,
            noiseSettings,
            noisePattern
          );

          // Standard Alpha Darken blend
          const srcAlpha = maskValue * flow;

          // Apply Dual Brush Mask if present
          // Dual brush modifies OPACITY (like texture), not flow
          let dualMod = 1.0;
          if (dualMask && dualMode) {
            const dualVal = dualMask[maskRowStart + mx]!;
            // Use maskValue as the primary to preserve brush shape; dualVal modulates density
            dualMod = blendDual(maskValue, dualVal, dualMode);
          }

          const dstR = buffer[idx]!;
          const dstG = buffer[idx + 1]!;
          const dstB = buffer[idx + 2]!;

          // Alpha Darken blending - dual brush affects opacity ceiling, texture already modified tip alpha.
          const effectiveOpacity = dabOpacity * dualMod;
          const outA =
            dstA >= effectiveOpacity - 0.001 ? dstA : dstA + (effectiveOpacity - dstA) * srcAlpha;

          if (outA > 0.001) {
            const hasColor = dstA > 0.001;
            buffer[idx] = (hasColor ? dstR + (r - dstR) * srcAlpha : r) + 0.5;
            buffer[idx + 1] = (hasColor ? dstG + (g - dstG) * srcAlpha : g) + 0.5;
            buffer[idx + 2] = (hasColor ? dstB + (b - dstB) * srcAlpha : b) + 0.5;
            buffer[idx + 3] = outA * 255 + 0.5;
          }
        }
      }
    } else {
      for (let my = startY; my < endY; my++) {
        const bufferRowStart = (bufferTop + my) * bufferWidth;

        for (let mx = startX; mx < endX; mx++) {
          const sampleX = mx - offsetX;
          const sampleY = my - offsetY;
          let maskValue = TextureMaskCache.sampleBilinear(
            this.scaledMask,
            this.scaledWidth,
            this.scaledHeight,
            sampleX,
            sampleY
          );
          if (maskValue < 0.001) continue;

          const bufferX = bufferLeft + mx;
          const bufferY = bufferTop + my;
          const idx = (bufferRowStart + bufferX) * 4;
          const dstA = (buffer[idx + 3] ?? 0) / 255;

          // Texture modulation for Each Tip ON: modulate tip alpha before Alpha Darken accumulation.
          if (hasTexturePerTip) {
            const textureMultiplier = calculateTextureInfluence(
              bufferX,
              bufferY,
              textureSettings!,
              pattern!,
              textureDepth,
              maskValue,
              0
            );
            maskValue = Math.max(0, Math.min(1, maskValue * textureMultiplier));
          }

          // Noise affects tip alpha via overlay (PS-like): only meaningful when 0 < alpha < 1
          maskValue = TextureMaskCache.applyNoiseOverlayToMaskAlpha(
            maskValue,
            bufferX,
            bufferY,
            noiseStrength,
            noiseSettings,
            noisePattern
          );

          // Standard Alpha Darken blend
          const srcAlpha = maskValue * flow;

          // Apply Dual Brush Mask if present
          // Dual brush modifies OPACITY (like texture), not flow
          let dualMod = 1.0;
          if (dualMask && dualMode) {
            const dualVal = TextureMaskCache.sampleBilinear(
              dualMask,
              this.scaledWidth,
              this.scaledHeight,
              sampleX,
              sampleY
            );
            // Use maskValue as the primary to preserve brush shape; dualVal modulates density
            dualMod = blendDual(maskValue, dualVal, dualMode);
          }

          const dstR = buffer[idx]!;
          const dstG = buffer[idx + 1]!;
          const dstB = buffer[idx + 2]!;

          // Alpha Darken blending - dual brush affects opacity ceiling, texture already modified tip alpha.
          const effectiveOpacity = dabOpacity * dualMod;
          const outA =
            dstA >= effectiveOpacity - 0.001 ? dstA : dstA + (effectiveOpacity - dstA) * srcAlpha;

          if (outA > 0.001) {
            const hasColor = dstA > 0.001;
            buffer[idx] = (hasColor ? dstR + (r - dstR) * srcAlpha : r) + 0.5;
            buffer[idx + 1] = (hasColor ? dstG + (g - dstG) * srcAlpha : g) + 0.5;
            buffer[idx + 2] = (hasColor ? dstB + (b - dstB) * srcAlpha : b) + 0.5;
            buffer[idx + 3] = outA * 255 + 0.5;
          }
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
   * Get mask dimensions
   */
  getDimensions(): { width: number; height: number } {
    return { width: this.scaledWidth, height: this.scaledHeight };
  }

  /**
   * Stamp the texture mask into a float alpha buffer (for Dual Brush mask generation)
   */
  stampToMask(
    buffer: Float32Array,
    bufferWidth: number,
    bufferHeight: number,
    cx: number,
    cy: number,
    opacity: number
  ): void {
    if (!this.scaledMask) return;
    const dabOpacity = Math.max(0, Math.min(1, opacity));

    // Calculate buffer position
    const halfWidth = this.scaledWidth / 2;
    const halfHeight = this.scaledHeight / 2;
    const bufferLeft = Math.round(cx - halfWidth);
    const bufferTop = Math.round(cy - halfHeight);
    const offsetX = cx - (bufferLeft + halfWidth);
    const offsetY = cy - (bufferTop + halfHeight);
    const useSubpixel = Math.abs(offsetX) > 1e-3 || Math.abs(offsetY) > 1e-3;

    // Clipping
    const startX = Math.max(0, -bufferLeft);
    const startY = Math.max(0, -bufferTop);
    const endX = Math.min(this.scaledWidth, bufferWidth - bufferLeft);
    const endY = Math.min(this.scaledHeight, bufferHeight - bufferTop);

    if (startX >= endX || startY >= endY) return;

    // Blending loop - Alpha Darken style accumulation (flow fixed to 1.0 by caller)
    if (!useSubpixel) {
      for (let my = startY; my < endY; my++) {
        const bufferRowStart = (bufferTop + my) * bufferWidth;
        const maskRowStart = my * this.scaledWidth;

        for (let mx = startX; mx < endX; mx++) {
          const maskValue = this.scaledMask[maskRowStart + mx]!;
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
          const maskValue = TextureMaskCache.sampleBilinear(
            this.scaledMask,
            this.scaledWidth,
            this.scaledHeight,
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
   * Clear all cached data
   */
  clear(): void {
    this.sourceImageData = null;
    this.currentTextureId = null;
    this.scaledMask = null;
    this.cachedParams = null;
    this.scaledWidth = 0;
    this.scaledHeight = 0;
  }
}
