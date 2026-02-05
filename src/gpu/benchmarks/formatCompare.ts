import formatCompareShader from '../shaders/formatCompare.wgsl?raw';
import { alignTo } from '../utils/textureCopyRect';

export interface FormatCompareOptions {
  size?: number;
  ditherStrength?: number;
  includeLinearNoDither?: boolean;
}

export interface FormatCompareImage {
  name: string;
  pngBytes: Uint8Array;
  width: number;
  height: number;
}

export interface FormatCompareResult {
  width: number;
  height: number;
  images: FormatCompareImage[];
}

const DEFAULT_SIZE = 1024;
const DEFAULT_DITHER_STRENGTH = 1.0;

function createPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
  const shaderModule = device.createShaderModule({
    label: 'Format Compare Shader',
    code: formatCompareShader,
  });

  return device.createRenderPipeline({
    label: `Format Compare Pipeline (${format})`,
    layout: 'auto',
    vertex: { module: shaderModule, entryPoint: 'vs_main' },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [{ format }],
    },
    primitive: { topology: 'triangle-list' },
  });
}

function createRenderTarget(device: GPUDevice, size: number, format: GPUTextureFormat): GPUTexture {
  return device.createTexture({
    label: `Format Compare Target (${format})`,
    size: [size, size],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
}

function updateUniforms(
  device: GPUDevice,
  buffer: GPUBuffer,
  size: number,
  applyDither: boolean,
  ditherStrength: number
): void {
  const data = new ArrayBuffer(16);
  const u32 = new Uint32Array(data);
  const f32 = new Float32Array(data);
  u32[0] = size;
  u32[1] = size;
  u32[2] = applyDither ? 1 : 0;
  f32[3] = ditherStrength;
  device.queue.writeBuffer(buffer, 0, data);
}

function renderPattern(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  uniformBuffer: GPUBuffer,
  target: GPUTexture
): void {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: target.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(6, 1, 0, 0);
  pass.end();

  device.queue.submit([encoder.finish()]);
}

async function readTextureToRgba8(
  device: GPUDevice,
  texture: GPUTexture,
  size: number
): Promise<Uint8Array> {
  const bytesPerRow = alignTo(size * 4, 256);
  const bufferSize = bytesPerRow * size;
  const readbackBuffer = device.createBuffer({
    label: 'Format Compare Readback',
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer: readbackBuffer, bytesPerRow }, [size, size]);
  device.queue.submit([encoder.finish()]);

  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const mapped = readbackBuffer.getMappedRange();
  const src = new Uint8Array(mapped);
  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * bytesPerRow;
    const dstStart = y * size * 4;
    data.set(src.subarray(rowStart, rowStart + size * 4), dstStart);
  }

  readbackBuffer.unmap();
  readbackBuffer.destroy();
  return data;
}

function linearToSrgbChannel(value: number): number {
  const c = value / 255;
  const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(srgb * 255)));
}

function convertLinearToSrgb(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 4) {
    out[i] = linearToSrgbChannel(bytes[i] ?? 0);
    out[i + 1] = linearToSrgbChannel(bytes[i + 1] ?? 0);
    out[i + 2] = linearToSrgbChannel(bytes[i + 2] ?? 0);
    out[i + 3] = bytes[i + 3] ?? 255;
  }
  return out;
}

async function encodePngBytes(
  width: number,
  height: number,
  rgba: Uint8Array
): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable');
  }

  const clamped = new Uint8ClampedArray(rgba);
  const imageData = new ImageData(clamped, width, height);
  ctx.putImageData(imageData, 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error('Failed to encode PNG'));
    }, 'image/png');
  });

  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

export async function runFormatCompare(
  device: GPUDevice,
  options: FormatCompareOptions = {}
): Promise<FormatCompareResult> {
  const size = options.size ?? DEFAULT_SIZE;
  const ditherStrength = options.ditherStrength ?? DEFAULT_DITHER_STRENGTH;
  const includeLinearNoDither = options.includeLinearNoDither ?? true;

  const pipelineLinear = createPipeline(device, 'rgba8unorm');
  const pipelineSrgb = createPipeline(device, 'rgba8unorm-srgb');
  const uniformBuffer = device.createBuffer({
    label: 'Format Compare Uniforms',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const textures: Array<{ name: string; texture: GPUTexture; needsSrgb: boolean }> = [];

  if (includeLinearNoDither) {
    const tex = createRenderTarget(device, size, 'rgba8unorm');
    updateUniforms(device, uniformBuffer, size, false, ditherStrength);
    renderPattern(device, pipelineLinear, uniformBuffer, tex);
    textures.push({ name: 'linear-no-dither', texture: tex, needsSrgb: true });
  }

  {
    const tex = createRenderTarget(device, size, 'rgba8unorm');
    updateUniforms(device, uniformBuffer, size, true, ditherStrength);
    renderPattern(device, pipelineLinear, uniformBuffer, tex);
    textures.push({ name: 'linear-dither', texture: tex, needsSrgb: true });
  }

  {
    const tex = createRenderTarget(device, size, 'rgba8unorm-srgb');
    updateUniforms(device, uniformBuffer, size, false, ditherStrength);
    renderPattern(device, pipelineSrgb, uniformBuffer, tex);
    textures.push({ name: 'srgb', texture: tex, needsSrgb: false });
  }

  const images: FormatCompareImage[] = [];
  for (const entry of textures) {
    const raw = await readTextureToRgba8(device, entry.texture, size);
    const srgbBytes = entry.needsSrgb ? convertLinearToSrgb(raw) : raw;
    const pngBytes = await encodePngBytes(size, size, srgbBytes);
    images.push({ name: entry.name, pngBytes, width: size, height: size });
    entry.texture.destroy();
  }

  uniformBuffer.destroy();

  return { width: size, height: size, images };
}
