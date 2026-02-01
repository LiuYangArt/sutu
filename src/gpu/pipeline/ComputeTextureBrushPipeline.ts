/**
 * ComputeTextureBrushPipeline - WebGPU Compute Pipeline for Batched Texture Brush Rendering
 *
 * Replaces per-dab render passes with a single compute dispatch for texture brushes:
 * - 64 dabs → 1 compute dispatch (vs 64 render passes)
 * - Only processes pixels within bounding box
 * - Uses shared memory for dab data caching
 * - Manual bilinear interpolation for texture sampling
 *
 * Performance target: Match parametric brush compute shader (~8-12ms for 64 dabs)
 */

import type { TextureDabInstanceData, BoundingBox, GPUPatternSettings } from '../types';
import type { GPUBrushTexture } from '../resources/TextureAtlas';
import type { ColorBlendMode } from '@/stores/settings';

// Import shader source
import computeShaderCode from '../shaders/computeTextureBrush.wgsl?raw';

// Performance safety thresholds
const MAX_PIXELS_PER_BATCH = 2_000_000; // ~1400x1400 area
const MAX_DABS_PER_BATCH = 128;

// Dab data size in bytes (12 floats * 4 bytes = 48 bytes per dab)
const DAB_DATA_SIZE = 48;
const DAB_DATA_FLOATS = 12;

// Uniform buffer size (expanded for pattern settings)
// Block 0: bbox_offset(8) + bbox_size(8) = 16
// Block 1: canvas_size(8) + dab_count(4) + blend_mode(4) = 16
// Block 2: pattern_enabled(4) + invert(4) + mode(4) + scale(4) = 16
// Block 3: brightness(4) + contrast(4) + depth(4) + padding(4) = 16
// Block 4: pattern_size(8) + padding(8) = 16
// Total = 80 bytes
const UNIFORM_BUFFER_SIZE = 80;

export class ComputeTextureBrushPipeline {
  private device: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private bindGroupLayout!: GPUBindGroupLayout;
  private uniformBuffer: GPUBuffer;
  private dabBuffer: GPUBuffer;
  private dummyPatternTexture: GPUTexture;

  // BindGroup cache (reduce GC pressure)
  // Key format: "inputLabel_outputLabel_brushTextureLabel_patternTextureLabel"
  private cachedBindGroups: Map<string, GPUBindGroup> = new Map();

  private maxDabs = 256;
  private canvasWidth: number = 0;
  private canvasHeight: number = 0;

  // Cached color blend mode
  private colorBlendMode: number = 0; // 0 = sRGB, 1 = linear

  constructor(device: GPUDevice) {
    this.device = device;

    // Uniform buffer
    this.uniformBuffer = device.createBuffer({
      label: 'Compute Texture Brush Uniforms',
      size: UNIFORM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Dab storage buffer (48 bytes per dab)
    this.dabBuffer = device.createBuffer({
      label: 'Compute Texture Brush Dabs',
      size: this.maxDabs * DAB_DATA_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Create dummy 1x1 white texture for bind group validity when no pattern is used
    this.dummyPatternTexture = device.createTexture({
      label: 'Dummy Pattern Texture',
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Initialize dummy texture with white pixel
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
      label: 'Compute Texture Brush Bind Group Layout',
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
          texture: { sampleType: 'float' }, // Brush texture (rgba8unorm, filterable)
        },
        {
          binding: 5,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float' }, // Pattern texture
        },
      ],
    });

    this.pipeline = this.device.createComputePipeline({
      label: 'Compute Texture Brush Pipeline',
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      compute: {
        module: this.device.createShaderModule({
          label: 'Compute Texture Brush Shader',
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
   * Convert blend mode string to integer ID
   */
  private getBlendModeId(mode: string): number {
    switch (mode) {
      case 'multiply':
        return 0;
      case 'subtract':
        return 1;
      case 'darken':
        return 2;
      case 'overlay':
        return 3;
      case 'colorDodge':
        return 4;
      case 'colorBurn':
        return 5;
      case 'linearBurn':
        return 6;
      case 'hardMix':
        return 7;
      case 'linearHeight':
        return 8;
      case 'height':
        return 9;
      default:
        return 0; // Default to multiply
    }
  }

  /**
   * Execute batch rendering
   * @returns true if compute path was used, false if fallback needed
   */
  dispatch(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    brushTexture: GPUBrushTexture,
    dabs: TextureDabInstanceData[],
    patternTexture: GPUTexture | null = null,
    patternSettings: GPUPatternSettings | null = null
  ): boolean {
    if (dabs.length === 0) return true;

    // Check if batch split needed (too many dabs)
    if (dabs.length > MAX_DABS_PER_BATCH) {
      return this.dispatchInBatches(
        encoder,
        inputTexture,
        outputTexture,
        brushTexture,
        dabs,
        patternTexture,
        patternSettings
      );
    }

    // Calculate precise bounding box
    const bbox = this.computePreciseBoundingBox(dabs);
    if (bbox.width <= 0 || bbox.height <= 0) return true;

    // Check bbox pixel limit (prevent diagonal stroke issue)
    const bboxPixels = bbox.width * bbox.height;
    if (bboxPixels > MAX_PIXELS_PER_BATCH) {
      return this.dispatchInBatches(
        encoder,
        inputTexture,
        outputTexture,
        brushTexture,
        dabs,
        patternTexture,
        patternSettings
      );
    }

    // Ensure dab buffer is large enough
    if (dabs.length > this.maxDabs) {
      this.growDabBuffer(dabs.length);
    }

    const usePattern =
      patternTexture !== null && patternSettings !== null && patternSettings.patternId !== null;
    const activePatternTexture = usePattern ? patternTexture! : this.dummyPatternTexture;

    // Upload uniforms
    const uniformData = new Uint32Array(UNIFORM_BUFFER_SIZE / 4);

    // Block 0
    uniformData[0] = bbox.x;
    uniformData[1] = bbox.y;
    uniformData[2] = bbox.width;
    uniformData[3] = bbox.height;

    // Block 1
    uniformData[4] = this.canvasWidth;
    uniformData[5] = this.canvasHeight;
    uniformData[6] = dabs.length;
    uniformData[7] = this.colorBlendMode;

    // Pattern uniforms
    if (usePattern && patternSettings) {
      // Block 2
      uniformData[8] = 1; // pattern_enabled
      uniformData[9] = patternSettings.invert ? 1 : 0;
      uniformData[10] = this.getBlendModeId(patternSettings.mode);
      // f32 view for floats
      const floats = new Float32Array(uniformData.buffer);
      floats[11] = patternSettings.scale;

      // Block 3
      floats[12] = patternSettings.brightness;
      floats[13] = patternSettings.contrast;
      floats[14] = patternSettings.depth;
      uniformData[15] = 0; // padding

      // Block 4
      floats[16] = activePatternTexture.width;
      floats[17] = activePatternTexture.height;
    } else {
      uniformData[8] = 0; // pattern_enabled
      // padding...
    }

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    // Upload dab data
    const dabData = this.packDabData(dabs);
    this.device.queue.writeBuffer(this.dabBuffer, 0, dabData.buffer);

    // Get or create BindGroup
    const bindGroup = this.getOrCreateBindGroup(
      inputTexture,
      outputTexture,
      brushTexture,
      activePatternTexture
    );

    // Dispatch
    const pass = encoder.beginComputePass({ label: 'Compute Texture Brush Pass' });

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
   */
  private dispatchInBatches(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    brushTexture: GPUBrushTexture,
    dabs: TextureDabInstanceData[],
    patternTexture: GPUTexture | null,
    patternSettings: GPUPatternSettings | null
  ): boolean {
    const batchSize = MAX_DABS_PER_BATCH;

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
        brushTexture,
        batch,
        patternTexture,
        patternSettings
      );
      if (!success) return false;

      // Swap for next batch (proper ping-pong)
      if (i + batchSize < dabs.length) {
        // Copy the entire affected region from output to input for next batch
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

    // Final result copy back logic (same as before)
    const batchCount = Math.ceil(dabs.length / batchSize);
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

  /**
   * Get or create BindGroup with caching
   */
  private getOrCreateBindGroup(
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    brushTexture: GPUBrushTexture,
    patternTexture: GPUTexture
  ): GPUBindGroup {
    const brushLabel = brushTexture.texture.label || 'brush';
    const patternLabel = patternTexture.label || 'none';
    const key = `${inputTexture.label || 'inp'}_${outputTexture.label || 'out'}_${brushLabel}_${patternLabel}`;

    let bindGroup = this.cachedBindGroups.get(key);
    if (!bindGroup) {
      bindGroup = this.device.createBindGroup({
        label: `Compute Texture Brush BindGroup (${key})`,
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: this.dabBuffer } },
          { binding: 2, resource: inputTexture.createView() },
          { binding: 3, resource: outputTexture.createView() },
          { binding: 4, resource: brushTexture.view },
          { binding: 5, resource: patternTexture.createView() },
        ],
      });
      this.cachedBindGroups.set(key, bindGroup);
    }

    return bindGroup;
  }

  /**
   * Calculate precise bounding box for texture dabs
   */
  private computePreciseBoundingBox(dabs: TextureDabInstanceData[]): BoundingBox {
    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const dab of dabs) {
      // Calculate effective radius (considering aspect ratio and rotation)
      const texAspect = dab.texWidth / dab.texHeight;
      let halfWidth: number;
      let halfHeight: number;

      if (texAspect >= 1.0) {
        halfWidth = dab.size / 2;
        halfHeight = halfWidth / texAspect;
      } else {
        halfHeight = dab.size / 2;
        halfWidth = halfHeight * texAspect;
      }

      halfHeight = halfHeight * dab.roundness;

      // After rotation, bounding circle is the diagonal
      const effectiveRadius = Math.sqrt(halfWidth * halfWidth + halfHeight * halfHeight);

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
  private packDabData(dabs: TextureDabInstanceData[]): Float32Array {
    const data = new Float32Array(dabs.length * DAB_DATA_FLOATS);

    for (let i = 0; i < dabs.length; i++) {
      const dab = dabs[i]!;
      const offset = i * DAB_DATA_FLOATS;
      data[offset + 0] = dab.x;
      data[offset + 1] = dab.y;
      data[offset + 2] = dab.size; // diameter
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

  /**
   * Grow dab buffer when needed
   */
  private growDabBuffer(minCapacity: number): void {
    const newCapacity = Math.max(this.maxDabs * 2, minCapacity);
    this.dabBuffer.destroy();
    this.dabBuffer = this.device.createBuffer({
      label: 'Compute Texture Brush Dabs',
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
    this.dummyPatternTexture.destroy();
    this.cachedBindGroups.clear();
  }
}
