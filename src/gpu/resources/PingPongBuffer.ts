/**
 * PingPongBuffer - Double buffering for WebGPU stroke accumulation
 *
 * WebGPU prohibits reading and writing to the same texture in a single render pass.
 * This class manages two textures that swap roles:
 * - Source: Read from (previous frame state)
 * - Dest: Write to (current frame output)
 *
 * After each batch, the roles are swapped.
 */

export class PingPongBuffer {
  private textureA: GPUTexture;
  private textureB: GPUTexture;
  private currentSource: GPUTexture;
  private currentDest: GPUTexture;
  private device: GPUDevice;

  readonly format: GPUTextureFormat = 'rgba32float'; // Changed from rgba16float for easy readback
  private _width: number;
  private _height: number;

  constructor(device: GPUDevice, width: number, height: number) {
    this.device = device;
    this._width = width;
    this._height = height;

    const textureDesc = this.createTextureDescriptor(width, height);

    this.textureA = device.createTexture(textureDesc);
    this.textureB = device.createTexture(textureDesc);
    this.currentSource = this.textureA;
    this.currentDest = this.textureB;
  }

  private createTextureDescriptor(width: number, height: number): GPUTextureDescriptor {
    return {
      size: [width, height],
      format: this.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    };
  }

  /**
   * Get the current read source texture
   */
  get source(): GPUTexture {
    return this.currentSource;
  }

  /**
   * Get the current write destination texture
   */
  get dest(): GPUTexture {
    return this.currentDest;
  }

  get width(): number {
    return this._width;
  }

  get height(): number {
    return this._height;
  }

  /**
   * Swap source and destination roles
   * Call this after each render pass
   */
  swap(): void {
    [this.currentSource, this.currentDest] = [this.currentDest, this.currentSource];
  }

  /**
   * Copy a rectangular region from source to destination
   * Used for incremental updates during per-dab rendering
   */
  copyRect(encoder: GPUCommandEncoder, x: number, y: number, width: number, height: number): void {
    if (width <= 0 || height <= 0) return;

    // Clamp to texture bounds
    const clampedX = Math.max(0, Math.min(x, this._width));
    const clampedY = Math.max(0, Math.min(y, this._height));
    const clampedW = Math.min(width, this._width - clampedX);
    const clampedH = Math.min(height, this._height - clampedY);

    if (clampedW <= 0 || clampedH <= 0) return;

    encoder.copyTextureToTexture(
      { texture: this.currentSource, origin: { x: clampedX, y: clampedY } },
      { texture: this.currentDest, origin: { x: clampedX, y: clampedY } },
      [clampedW, clampedH]
    );
  }

  /**
   * Copy source texture to destination (full frame)
   * This preserves the previous frame state in areas not covered by new dabs
   */
  copySourceToDest(encoder: GPUCommandEncoder): void {
    encoder.copyTextureToTexture({ texture: this.currentSource }, { texture: this.currentDest }, [
      this._width,
      this._height,
    ]);
  }

  /**
   * Clear both buffers to transparent
   * Uses a clear render pass for proper GPU clearing
   */
  clear(device: GPUDevice): void {
    const encoder = device.createCommandEncoder();

    // Clear texture A
    const passA = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.textureA.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    passA.end();

    // Clear texture B
    const passB = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.textureB.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    passB.end();

    device.queue.submit([encoder.finish()]);
  }

  /**
   * Resize the buffers (clears content)
   */
  resize(width: number, height: number): void {
    if (width === this._width && height === this._height) {
      return;
    }

    this.textureA.destroy();
    this.textureB.destroy();

    const textureDesc = this.createTextureDescriptor(width, height);

    this.textureA = this.device.createTexture(textureDesc);
    this.textureB = this.device.createTexture(textureDesc);
    this.currentSource = this.textureA;
    this.currentDest = this.textureB;

    this._width = width;
    this._height = height;
  }

  /**
   * Release GPU resources
   */
  destroy(): void {
    this.textureA.destroy();
    this.textureB.destroy();
  }
}
