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

const alignTo = (value: number, alignment: number): number =>
  Math.ceil(value / alignment) * alignment;

export class ComputeTextureBrushPipeline {
  private device: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private bindGroupLayout!: GPUBindGroupLayout;
  private uniformBuffer: GPUBuffer;
  private dabBuffer: GPUBuffer;
  private dummyPatternTexture: GPUTexture;
  private uniformStride: number;
  private uniformCapacity = 1;
  private dabStride: number;
  private dabBatchCapacity = 1;

  // BindGroup cache (reduce GC pressure)
  // Key format: "inputLabel_outputLabel_brushTextureLabel_patternTextureLabel"
  private cachedBindGroups: Map<string, GPUBindGroup> = new Map();

  private canvasWidth: number = 0;
  private canvasHeight: number = 0;

  // Cached color blend mode
  private colorBlendMode: number = 0; // 0 = sRGB, 1 = linear

  constructor(device: GPUDevice) {
    this.device = device;

    // Uniform buffer
    this.uniformStride = alignTo(
      UNIFORM_BUFFER_SIZE,
      device.limits.minUniformBufferOffsetAlignment
    );
    this.uniformBuffer = device.createBuffer({
      label: 'Compute Texture Brush Uniforms',
      size: this.uniformStride,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Dab storage buffer (48 bytes per dab)
    this.dabStride = alignTo(
      MAX_DABS_PER_BATCH * DAB_DATA_SIZE,
      device.limits.minStorageBufferOffsetAlignment
    );
    this.dabBuffer = device.createBuffer({
      label: 'Compute Texture Brush Dabs',
      size: this.dabStride,
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

  private ensureUniformCapacity(required: number): void {
    if (required <= this.uniformCapacity) {
      return;
    }
    this.uniformCapacity = Math.max(required, this.uniformCapacity * 2);
    this.uniformBuffer.destroy();
    this.uniformBuffer = this.device.createBuffer({
      label: 'Compute Texture Brush Uniforms',
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
      label: 'Compute Texture Brush Dabs',
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
    dabCount: number,
    usePattern: boolean,
    patternTexture: GPUTexture | null,
    patternSettings: GPUPatternSettings | null
  ): void {
    // Block 0
    view.setUint32(byteOffset + 0, bbox.x, true);
    view.setUint32(byteOffset + 4, bbox.y, true);
    view.setUint32(byteOffset + 8, bbox.width, true);
    view.setUint32(byteOffset + 12, bbox.height, true);

    // Block 1
    view.setUint32(byteOffset + 16, this.canvasWidth, true);
    view.setUint32(byteOffset + 20, this.canvasHeight, true);
    view.setUint32(byteOffset + 24, dabCount, true);
    view.setUint32(byteOffset + 28, this.colorBlendMode, true);

    if (usePattern && patternSettings && patternTexture) {
      // Block 2
      view.setUint32(byteOffset + 32, 1, true); // pattern_enabled
      view.setUint32(byteOffset + 36, patternSettings.invert ? 1 : 0, true);
      view.setUint32(byteOffset + 40, this.getBlendModeId(patternSettings.mode), true);
      view.setFloat32(byteOffset + 44, patternSettings.scale, true);

      // Block 3
      view.setFloat32(byteOffset + 48, patternSettings.brightness, true);
      view.setFloat32(byteOffset + 52, patternSettings.contrast, true);
      view.setFloat32(byteOffset + 56, patternSettings.depth, true);
      view.setUint32(byteOffset + 60, 0, true); // padding

      // Block 4
      view.setFloat32(byteOffset + 64, patternTexture.width, true);
      view.setFloat32(byteOffset + 68, patternTexture.height, true);
    } else {
      view.setUint32(byteOffset + 32, 0, true);
    }
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

    const usePattern =
      patternTexture !== null && patternSettings !== null && patternSettings.patternId !== null;
    const activePatternTexture = usePattern ? patternTexture! : this.dummyPatternTexture;

    const uniformData = new ArrayBuffer(this.uniformStride * dispatchCount);
    const uniformView = new DataView(uniformData);
    let dispatchIndex = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      const tiles = tilesPerBatch[i]!;
      for (const tile of tiles) {
        this.writeUniformData(
          uniformView,
          dispatchIndex * this.uniformStride,
          tile,
          batch.length,
          usePattern,
          patternTexture,
          patternSettings
        );
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

      const bindGroup = this.getOrCreateBindGroup(
        currentInput,
        currentOutput,
        brushTexture,
        activePatternTexture
      );
      const pass = encoder.beginComputePass({ label: 'Compute Texture Brush Pass' });
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
      target[offset + 2] = dab.size; // diameter
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
