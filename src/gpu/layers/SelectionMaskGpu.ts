export class SelectionMaskGpu {
  private device: GPUDevice;
  private texture: GPUTexture | null = null;
  private view: GPUTextureView | null = null;
  private width: number = 0;
  private height: number = 0;
  private maskCanvas: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D;

  constructor(device: GPUDevice) {
    this.device = device;
    this.maskCanvas = document.createElement('canvas');
    const ctx = this.maskCanvas.getContext('2d');
    if (!ctx) {
      throw new Error('[SelectionMaskGpu] Failed to create mask canvas context');
    }
    this.maskCtx = ctx;
  }

  getTextureView(): GPUTextureView | null {
    return this.view;
  }

  update(mask: ImageData | null): void {
    if (!mask) {
      this.texture?.destroy();
      this.texture = null;
      this.view = null;
      this.width = 0;
      this.height = 0;
      return;
    }

    if (mask.width !== this.width || mask.height !== this.height || !this.texture) {
      this.texture?.destroy();
      this.texture = this.device.createTexture({
        label: 'Selection Mask',
        size: [mask.width, mask.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.view = this.texture.createView();
      this.width = mask.width;
      this.height = mask.height;
      this.maskCanvas.width = mask.width;
      this.maskCanvas.height = mask.height;
    }

    this.maskCtx.putImageData(mask, 0, 0);
    this.device.queue.copyExternalImageToTexture(
      { source: this.maskCanvas },
      { texture: this.texture! },
      { width: mask.width, height: mask.height }
    );
  }
}
