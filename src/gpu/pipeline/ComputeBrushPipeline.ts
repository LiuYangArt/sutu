/**
 * ComputeBrushPipeline - WebGPU Compute Pipeline for Batched Dab Rendering
 *
 * Replaces per-dab render passes with a single compute dispatch:
 * - 64 dabs → 1 compute dispatch (vs 64 render passes)
 * - Only processes pixels within bounding box
 * - Uses shared memory for dab data caching
 *
 * Performance target: P99 frame time < 25ms (vs ~68ms with render pipeline)
 */

import type { DabInstanceData, BoundingBox } from '../types';
import { calculateEffectiveRadius } from '../types';
import { erfLUT } from '@/utils/maskCache';
import type { ColorBlendMode } from '@/stores/tool';

// Import shader source
import computeShaderCode from '../shaders/computeBrush.wgsl?raw';

// Performance safety thresholds
const MAX_PIXELS_PER_BATCH = 2_000_000; // ~1400x1400 area
// CRITICAL: Must match WGSL MAX_SHARED_DABS (128) to prevent silent truncation!
// The shader uses shared memory: `var<workgroup> shared_dabs: array<DabData, 128>`
// If we send more than 128 dabs, shader executes `min(dab_count, 128)` and silently drops the rest.
const MAX_DABS_PER_BATCH = 128;

// Dab data size in bytes (12 floats * 4 bytes = 48 bytes per dab)
const DAB_DATA_SIZE = 48;
const DAB_DATA_FLOATS = 12;

export class ComputeBrushPipeline {
  private device: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private bindGroupLayout!: GPUBindGroupLayout;
  private uniformBuffer: GPUBuffer;
  private dabBuffer: GPUBuffer;
  private gaussianBuffer: GPUBuffer;

  // BindGroup cache (reduce GC pressure)
  private cachedBindGroups: Map<string, GPUBindGroup> = new Map();

  private maxDabs = 256;
  private canvasWidth: number = 0;
  private canvasHeight: number = 0;

  // Cached color blend mode
  private colorBlendMode: number = 0; // 0 = sRGB, 1 = linear

  constructor(device: GPUDevice) {
    this.device = device;

    // Uniform buffer: bbox_offset(8) + bbox_size(8) + canvas_size(8) + dab_count(4) + blend_mode(4) = 32 bytes
    this.uniformBuffer = device.createBuffer({
      label: 'Compute Brush Uniforms',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Dab storage buffer (48 bytes per dab)
    this.dabBuffer = device.createBuffer({
      label: 'Compute Brush Dabs',
      size: this.maxDabs * DAB_DATA_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Gaussian LUT buffer
    this.gaussianBuffer = device.createBuffer({
      label: 'Compute Brush Gaussian LUT',
      size: erfLUT.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.gaussianBuffer, 0, erfLUT.buffer);

    this.initPipeline();
  }

  private initPipeline(): void {
    // Bind group layout
    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: 'Compute Brush Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
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
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });

    this.pipeline = this.device.createComputePipeline({
      label: 'Compute Brush Pipeline',
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      compute: {
        module: this.device.createShaderModule({
          label: 'Compute Brush Shader',
          code: computeShaderCode,
        }),
        entryPoint: 'main',
      },
    });
  }

  /**
   * Update canvas size (for bounds protection)
   */
  updateCanvasSize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
    // Clear cached BindGroups (texture size may have changed)
    this.cachedBindGroups.clear();
  }

  /**
   * Update color blend mode
   */
  updateColorBlendMode(mode: ColorBlendMode): void {
    this.colorBlendMode = mode === 'linear' ? 1 : 0;
  }

  /**
   * Execute batch rendering
   * @returns true if compute path was used, false if fallback needed
   */
  dispatch(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    dabs: DabInstanceData[]
  ): boolean {
    if (dabs.length === 0) return true;

    // Check if batch split needed (too many dabs)
    if (dabs.length > MAX_DABS_PER_BATCH) {
      return this.dispatchInBatches(encoder, inputTexture, outputTexture, dabs);
    }

    // Calculate precise bounding box
    const bbox = this.computePreciseBoundingBox(dabs);
    if (bbox.width <= 0 || bbox.height <= 0) return true;

    // Check bbox pixel limit (prevent diagonal stroke issue)
    const bboxPixels = bbox.width * bbox.height;
    if (bboxPixels > MAX_PIXELS_PER_BATCH) {
      return this.dispatchInBatches(encoder, inputTexture, outputTexture, dabs);
    }

    // Ensure dab buffer is large enough
    if (dabs.length > this.maxDabs) {
      this.growDabBuffer(dabs.length);
    }

    // Upload uniforms
    const uniformData = new Uint32Array([
      bbox.x,
      bbox.y, // bbox_offset
      bbox.width,
      bbox.height, // bbox_size
      this.canvasWidth,
      this.canvasHeight, // canvas_size
      dabs.length, // dab_count
      this.colorBlendMode, // color_blend_mode
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    // Upload dab data
    const dabData = this.packDabData(dabs);
    this.device.queue.writeBuffer(this.dabBuffer, 0, dabData.buffer);

    // Get or create BindGroup
    const bindGroup = this.getOrCreateBindGroup(inputTexture, outputTexture);

    // Dispatch
    const pass = encoder.beginComputePass({ label: 'Compute Brush Pass' });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);

    const workgroupsX = Math.ceil(bbox.width / 8);
    const workgroupsY = Math.ceil(bbox.height / 8);
    pass.dispatchWorkgroups(workgroupsX, workgroupsY);

    pass.end();

    return true;
  }

  /**
   * Split dispatch when dab count or bbox is too large
   *
   * IMPORTANT: Uses proper ping-pong swapping between batches.
   * Each batch reads from currentInput and writes to currentOutput,
   * then we swap for the next batch to ensure sequential accumulation.
   */
  private dispatchInBatches(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    dabs: DabInstanceData[]
  ): boolean {
    const batchSize = MAX_DABS_PER_BATCH;
    const batchCount = Math.ceil(dabs.length / batchSize);

    // Compute bounding box for ALL dabs (needed for proper copy between batches)
    const allDabsBbox = this.computePreciseBoundingBox(dabs);

    // Mutable references for ping-pong swapping
    let currentInput = inputTexture;
    let currentOutput = outputTexture;

    for (let i = 0; i < dabs.length; i += batchSize) {
      const batch = dabs.slice(i, i + batchSize);
      const success = this.dispatch(encoder, currentInput, currentOutput, batch);
      if (!success) return false;

      // Swap for next batch (proper ping-pong)
      if (i + batchSize < dabs.length) {
        // Copy the entire affected region from output to input for next batch
        // This ensures the next batch sees the accumulated result of previous batches
        if (allDabsBbox.width > 0 && allDabsBbox.height > 0) {
          encoder.copyTextureToTexture(
            { texture: currentOutput, origin: { x: allDabsBbox.x, y: allDabsBbox.y } },
            { texture: currentInput, origin: { x: allDabsBbox.x, y: allDabsBbox.y } },
            [allDabsBbox.width, allDabsBbox.height]
          );
        }

        // Swap input/output for next iteration
        const temp = currentInput;
        currentInput = currentOutput;
        currentOutput = temp;
      }
    }

    // If we did an odd number of batches, the final result is in the original outputTexture
    // If even number of batches (and > 1), we need to ensure result is in outputTexture
    // The caller (GPUStrokeAccumulator.flushBatch) expects result in outputTexture (dest)
    // and will call swap() after. So we need to ensure the last dispatch wrote to outputTexture.
    if (batchCount > 1 && batchCount % 2 === 0) {
      // Final result is in inputTexture (original outputTexture after swaps)
      // Copy back to outputTexture
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

  /**
   * Get or create BindGroup (with caching for performance)
   * NOTE: Caching works correctly now that textures have unique labels (A/B)
   */
  private getOrCreateBindGroup(inputTexture: GPUTexture, outputTexture: GPUTexture): GPUBindGroup {
    // Use texture label as cache key (PingPong textures have unique labels A/B)
    const key = `${inputTexture.label || 'input'}_${outputTexture.label || 'output'}`;

    let bindGroup = this.cachedBindGroups.get(key);
    if (!bindGroup) {
      bindGroup = this.device.createBindGroup({
        label: `Compute Brush BindGroup (${key})`,
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: this.dabBuffer } },
          { binding: 2, resource: inputTexture.createView() },
          { binding: 3, resource: outputTexture.createView() },
          { binding: 4, resource: { buffer: this.gaussianBuffer } },
        ],
      });
      this.cachedBindGroups.set(key, bindGroup);
    }

    return bindGroup;
  }

  /**
   * Calculate precise bounding box (considering soft edge expansion)
   */
  private computePreciseBoundingBox(dabs: DabInstanceData[]): BoundingBox {
    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const dab of dabs) {
      const effectiveRadius = calculateEffectiveRadius(dab.size, dab.hardness);

      minX = Math.min(minX, dab.x - effectiveRadius);
      minY = Math.min(minY, dab.y - effectiveRadius);
      maxX = Math.max(maxX, dab.x + effectiveRadius);
      maxY = Math.max(maxY, dab.y + effectiveRadius);
    }

    // Clamp to canvas bounds with margin
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

  /**
   * Pack Dab data (48 bytes per dab, aligned to 16 bytes)
   */
  private packDabData(dabs: DabInstanceData[]): Float32Array {
    const data = new Float32Array(dabs.length * DAB_DATA_FLOATS);

    for (let i = 0; i < dabs.length; i++) {
      const dab = dabs[i]!;
      const offset = i * DAB_DATA_FLOATS;
      data[offset + 0] = dab.x;
      data[offset + 1] = dab.y;
      data[offset + 2] = dab.size; // radius
      data[offset + 3] = dab.hardness;
      data[offset + 4] = dab.r;
      data[offset + 5] = dab.g;
      data[offset + 6] = dab.b;
      data[offset + 7] = dab.dabOpacity;
      data[offset + 8] = dab.flow;
      // padding [9-11] = 0
    }

    return data;
  }

  /**
   * Grow dab buffer when needed
   */
  private growDabBuffer(minCapacity: number): void {
    const newCapacity = Math.max(this.maxDabs * 2, minCapacity);
    this.dabBuffer.destroy();
    this.dabBuffer = this.device.createBuffer({
      label: 'Compute Brush Dabs',
      size: newCapacity * DAB_DATA_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.maxDabs = newCapacity;
    // Clear cached bind groups (buffer changed)
    this.cachedBindGroups.clear();
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cachedBindGroups.clear();
  }

  /**
   * Release GPU resources
   */
  destroy(): void {
    this.uniformBuffer.destroy();
    this.dabBuffer.destroy();
    this.gaussianBuffer.destroy();
    this.cachedBindGroups.clear();
  }
}
