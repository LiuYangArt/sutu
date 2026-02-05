export interface M0TextureResult {
  size: number;
  format: GPUTextureFormat;
  createMs: number;
  clearMs: number;
}

export interface M0AllocationProbe {
  size: number;
  format: GPUTextureFormat;
  allocated: number;
  totalBytes: number;
}

export interface M0BaselineResult {
  textures: M0TextureResult[];
  allocationProbe: M0AllocationProbe[];
  tileEstimates: Array<{
    tileSize: number;
    tilesX: number;
    tilesY: number;
    totalTiles: number;
    approxBytes: number;
  }>;
}

const DEFAULT_SIZES = [4096, 8192];
const DEFAULT_FORMATS: GPUTextureFormat[] = ['rgba8unorm', 'rgba8unorm-srgb'];

function estimateBytes(size: number, format: GPUTextureFormat): number {
  const bpp = format === 'rgba16float' ? 8 : format === 'rgba32float' ? 16 : 4;
  return size * size * bpp;
}

function clearTexture(device: GPUDevice, texture: GPUTexture): void {
  const encoder = device.createCommandEncoder();
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
  device.queue.submit([encoder.finish()]);
}

export async function runM0Baseline(device: GPUDevice): Promise<M0BaselineResult> {
  const textures: M0TextureResult[] = [];
  const allocationProbe: M0AllocationProbe[] = [];

  for (const size of DEFAULT_SIZES) {
    for (const format of DEFAULT_FORMATS) {
      let createMs = 0;
      let clearMs = 0;
      try {
        const startCreate = performance.now();
        const texture = device.createTexture({
          label: `M0 ${format} ${size}`,
          size: [size, size],
          format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        createMs = performance.now() - startCreate;

        const startClear = performance.now();
        clearTexture(device, texture);
        await device.queue.onSubmittedWorkDone();
        clearMs = performance.now() - startClear;
        texture.destroy();
      } catch (error) {
        console.warn('[M0Baseline] texture test failed', { size, format, error });
      }

      textures.push({ size, format, createMs, clearMs });
    }
  }

  for (const size of DEFAULT_SIZES) {
    for (const format of DEFAULT_FORMATS) {
      const texturesAllocated: GPUTexture[] = [];
      let allocated = 0;
      try {
        for (let i = 0; i < 32; i += 1) {
          const texture = device.createTexture({
            label: `M0 Probe ${format} ${size} #${i}`,
            size: [size, size],
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          });
          texturesAllocated.push(texture);
          allocated += 1;
          clearTexture(device, texture);
        }
        await device.queue.onSubmittedWorkDone();
      } catch (error) {
        console.warn('[M0Baseline] allocation probe interrupted', { size, format, error });
      } finally {
        for (const tex of texturesAllocated) {
          tex.destroy();
        }
      }

      allocationProbe.push({
        size,
        format,
        allocated,
        totalBytes: allocated * estimateBytes(size, format),
      });
    }
  }

  const tileEstimates = [256, 512].map((tileSize) => {
    const tilesX = Math.ceil(4096 / tileSize);
    const tilesY = Math.ceil(4096 / tileSize);
    const totalTiles = tilesX * tilesY;
    const approxBytes = totalTiles * tileSize * tileSize * 4;
    return { tileSize, tilesX, tilesY, totalTiles, approxBytes };
  });

  return { textures, allocationProbe, tileEstimates };
}
