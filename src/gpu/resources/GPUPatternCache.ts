import { patternManager } from '@/utils/patternManager';

/**
 * GPUPatternCache - Manages GPU pattern textures
 *
 * Responsibilities:
 * 1. Load pattern data from PatternManager
 * 2. Upload to GPU texture
 * 3. Track current pattern ID to minimize re-uploads
 */
export class GPUPatternCache {
  private device: GPUDevice;
  private currentPatternId: string | null = null;
  private texture: GPUTexture | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * Update the cached texture if necessary
   * @param patternId - The pattern ID to load (or null to clear)
   * @returns true if a valid texture is available (newly loaded or existing)
   */
  update(patternId: string | null): boolean {
    // Case 1: Clear pattern
    if (!patternId) {
      if (this.texture) {
        // We don't strictly need to destroy immediately if we want to cache,
        // but for now let's keep it simple.
        // Actually, let's NOT destroy it if it's just a toggle off,
        // but since we only track ONE current texture, we might as well.
        // If we want to support fast toggling, we would keep it.
        // But patternId is usually persistent per brush.
        // If the brush changes to one without pattern, patternId becomes null.
        this.currentPatternId = null;
      }
      return false;
    }

    // Case 2: Same pattern already loaded
    if (this.currentPatternId === patternId && this.texture) {
      return true;
    }

    // Case 3: Load new pattern
    const pattern = patternManager.getPattern(patternId);
    if (!pattern) {
      // Pattern data not loaded in PatternManager yet
      // Caller should trigger async load via patternManager if needed,
      // but rendering will proceed without pattern this frame.
      return false;
    }

    // Destroy old texture
    if (this.texture) {
      this.texture.destroy();
    }

    // Create new texture
    this.texture = this.device.createTexture({
      label: `Pattern Texture: ${pattern.id}`,
      size: { width: pattern.width, height: pattern.height },
      format: 'rgba8unorm', // Pattern data is RGBA
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Upload data
    this.device.queue.writeTexture(
      { texture: this.texture },
      pattern.data as unknown as BufferSource,
      { bytesPerRow: pattern.width * 4 },
      { width: pattern.width, height: pattern.height }
    );

    this.currentPatternId = patternId;
    return true;
  }

  /**
   * Get the current valid texture
   */
  getTexture(): GPUTexture | null {
    return this.currentPatternId ? this.texture : null;
  }

  /**
   * Destroy resources
   */
  destroy(): void {
    this.texture?.destroy();
    this.texture = null;
    this.currentPatternId = null;
  }
}
