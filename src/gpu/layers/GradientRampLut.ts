import type { ColorStop, OpacityStop } from '@/stores/gradient';
import { sampleGradientAt } from '@/utils/gradientRenderer';
import { alignTo } from '../utils/textureCopyRect';

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function buildStopsSignature(stops: ColorStop[] | OpacityStop[]): string {
  return JSON.stringify(stops);
}

export interface GradientRampLutUpdateInput {
  colorStops: ColorStop[];
  opacityStops: OpacityStop[];
  reverse: boolean;
  transparency: boolean;
  foregroundColor: string;
  backgroundColor: string;
}

export class GradientRampLut {
  private device: GPUDevice;
  private width: number;
  private texture: GPUTexture;
  private view: GPUTextureView;
  private sampler: GPUSampler;
  private lastSignature: string | null = null;

  constructor(device: GPUDevice, width: number = 4096) {
    this.device = device;
    this.width = Math.max(2, Math.floor(width));
    this.texture = this.device.createTexture({
      label: 'Gradient Ramp LUT',
      size: [this.width, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.view = this.texture.createView();
    this.sampler = this.device.createSampler({
      label: 'Gradient Ramp LUT Sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  getTextureView(): GPUTextureView {
    return this.view;
  }

  getSampler(): GPUSampler {
    return this.sampler;
  }

  getWidth(): number {
    return this.width;
  }

  update(input: GradientRampLutUpdateInput): void {
    const signature = JSON.stringify({
      colorStops: buildStopsSignature(input.colorStops),
      opacityStops: buildStopsSignature(input.opacityStops),
      reverse: input.reverse,
      transparency: input.transparency,
      foregroundColor: input.foregroundColor,
      backgroundColor: input.backgroundColor,
    });

    if (signature === this.lastSignature) {
      return;
    }

    const data = new Uint8Array(this.width * 4);

    for (let i = 0; i < this.width; i += 1) {
      const t = i / (this.width - 1);
      const sample = sampleGradientAt(
        t,
        input.colorStops,
        input.opacityStops,
        {
          foregroundColor: input.foregroundColor,
          backgroundColor: input.backgroundColor,
        },
        {
          reverse: input.reverse,
          transparency: input.transparency,
        }
      );

      const offset = i * 4;
      data[offset] = Math.round(clamp01(sample.rgb[0]) * 255);
      data[offset + 1] = Math.round(clamp01(sample.rgb[1]) * 255);
      data[offset + 2] = Math.round(clamp01(sample.rgb[2]) * 255);
      data[offset + 3] = Math.round(clamp01(sample.alpha) * 255);
    }

    const rowBytes = this.width * 4;
    const bytesPerRow = alignTo(rowBytes, 256);
    const upload =
      bytesPerRow === rowBytes
        ? data
        : (() => {
            const padded = new Uint8Array(bytesPerRow);
            padded.set(data);
            return padded;
          })();

    this.device.queue.writeTexture(
      { texture: this.texture },
      upload,
      {
        bytesPerRow,
        rowsPerImage: 1,
      },
      {
        width: this.width,
        height: 1,
        depthOrArrayLayers: 1,
      }
    );

    this.lastSignature = signature;
  }

  destroy(): void {
    this.texture.destroy();
    this.lastSignature = null;
  }
}
