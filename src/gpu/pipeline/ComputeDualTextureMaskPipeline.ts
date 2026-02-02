/**
 * ComputeDualTextureMaskPipeline - GPU compute pipeline for secondary texture mask accumulation
 */

import type { TextureDabInstanceData, BoundingBox } from '../types';
import computeShaderCode from '../shaders/computeDualTextureMask.wgsl?raw';

const MAX_PIXELS_PER_BATCH = 2_000_000; // ~1400x1400 area
const MAX_DABS_PER_BATCH = 128;
const DAB_DATA_SIZE = 48;
const DAB_DATA_FLOATS = 12;

const UNIFORM_BUFFER_SIZE = 32;

const alignTo = (value: number, alignment: number): number =>
  Math.ceil(value / alignment) * alignment;

export class ComputeDualTextureMaskPipeline {
  private device: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private bindGroupLayout!: GPUBindGroupLayout;
  private uniformBuffer: GPUBuffer;
  private dabBuffer: GPUBuffer;
  private uniformStride: number;
  private uniformCapacity = 1;
  private dabStride: number;
  private dabBatchCapacity = 1;

  private cachedBindGroups: Map<string, GPUBindGroup> = new Map();

  private canvasWidth: number = 0;
  private canvasHeight: number = 0;

  constructor(device: GPUDevice) {
    this.device = device;

    this.uniformStride = alignTo(
      UNIFORM_BUFFER_SIZE,
      device.limits.minUniformBufferOffsetAlignment
    );
    this.uniformBuffer = device.createBuffer({
      label: 'Compute Dual Texture Mask Uniforms',
      size: this.uniformStride,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.dabStride = alignTo(
      MAX_DABS_PER_BATCH * DAB_DATA_SIZE,
      device.limits.minStorageBufferOffsetAlignment
    );
    this.dabBuffer = device.createBuffer({
      label: 'Compute Dual Texture Mask Dabs',
      size: this.dabStride,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.initPipeline();
  }

  private initPipeline(): void {
    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: 'Compute Dual Texture Mask Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage', hasDynamicOffset: true },
        },
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

  private ensureUniformCapacity(required: number): void {
    if (required <= this.uniformCapacity) {
      return;
    }
    this.uniformCapacity = Math.max(required, this.uniformCapacity * 2);
    this.uniformBuffer.destroy();
    this.uniformBuffer = this.device.createBuffer({
      label: 'Compute Dual Texture Mask Uniforms',
      size: this.uniformCapacity * this.uniformStride,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.cachedBindGroups.clear();
  }

  private ensureDabCapacity(requiredBatches: number): void {
    if (requiredBatches <= this.dabBatchCapacity) {
      return;
    }
    this.dabBatchCapacity = Math.max(requiredBatches, this.dabBatchCapacity * 2);
    this.dabBuffer.destroy();
    this.dabBuffer = this.device.createBuffer({
      label: 'Compute Dual Texture Mask Dabs',
      size: this.dabBatchCapacity * this.dabStride,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.cachedBindGroups.clear();
  }

  private buildTiles(bbox: BoundingBox): BoundingBox[] {
    const bboxPixels = bbox.width * bbox.height;
    if (bboxPixels <= MAX_PIXELS_PER_BATCH) {
      return [bbox];
    }

    const tileSize = Math.max(1, Math.floor(Math.sqrt(MAX_PIXELS_PER_BATCH)));
    const tiles: BoundingBox[] = [];
    const maxX = bbox.x + bbox.width;
    const maxY = bbox.y + bbox.height;

    for (let y = bbox.y; y < maxY; y += tileSize) {
      const height = Math.min(tileSize, maxY - y);
      for (let x = bbox.x; x < maxX; x += tileSize) {
        const width = Math.min(tileSize, maxX - x);
        if (width > 0 && height > 0) {
          tiles.push({ x, y, width, height });
        }
      }
    }

    return tiles;
  }

  private writeUniformData(
    view: DataView,
    byteOffset: number,
    bbox: BoundingBox,
    dabCount: number
  ): void {
    view.setUint32(byteOffset + 0, bbox.x, true);
    view.setUint32(byteOffset + 4, bbox.y, true);
    view.setUint32(byteOffset + 8, bbox.width, true);
    view.setUint32(byteOffset + 12, bbox.height, true);
    view.setUint32(byteOffset + 16, this.canvasWidth, true);
    view.setUint32(byteOffset + 20, this.canvasHeight, true);
    view.setUint32(byteOffset + 24, dabCount, true);
    view.setUint32(byteOffset + 28, 0, true);
  }

  dispatch(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    brushTexture: GPUTexture,
    dabs: TextureDabInstanceData[]
  ): boolean {
    if (dabs.length === 0) return true;

    const batchSize = MAX_DABS_PER_BATCH;
    const batchCount = Math.ceil(dabs.length / batchSize);
    const batches: TextureDabInstanceData[][] = [];

    for (let i = 0; i < dabs.length; i += batchSize) {
      batches.push(dabs.slice(i, i + batchSize));
    }

    const allDabsBbox = this.computePreciseBoundingBox(dabs);
    const tilesPerBatch: BoundingBox[][] = [];
    let dispatchCount = 0;

    for (const batch of batches) {
      const bbox = this.computePreciseBoundingBox(batch);
      if (bbox.width <= 0 || bbox.height <= 0) {
        tilesPerBatch.push([]);
        continue;
      }
      const tiles = this.buildTiles(bbox);
      tilesPerBatch.push(tiles);
      dispatchCount += tiles.length;
    }

    if (dispatchCount === 0) {
      return true;
    }

    this.ensureUniformCapacity(dispatchCount);
    this.ensureDabCapacity(batchCount);

    const dabData = new ArrayBuffer(this.dabStride * batchCount);
    const dabView = new Float32Array(dabData);
    for (let i = 0; i < batches.length; i++) {
      const offset = (this.dabStride / 4) * i;
      this.packDabDataInto(batches[i]!, dabView, offset);
    }
    this.device.queue.writeBuffer(this.dabBuffer, 0, dabData);

    const uniformData = new ArrayBuffer(this.uniformStride * dispatchCount);
    const uniformView = new DataView(uniformData);
    let dispatchIndex = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      const tiles = tilesPerBatch[i]!;
      for (const tile of tiles) {
        this.writeUniformData(uniformView, dispatchIndex * this.uniformStride, tile, batch.length);
        dispatchIndex++;
      }
    }
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    let currentInput = inputTexture;
    let currentOutput = outputTexture;
    let dispatchBase = 0;

    for (let i = 0; i < batches.length; i++) {
      const tiles = tilesPerBatch[i]!;
      if (tiles.length === 0) {
        continue;
      }

      const bindGroup = this.getOrCreateBindGroup(currentInput, currentOutput, brushTexture);
      const pass = encoder.beginComputePass({ label: 'Compute Dual Texture Mask Pass' });
      pass.setPipeline(this.pipeline);

      for (let t = 0; t < tiles.length; t++) {
        const tile = tiles[t]!;
        const uniformOffset = (dispatchBase + t) * this.uniformStride;
        const dabOffset = i * this.dabStride;
        pass.setBindGroup(0, bindGroup, [uniformOffset, dabOffset]);
        pass.dispatchWorkgroups(Math.ceil(tile.width / 8), Math.ceil(tile.height / 8));
      }

      pass.end();
      dispatchBase += tiles.length;

      if (i + 1 < batches.length && allDabsBbox.width > 0 && allDabsBbox.height > 0) {
        encoder.copyTextureToTexture(
          { texture: currentOutput, origin: { x: allDabsBbox.x, y: allDabsBbox.y } },
          { texture: currentInput, origin: { x: allDabsBbox.x, y: allDabsBbox.y } },
          [allDabsBbox.width, allDabsBbox.height]
        );

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
      bindGroup = this.device.createBindGroup({
        label: `Compute Dual Texture Mask BindGroup (${key})`,
        layout: this.bindGroupLayout,
        entries: [
          {
            binding: 0,
            resource: { buffer: this.uniformBuffer, offset: 0, size: this.uniformStride },
          },
          {
            binding: 1,
            resource: { buffer: this.dabBuffer, offset: 0, size: this.dabStride },
          },
          { binding: 2, resource: inputTexture.createView() },
          { binding: 3, resource: outputTexture.createView() },
          { binding: 4, resource: brushTexture.createView() },
        ],
      });
      this.cachedBindGroups.set(key, bindGroup);
    }

    return bindGroup;
  }

  private packDabDataInto(
    dabs: TextureDabInstanceData[],
    target: Float32Array,
    startIndex: number
  ): void {
    for (let i = 0; i < dabs.length; i++) {
      const dab = dabs[i]!;
      const offset = startIndex + i * DAB_DATA_FLOATS;
      target[offset + 0] = dab.x;
      target[offset + 1] = dab.y;
      target[offset + 2] = dab.size;
      target[offset + 3] = dab.roundness;
      target[offset + 4] = dab.angle;
      target[offset + 5] = dab.r;
      target[offset + 6] = dab.g;
      target[offset + 7] = dab.b;
      target[offset + 8] = dab.dabOpacity;
      target[offset + 9] = dab.flow;
      target[offset + 10] = dab.texWidth;
      target[offset + 11] = dab.texHeight;
    }
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

  destroy(): void {
    this.uniformBuffer.destroy();
    this.dabBuffer.destroy();
    this.cachedBindGroups.clear();
  }
}
