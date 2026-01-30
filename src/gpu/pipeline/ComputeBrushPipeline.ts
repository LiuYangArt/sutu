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

import type { DabInstanceData, BoundingBox, GPUPatternSettings } from '../types';
import { calculateEffectiveRadius } from '../types';
import { erfLUT } from '@/utils/maskCache';
import type { ColorBlendMode } from '@/stores/settings';

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

  // Dummy texture for pattern binding (when pattern_enabled = 0)
  // Must be compatible with sampleType: 'float' (rgba8unorm safe, rgba32float not safe without extension)
  private dummyPatternTexture: GPUTexture;

  private maxDabs = 256;
  private canvasWidth: number = 0;
  private canvasHeight: number = 0;

  // Cached color blend mode
  private colorBlendMode: number = 0; // 0 = sRGB, 1 = linear

  constructor(device: GPUDevice) {
    this.device = device;

    // Uniform buffer: Block 0-4 (matches ComputeTextureBrushPipeline)
    // Size increased to 112 bytes to accommodate pattern settings
    this.uniformBuffer = device.createBuffer({
      label: 'Compute Brush Uniforms',
      size: 112, // Increased from 32
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

    // Initialize dummy pattern texture (1x1 white)
    this.dummyPatternTexture = device.createTexture({
      label: 'Compute Brush Dummy Pattern',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // Upload white pixel
    device.queue.writeTexture(
      { texture: this.dummyPatternTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 }
    );

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
        // Binding 5: Pattern Texture (matches ComputeTextureBrushPipeline)
        {
          binding: 5,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float' }, // Using 'float' for filterable/bilinear
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
    dabs: DabInstanceData[],
    patternTexture: GPUTexture | null = null,
    patternSettings: GPUPatternSettings | null = null
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
    const uniformData = new ArrayBuffer(112); // Total size 112 bytes
    const view = new DataView(uniformData);

    // Block 0: Bounding Box
    view.setUint32(0, bbox.x, true);
    view.setUint32(4, bbox.y, true);
    view.setUint32(8, bbox.width, true);
    view.setUint32(12, bbox.height, true);

    // Block 1: Canvas & Dab Count
    view.setUint32(16, this.canvasWidth, true);
    view.setUint32(20, this.canvasHeight, true);
    view.setUint32(24, dabs.length, true);
    view.setUint32(28, this.colorBlendMode, true);

    // Block 2: Pattern Settings
    const hasPattern = patternTexture && patternSettings;
    view.setUint32(32, hasPattern ? 1 : 0, true); // pattern_enabled
    view.setUint32(36, hasPattern && patternSettings!.invert ? 1 : 0, true); // pattern_invert
    // Map mode string to uint (0-8)
    // Modes: multiply(0), subtract(1), darken(2), overlay(3), color-dodge(4), color-burn(5), linear-burn(6), hard-mix(7)
    // height/linear-height map to multiply(0) for implementation simplicity or specific shader logic?
    // Shader expects u32.
    // We reuse the mapping logic:
    const modeMap: Record<string, number> = {
      multiply: 0,
      subtract: 1,
      darken: 2,
      overlay: 3,
      'color-dodge': 4,
      'color-burn': 5,
      'linear-burn': 6,
      'hard-mix': 7,
      height: 0,
      'linear-height': 0,
    };
    const modeId = hasPattern ? (modeMap[patternSettings!.mode] ?? 0) : 0;
    view.setUint32(40, modeId, true); // pattern_mode
    view.setFloat32(44, hasPattern ? patternSettings!.scale : 100.0, true); // pattern_scale

    // Block 3: Adjustments
    view.setFloat32(48, hasPattern ? patternSettings!.brightness : 0.0, true);
    view.setFloat32(52, hasPattern ? patternSettings!.contrast : 0.0, true);
    view.setFloat32(56, hasPattern ? patternSettings!.depth : 0.0, true);
    view.setUint32(60, 0, true); // padding

    // Block 4: Pattern Size
    if (patternTexture) {
      view.setFloat32(64, patternTexture.width, true);
      view.setFloat32(68, patternTexture.height, true);
    } else {
      view.setFloat32(64, 0, true);
      view.setFloat32(68, 0, true);
    }
    view.setUint32(72, 0, true); // padding
    view.setUint32(76, 0, true); // padding

    // Write buffer
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    // Upload dab data
    const dabData = this.packDabData(dabs);
    this.device.queue.writeBuffer(this.dabBuffer, 0, dabData.buffer);

    // Get or create BindGroup
    const bindGroup = this.getOrCreateBindGroup(inputTexture, outputTexture, patternTexture);

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
    dabs: DabInstanceData[],
    patternTexture: GPUTexture | null = null,
    patternSettings: GPUPatternSettings | null = null
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
      const success = this.dispatch(
        encoder,
        currentInput,
        currentOutput,
        batch,
        patternTexture,
        patternSettings
      );
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
   */
  private getOrCreateBindGroup(
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    patternTexture: GPUTexture | null = null
  ): GPUBindGroup {
    // Cache key includes pattern texture ID (if present)
    const patternKey = patternTexture ? patternTexture.label || 'pat' : 'none';
    const key = `${inputTexture.label || 'input'}_${outputTexture.label || 'output'}_${patternKey}`;

    // Create dummy 1x1 pattern texture if none provided (needed for binding)
    const actualPatternTexture = patternTexture;
    if (!actualPatternTexture) {
      // Create a 1x1 white texture as placeholder
      // Check if we have a cached dummy, otherwise create one (should act as singleton)
      // ...For now, assume device can handle null? No, WebGPU doesn't allow unbound entries if logic uses it?
      // Actually, logic is gated by `pattern_enabled`.
      // But the binding must exist.
      // We can create a dummy 1x1 texture on the fly or reuse one.
      // Let's rely on a getter for a shared dummy?
      // For simplicity in this edit, creating a new one or reusing existing is tricky in "replace".
      // BUT, ComputeTextureBrushPipeline likely handles this.
      // Wait, binding must be populated.
      // I will assume the caller passes a valid dummy if pattern is null, OR I create one here.
      // Creating one here is safer.
      // Since I can't easily add a property in this edit, I will create one locally or reuse.
      // BETTER: Assume caller (GPUStrokeAccumulator) might pass null, so handle it.
    }

    // HACK: If no pattern texture, we MUST bind something.
    // GPUStrokeAccumulator should ideally provide a dummy.
    // But if I create one here, I risk leaking it if not destroyed.
    // Let's assume inputTexture can be reused? No, dimensions mismatch.
    // Let's try to bind inputTexture as patternTexture if null?
    // It's a float texture.
    // It might work as a placeholder if shader gated.
    // But binding 5 is "texture_2d<f32>".
    const bindTexture = actualPatternTexture || this.dummyPatternTexture;
    // ^ Potentially dangerous if input is storage? No, input is binding 2 (sampled).

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
          { binding: 5, resource: bindTexture.createView() },
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
      data[offset + 9] = dab.roundness; // roundness (pre-clamped to >= 0.01)
      data[offset + 10] = dab.angleCos; // cos(angle), precomputed
      data[offset + 11] = dab.angleSin; // sin(angle), precomputed
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
    this.dummyPatternTexture.destroy();
    this.cachedBindGroups.clear();
  }
}
