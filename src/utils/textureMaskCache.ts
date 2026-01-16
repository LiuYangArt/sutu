/**
 * TextureMaskCache - Handles texture-based brush masks (from ABR imports)
 *
 * Unlike MaskCache which generates procedural masks, this class uses
 * pre-defined texture images as brush tips. The texture is scaled and
 * rotated according to brush settings.
 *
 * Key responsibilities:
 * - Decode base64 PNG texture to ImageData (cached)
 * - Scale texture to current brush size
 * - Apply rotation and roundness transforms
 * - Stamp texture to buffer using Alpha Darken blending
 */

import type { Rect } from './strokeBuffer';
import type { BrushTexture } from '@/stores/tool';

/**
 * Decode base64 PNG to ImageData
 * Uses OffscreenCanvas for performance when available
 */
async function decodeBase64ToImageData(
  base64: string,
  width: number,
  height: number
): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Use OffscreenCanvas if available (better performance)
      const canvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(width, height)
          : document.createElement('canvas');

      if (!(canvas instanceof OffscreenCanvas)) {
        canvas.width = width;
        canvas.height = height;
      }

      const ctx = canvas.getContext('2d') as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D;
      if (!ctx) {
        reject(new Error('Failed to create canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);
      const imageData = ctx.getImageData(0, 0, width, height);
      resolve(imageData);
    };
    img.onerror = () => reject(new Error('Failed to load texture image'));
    img.src = `data:image/png;base64,${base64}`;
  });
}

/**
 * Synchronously decode base64 PNG (blocking, for immediate use)
 * Falls back to creating a temporary canvas
 */
function decodeBase64ToImageDataSync(
  base64: string,
  width: number,
  height: number
): ImageData | null {
  try {
    // Create a temporary image element
    const img = new Image();
    img.src = `data:image/png;base64,${base64}`;

    // If image is not yet loaded, we can't decode synchronously
    if (!img.complete) {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(img, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } catch {
    return null;
  }
}

export interface TextureMaskParams {
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

  /**
   * Set the source texture (call when brush preset changes)
   * Returns a Promise that resolves when texture is decoded
   */
  async setTexture(texture: BrushTexture): Promise<void> {
    // Generate texture ID for change detection (use first 100 chars of base64)
    const textureId = texture.data.substring(0, 100);

    // Skip if same texture
    if (textureId === this.currentTextureId && this.sourceImageData) {
      return;
    }

    // Check if texture already has cached ImageData
    if (texture.imageData) {
      this.sourceImageData = texture.imageData;
      this.currentTextureId = textureId;
      this.invalidateCache();
      return;
    }

    // Decode base64 to ImageData
    const imageData = await decodeBase64ToImageData(texture.data, texture.width, texture.height);

    // Cache in the texture object for future use
    texture.imageData = imageData;

    this.sourceImageData = imageData;
    this.currentTextureId = textureId;
    this.invalidateCache();
  }

  /**
   * Set texture synchronously (for immediate use, may fail)
   */
  setTextureSync(texture: BrushTexture): boolean {
    // Generate texture ID for change detection
    const textureId = texture.data.substring(0, 100);

    // Skip if same texture
    if (textureId === this.currentTextureId && this.sourceImageData) {
      return true;
    }

    if (texture.imageData) {
      this.sourceImageData = texture.imageData;
      this.currentTextureId = textureId;
      this.invalidateCache();
      return true;
    }

    const imageData = decodeBase64ToImageDataSync(texture.data, texture.width, texture.height);
    if (!imageData) {
      return false;
    }

    texture.imageData = imageData;
    this.sourceImageData = imageData;
    this.currentTextureId = textureId;
    this.invalidateCache();
    return true;
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

    // Calculate target size maintaining aspect ratio
    const aspectRatio = srcW / srcH;
    let targetW: number, targetH: number;

    if (roundness >= 0.99) {
      // Use original aspect ratio
      if (aspectRatio >= 1) {
        targetW = size;
        targetH = size / aspectRatio;
      } else {
        targetH = size;
        targetW = size * aspectRatio;
      }
    } else {
      // Apply roundness (squeeze vertically)
      targetW = size;
      targetH = size * roundness;
    }

    // Add margin for rotation
    const diagonal = Math.sqrt(targetW * targetW + targetH * targetH);
    const margin = Math.ceil((diagonal - Math.min(targetW, targetH)) / 2) + 2;

    this.scaledWidth = Math.ceil(targetW + margin * 2);
    this.scaledHeight = Math.ceil(targetH + margin * 2);
    this.centerX = this.scaledWidth / 2;
    this.centerY = this.scaledHeight / 2;

    // Allocate mask buffer
    this.scaledMask = new Float32Array(this.scaledWidth * this.scaledHeight);

    // Pre-calculate rotation
    const angleRad = (angle * Math.PI) / 180;
    const cosA = Math.cos(-angleRad);
    const sinA = Math.sin(-angleRad);

    // Scale factors
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

        // Sample alpha channel (grayscale texture uses all channels equally)
        // For grayscale PNG, we use the first channel (R) as the mask value
        const getAlpha = (x: number, y: number): number => {
          const idx = (y * srcW + x) * 4;
          // Use the grayscale value (R channel) as alpha
          // ABR textures are grayscale: 0 = transparent, 255 = opaque
          return srcData[idx]! / 255;
        };

        const v00 = getAlpha(x0, y0);
        const v10 = getAlpha(x1, y0);
        const v01 = getAlpha(x0, y1);
        const v11 = getAlpha(x1, y1);

        const value =
          v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;

        this.scaledMask[py * this.scaledWidth + px] = value;
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
    b: number
  ): Rect {
    if (!this.scaledMask) {
      return { left: 0, top: 0, right: 0, bottom: 0 };
    }

    // Calculate buffer position
    const halfWidth = this.scaledWidth / 2;
    const halfHeight = this.scaledHeight / 2;
    const bufferLeft = Math.round(cx - halfWidth);
    const bufferTop = Math.round(cy - halfHeight);

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

    // Blending loop (same as MaskCache.blendPixel)
    for (let my = startY; my < endY; my++) {
      const bufferRowStart = (bufferTop + my) * bufferWidth;
      const maskRowStart = my * this.scaledWidth;

      for (let mx = startX; mx < endX; mx++) {
        const maskValue = this.scaledMask[maskRowStart + mx]!;
        if (maskValue < 0.001) continue;

        const srcAlpha = maskValue * flow;
        const idx = (bufferRowStart + bufferLeft + mx) * 4;

        // Alpha Darken blend (same as MaskCache)
        const dstR = buffer[idx]!;
        const dstG = buffer[idx + 1]!;
        const dstB = buffer[idx + 2]!;
        const dstA = buffer[idx + 3]! / 255;

        // Alpha Darken: lerp toward ceiling
        const outA = dstA >= dabOpacity - 0.001 ? dstA : dstA + (dabOpacity - dstA) * srcAlpha;

        if (outA > 0.001) {
          const hasColor = dstA > 0.001;
          buffer[idx] = (hasColor ? dstR + (r - dstR) * srcAlpha : r) + 0.5;
          buffer[idx + 1] = (hasColor ? dstG + (g - dstG) * srcAlpha : g) + 0.5;
          buffer[idx + 2] = (hasColor ? dstB + (b - dstB) * srcAlpha : b) + 0.5;
          buffer[idx + 3] = outA * 255 + 0.5;
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
