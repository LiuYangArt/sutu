/**
 * ComputeDualTextureMaskPipeline - GPU compute pipeline for secondary texture mask accumulation
 */

import type { TextureDabInstanceData, BoundingBox } from '../types';
import computeShaderCode from '../shaders/computeDualTextureMask.wgsl?raw';

const MAX_DABS_PER_BATCH = 128;
const DAB_DATA_SIZE = 48;
const DAB_DATA_FLOATS = 12;

export class ComputeDualTextureMaskPipeline {
  private device: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private bindGroupLayout!: GPUBindGroupLayout;
  private uniformBuffer: GPUBuffer;
  private dabBuffer: GPUBuffer;

  private cachedBindGroups: Map<string, GPUBindGroup> = new Map();
  private debugFirstBindGroup: boolean = false;

  private maxDabs = 256;
  private canvasWidth: number = 0;
  private canvasHeight: number = 0;

  constructor(device: GPUDevice) {
    this.device = device;

    this.uniformBuffer = device.createBuffer({
      label: 'Compute Dual Texture Mask Uniforms',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.dabBuffer = device.createBuffer({
      label: 'Compute Dual Texture Mask Dabs',
      size: this.maxDabs * DAB_DATA_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.initPipeline();
  }

  private initPipeline(): void {
    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: 'Compute Dual Texture Mask Bind Group Layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba32float' },
        },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      ],
    });

    this.pipeline = this.device.createComputePipeline({
      label: 'Compute Dual Texture Mask Pipeline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      compute: {
        module: this.device.createShaderModule({
          label: 'Compute Dual Texture Mask Shader',
          code: computeShaderCode,
        }),
        entryPoint: 'main',
      },
    });
  }

  updateCanvasSize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.cachedBindGroups.clear();
  }

  dispatch(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    brushTexture: GPUTexture,
    dabs: TextureDabInstanceData[]
  ): boolean {
    if (dabs.length === 0) return true;

    if (dabs.length > MAX_DABS_PER_BATCH) {
      return this.dispatchInBatches(encoder, inputTexture, outputTexture, brushTexture, dabs);
    }

    const bbox = this.computePreciseBoundingBox(dabs);
    if (bbox.width <= 0 || bbox.height <= 0) return true;

    if (dabs.length > this.maxDabs) {
      this.growDabBuffer(dabs.length);
    }

    const uniformData = new ArrayBuffer(32);
    const u32View = new Uint32Array(uniformData);
    u32View[0] = bbox.x;
    u32View[1] = bbox.y;
    u32View[2] = bbox.width;
    u32View[3] = bbox.height;
    u32View[4] = this.canvasWidth;
    u32View[5] = this.canvasHeight;
    u32View[6] = dabs.length;
    u32View[7] = 0;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    const dabData = this.packDabData(dabs);
    this.device.queue.writeBuffer(this.dabBuffer, 0, dabData.buffer);

    const bindGroup = this.getOrCreateBindGroup(inputTexture, outputTexture, brushTexture);

    const pass = encoder.beginComputePass({ label: 'Compute Dual Texture Mask Pass' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);

    const workgroupsX = Math.ceil(bbox.width / 8);
    const workgroupsY = Math.ceil(bbox.height / 8);
    pass.dispatchWorkgroups(workgroupsX, workgroupsY);
    pass.end();

    return true;
  }

  private dispatchInBatches(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    brushTexture: GPUTexture,
    dabs: TextureDabInstanceData[]
  ): boolean {
    const batchSize = MAX_DABS_PER_BATCH;
    const batchCount = Math.ceil(dabs.length / batchSize);
    const allDabsBbox = this.computePreciseBoundingBox(dabs);

    let currentInput = inputTexture;
    let currentOutput = outputTexture;

    for (let i = 0; i < dabs.length; i += batchSize) {
      const batch = dabs.slice(i, i + batchSize);
      const success = this.dispatch(encoder, currentInput, currentOutput, brushTexture, batch);
      if (!success) return false;

      if (i + batchSize < dabs.length) {
        if (allDabsBbox.width > 0 && allDabsBbox.height > 0) {
          encoder.copyTextureToTexture(
            { texture: currentOutput, origin: { x: allDabsBbox.x, y: allDabsBbox.y } },
            { texture: currentInput, origin: { x: allDabsBbox.x, y: allDabsBbox.y } },
            [allDabsBbox.width, allDabsBbox.height]
          );
        }

        const temp = currentInput;
        currentInput = currentOutput;
        currentOutput = temp;
      }
    }

    if (batchCount > 1 && batchCount % 2 === 0) {
      if (allDabsBbox.width > 0 && allDabsBbox.height > 0) {
        encoder.copyTextureToTexture(
          { texture: currentOutput, origin: { x: allDabsBbox.x, y: allDabsBbox.y } },
          { texture: outputTexture, origin: { x: allDabsBbox.x, y: allDabsBbox.y } },
          [allDabsBbox.width, allDabsBbox.height]
        );
      }
    }

    return true;
  }

  private getOrCreateBindGroup(
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    brushTexture: GPUTexture
  ): GPUBindGroup {
    const key = `${inputTexture.label || 'input'}_${outputTexture.label || 'output'}_${
      brushTexture.label || 'brush'
    }`;

    let bindGroup = this.cachedBindGroups.get(key);
    if (!bindGroup) {
      let debugStart = 0;
      if (!this.debugFirstBindGroup) {
        this.debugFirstBindGroup = true;
        debugStart = performance.now();
        console.log('[ComputeDualTextureMaskPipeline] First bind group create start');
      }
      bindGroup = this.device.createBindGroup({
        label: `Compute Dual Texture Mask BindGroup (${key})`,
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: this.dabBuffer } },
          { binding: 2, resource: inputTexture.createView() },
          { binding: 3, resource: outputTexture.createView() },
          { binding: 4, resource: brushTexture.createView() },
        ],
      });
      if (debugStart > 0) {
        console.log(
          `[ComputeDualTextureMaskPipeline] First bind group create end: ${(performance.now() - debugStart).toFixed(2)}ms`
        );
      }
      this.cachedBindGroups.set(key, bindGroup);
    }

    return bindGroup;
  }

  private packDabData(dabs: TextureDabInstanceData[]): Float32Array {
    const data = new Float32Array(dabs.length * DAB_DATA_FLOATS);

    for (let i = 0; i < dabs.length; i++) {
      const dab = dabs[i]!;
      const offset = i * DAB_DATA_FLOATS;
      data[offset + 0] = dab.x;
      data[offset + 1] = dab.y;
      data[offset + 2] = dab.size;
      data[offset + 3] = dab.roundness;
      data[offset + 4] = dab.angle;
      data[offset + 5] = dab.r;
      data[offset + 6] = dab.g;
      data[offset + 7] = dab.b;
      data[offset + 8] = dab.dabOpacity;
      data[offset + 9] = dab.flow;
      data[offset + 10] = dab.texWidth;
      data[offset + 11] = dab.texHeight;
    }

    return data;
  }

  private computePreciseBoundingBox(dabs: TextureDabInstanceData[]): BoundingBox {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const dab of dabs) {
      const halfSize = dab.size / 2;
      minX = Math.min(minX, dab.x - halfSize);
      minY = Math.min(minY, dab.y - halfSize);
      maxX = Math.max(maxX, dab.x + halfSize);
      maxY = Math.max(maxY, dab.y + halfSize);
    }

    const margin = 2;
    const x = Math.max(0, Math.floor(minX) - margin);
    const y = Math.max(0, Math.floor(minY) - margin);
    const right = Math.min(this.canvasWidth, Math.ceil(maxX) + margin);
    const bottom = Math.min(this.canvasHeight, Math.ceil(maxY) + margin);

    return {
      x,
      y,
      width: Math.max(0, right - x),
      height: Math.max(0, bottom - y),
    };
  }

  private growDabBuffer(required: number): void {
    this.maxDabs = Math.max(this.maxDabs * 2, required);
    this.dabBuffer.destroy();
    this.dabBuffer = this.device.createBuffer({
      label: 'Compute Dual Texture Mask Dabs',
      size: this.maxDabs * DAB_DATA_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.cachedBindGroups.clear();
  }

  destroy(): void {
    this.uniformBuffer.destroy();
    this.dabBuffer.destroy();
    this.cachedBindGroups.clear();
  }
}
