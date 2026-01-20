/**
 * TextureAtlas - GPU texture management for brush textures
 *
 * Manages brush textures on the GPU for texture-based brush rendering.
 * Each texture is stored as a separate GPUTexture (simple approach first,
 * can optimize to texture array later if needed).
 *
 * Key responsibilities:
 * - Upload brush textures to GPU
 * - Cache textures to avoid redundant uploads
 * - Provide texture views for shader binding
 */

import type { BrushTexture } from '@/stores/tool';
import { decodeBase64ToImageData } from '@/utils/imageUtils';

export interface GPUBrushTexture {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  sampler: GPUSampler;
}

export class TextureAtlas {
  private device: GPUDevice;
  private textureCache: Map<string, GPUBrushTexture> = new Map();
  private currentTextureId: string | null = null;
  private currentTexture: GPUBrushTexture | null = null;

  // Default sampler for texture brushes (linear filtering for smooth scaling)
  private defaultSampler: GPUSampler;

  constructor(device: GPUDevice) {
    this.device = device;

    // Create default sampler with linear filtering
    this.defaultSampler = device.createSampler({
      label: 'Brush Texture Sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  /**
   * Set the current brush texture
   * Uploads to GPU if not already cached
   *
   * @returns true if texture is ready, false if async loading needed
   */
  async setTexture(texture: BrushTexture): Promise<boolean> {
    const textureId = texture.id;

    // Check if already current
    if (textureId === this.currentTextureId && this.currentTexture) {
      return true;
    }

    // Check cache
    const cached = this.textureCache.get(textureId);
    if (cached) {
      this.currentTextureId = textureId;
      this.currentTexture = cached;
      return true;
    }

    // Need to upload - first ensure ImageData is available
    let imageData = texture.imageData;
    if (!imageData) {
      imageData = await decodeBase64ToImageData(texture.data, texture.width, texture.height);
      texture.imageData = imageData; // Cache in the texture object
    }

    // Upload to GPU
    const gpuTexture = this.uploadTexture(imageData, texture.width, texture.height, textureId);

    // Cache and set as current
    this.textureCache.set(textureId, gpuTexture);
    this.currentTextureId = textureId;
    this.currentTexture = gpuTexture;

    return true;
  }

  /**
   * Synchronous texture set - returns false if texture not ready
   */
  setTextureSync(texture: BrushTexture): boolean {
    const textureId = texture.id;

    // Check if already current
    if (textureId === this.currentTextureId && this.currentTexture) {
      return true;
    }

    // Check cache
    const cached = this.textureCache.get(textureId);
    if (cached) {
      this.currentTextureId = textureId;
      this.currentTexture = cached;
      return true;
    }

    // Check if ImageData is already decoded
    if (texture.imageData) {
      const gpuTexture = this.uploadTexture(
        texture.imageData,
        texture.width,
        texture.height,
        textureId
      );
      this.textureCache.set(textureId, gpuTexture);
      this.currentTextureId = textureId;
      this.currentTexture = gpuTexture;
      return true;
    }

    // Need async loading
    return false;
  }

  /**
   * Get the current texture for shader binding
   */
  getCurrentTexture(): GPUBrushTexture | null {
    return this.currentTexture;
  }

  /**
   * Check if a texture is loaded and ready
   */
  hasTexture(): boolean {
    return this.currentTexture !== null;
  }

  /**
   * Upload ImageData to GPU texture
   */
  private uploadTexture(
    imageData: ImageData,
    width: number,
    height: number,
    textureId: string
  ): GPUBrushTexture {
    // Create GPU texture with unique label for BindGroup cache key
    const texture = this.device.createTexture({
      label: `Brush Texture ${textureId}`,
      size: [width, height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // Upload data
    this.device.queue.writeTexture({ texture }, imageData.data, { bytesPerRow: width * 4 }, [
      width,
      height,
    ]);

    return {
      texture,
      view: texture.createView(),
      width,
      height,
      sampler: this.defaultSampler,
    };
  }

  /**
   * Clear a specific texture from cache
   */
  clearTexture(texture: BrushTexture): void {
    const textureId = texture.id;
    const cached = this.textureCache.get(textureId);
    if (cached) {
      cached.texture.destroy();
      this.textureCache.delete(textureId);

      if (this.currentTextureId === textureId) {
        this.currentTextureId = null;
        this.currentTexture = null;
      }
    }
  }

  /**
   * Clear all cached textures
   */
  clear(): void {
    for (const gpuTexture of this.textureCache.values()) {
      gpuTexture.texture.destroy();
    }
    this.textureCache.clear();
    this.currentTextureId = null;
    this.currentTexture = null;
  }

  /**
   * Release all GPU resources
   */
  destroy(): void {
    this.clear();
  }
}
