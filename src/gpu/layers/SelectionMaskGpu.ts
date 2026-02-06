import { alignTo } from '../utils/textureCopyRect';

export class SelectionMaskGpu {
  private device: GPUDevice;
  private texture: GPUTexture | null = null;
  private view: GPUTextureView | null = null;
  private width: number = 0;
  private height: number = 0;

  constructor(device: GPUDevice) {
    this.device = device;
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
        format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.view = this.texture.createView();
      this.width = mask.width;
      this.height = mask.height;
    }

    const bytesPerRow = alignTo(mask.width, 256);
    const upload = new Uint8Array(bytesPerRow * mask.height);
    const src = mask.data;

    for (let y = 0; y < mask.height; y += 1) {
      const rowOffset = y * bytesPerRow;
      const srcRow = y * mask.width * 4;
      for (let x = 0; x < mask.width; x += 1) {
        upload[rowOffset + x] = src[srcRow + x * 4 + 3] ?? 0;
      }
    }

    this.device.queue.writeTexture(
      { texture: this.texture! },
      upload,
      { bytesPerRow, rowsPerImage: mask.height },
      { width: mask.width, height: mask.height }
    );
  }
}
