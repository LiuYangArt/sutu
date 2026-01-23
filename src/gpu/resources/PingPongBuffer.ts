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

  // Display texture for wet edge post-processing (lazy initialized to save VRAM)
  // This texture is separate from ping-pong to avoid idempotency issues
  private displayTexture: GPUTexture | null = null;

  readonly format: GPUTextureFormat = 'rgba32float'; // Changed from rgba16float for easy readback
  private _width: number; // Logical width (canvas size)
  private _height: number; // Logical height (canvas size)
  private _renderScale: number = 1.0; // Render scale (1.0 = full res)
  private _textureWidth: number; // Actual texture width
  private _textureHeight: number; // Actual texture height

  constructor(device: GPUDevice, width: number, height: number, renderScale: number = 1.0) {
    this.device = device;
    this._width = width;
    this._height = height;
    this._renderScale = renderScale;
    this._textureWidth = Math.max(1, Math.floor(width * renderScale));
    this._textureHeight = Math.max(1, Math.floor(height * renderScale));

    // Create textures with unique labels (critical for BindGroup caching)
    this.textureA = device.createTexture(
      this.createTextureDescriptor(this._textureWidth, this._textureHeight, 'A')
    );
    this.textureB = device.createTexture(
      this.createTextureDescriptor(this._textureWidth, this._textureHeight, 'B')
    );
    this.currentSource = this.textureA;
    this.currentDest = this.textureB;
  }

  private createTextureDescriptor(
    width: number,
    height: number,
    labelSuffix: string = ''
  ): GPUTextureDescriptor {
    return {
      label: `PingPong Texture ${labelSuffix}`.trim(),
      size: [width, height],
      format: this.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING | // Required for compute shader write
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

  /** Actual texture width (may differ from logical width when scaled) */
  get textureWidth(): number {
    return this._textureWidth;
  }

  /** Actual texture height (may differ from logical height when scaled) */
  get textureHeight(): number {
    return this._textureHeight;
  }

  /** Current render scale (0.5-1.0) */
  get renderScale(): number {
    return this._renderScale;
  }

  /**
   * Get or create the display texture for wet edge post-processing.
   * Lazy initialization to save ~32MB VRAM for 4K canvas when wet edge is not used.
   * This texture is separate from ping-pong swap to avoid idempotency issues.
   */
  ensureDisplayTexture(): GPUTexture {
    if (!this.displayTexture) {
      this.displayTexture = this.device.createTexture({
        label: 'Wet Edge Display Texture',
        size: [this._textureWidth, this._textureHeight],
        format: this.format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.COPY_SRC,
      });
    }
    return this.displayTexture;
  }

  /**
   * Get display texture for wet edge output (lazy initialized)
   */
  get display(): GPUTexture {
    return this.ensureDisplayTexture();
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

    // Scale coordinates to texture space
    const scale = this._renderScale;
    const scaledX = Math.floor(x * scale);
    const scaledY = Math.floor(y * scale);
    const scaledW = Math.ceil(width * scale);
    const scaledH = Math.ceil(height * scale);

    // Clamp to texture bounds
    const clampedX = Math.max(0, Math.min(scaledX, this._textureWidth));
    const clampedY = Math.max(0, Math.min(scaledY, this._textureHeight));
    const clampedW = Math.min(scaledW, this._textureWidth - clampedX);
    const clampedH = Math.min(scaledH, this._textureHeight - clampedY);

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
      this._textureWidth,
      this._textureHeight,
    ]);
  }

  /**
   * Clear both buffers to transparent
   */
  clear(device: GPUDevice): void {
    const encoder = device.createCommandEncoder();

    const clearTexture = (texture: GPUTexture) => {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: texture.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.end();
    };

    clearTexture(this.textureA);
    clearTexture(this.textureB);

    device.queue.submit([encoder.finish()]);
  }

  /**
   * Resize the buffers (clears content)
   */
  resize(width: number, height: number, renderScale?: number): void {
    const newScale = renderScale ?? this._renderScale;
    const newTextureW = Math.max(1, Math.floor(width * newScale));
    const newTextureH = Math.max(1, Math.floor(height * newScale));

    if (
      width === this._width &&
      height === this._height &&
      newTextureW === this._textureWidth &&
      newTextureH === this._textureHeight
    ) {
      return;
    }

    this.textureA.destroy();
    this.textureB.destroy();
    // Destroy display texture if it was created (lazy init)
    if (this.displayTexture) {
      this.displayTexture.destroy();
      this.displayTexture = null;
    }

    this.textureA = this.device.createTexture(
      this.createTextureDescriptor(newTextureW, newTextureH, 'A')
    );
    this.textureB = this.device.createTexture(
      this.createTextureDescriptor(newTextureW, newTextureH, 'B')
    );
    this.currentSource = this.textureA;
    this.currentDest = this.textureB;

    this._width = width;
    this._height = height;
    this._renderScale = newScale;
    this._textureWidth = newTextureW;
    this._textureHeight = newTextureH;
  }

  /**
   * Change render scale (recreates textures if needed)
   */
  setRenderScale(scale: number): void {
    this.resize(this._width, this._height, scale);
  }

  /**
   * Release GPU resources
   */
  destroy(): void {
    this.textureA.destroy();
    this.textureB.destroy();
    // Destroy display texture if it was created (lazy init)
    if (this.displayTexture) {
      this.displayTexture.destroy();
      this.displayTexture = null;
    }
  }
}
