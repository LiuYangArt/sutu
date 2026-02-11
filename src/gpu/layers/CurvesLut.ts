import { alignTo } from '../utils/textureCopyRect';

export interface CurvesLutUpdateInput {
  rgbLut: Uint8Array;
  redLut: Uint8Array;
  greenLut: Uint8Array;
  blueLut: Uint8Array;
}

type CurvesLutChannel = 'rgb' | 'red' | 'green' | 'blue';

function cloneLut(input: Uint8Array): Uint8Array {
  return new Uint8Array(input);
}

function isLutEqual(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class CurvesLut {
  private device: GPUDevice;
  private width: number;
  private textures: Record<CurvesLutChannel, GPUTexture>;
  private views: Record<CurvesLutChannel, GPUTextureView>;
  private cached: Record<CurvesLutChannel, Uint8Array | null> = {
    rgb: null,
    red: null,
    green: null,
    blue: null,
  };

  constructor(device: GPUDevice, width: number = 256) {
    this.device = device;
    this.width = Math.max(2, Math.floor(width));

    this.textures = {
      rgb: this.createTexture('Curves LUT RGB'),
      red: this.createTexture('Curves LUT Red'),
      green: this.createTexture('Curves LUT Green'),
      blue: this.createTexture('Curves LUT Blue'),
    };
    this.views = {
      rgb: this.textures.rgb.createView(),
      red: this.textures.red.createView(),
      green: this.textures.green.createView(),
      blue: this.textures.blue.createView(),
    };
  }

  getTextureView(channel: CurvesLutChannel): GPUTextureView {
    return this.views[channel];
  }

  update(input: CurvesLutUpdateInput): void {
    this.writeChannel('rgb', input.rgbLut);
    this.writeChannel('red', input.redLut);
    this.writeChannel('green', input.greenLut);
    this.writeChannel('blue', input.blueLut);
  }

  destroy(): void {
    this.textures.rgb.destroy();
    this.textures.red.destroy();
    this.textures.green.destroy();
    this.textures.blue.destroy();
    this.cached.rgb = null;
    this.cached.red = null;
    this.cached.green = null;
    this.cached.blue = null;
  }

  private createTexture(label: string): GPUTexture {
    return this.device.createTexture({
      label,
      size: [this.width, 1, 1],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }

  private writeChannel(channel: CurvesLutChannel, lut: Uint8Array): void {
    if (isLutEqual(this.cached[channel], lut)) {
      return;
    }
    const normalized = new Uint8Array(this.width);
    for (let i = 0; i < this.width; i += 1) {
      normalized[i] = lut[i] ?? i;
    }

    const rowBytes = this.width;
    const bytesPerRow = alignTo(rowBytes, 256);
    const upload =
      bytesPerRow === rowBytes
        ? normalized
        : (() => {
            const padded = new Uint8Array(bytesPerRow);
            padded.set(normalized);
            return padded;
          })();

    this.device.queue.writeTexture(
      { texture: this.textures[channel] },
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
    this.cached[channel] = cloneLut(normalized);
  }
}
