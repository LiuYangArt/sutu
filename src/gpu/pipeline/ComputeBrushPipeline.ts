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
import { safeWriteBuffer } from '../utils/safeGpuUpload';

// Import shader source
import computeShaderCode from '../shaders/computeBrush.wgsl?raw';

// Performance safety thresholds
const MAX_PIXELS_PER_BATCH = 2_000_000; // ~1400x1400 area
// CRITICAL: Must match WGSL MAX_SHARED_DABS (128) to prevent silent truncation!
// The shader uses shared memory: `var<workgroup> shared_dabs: array<DabData, 128>`
// If we send more than 128 dabs, shader executes `min(dab_count, 128)` and silently drops the rest.
const MAX_DABS_PER_BATCH = 128;

// Uniform buffer size in bytes (must match shader layout)
const UNIFORM_BUFFER_SIZE = 112;

// Dab data size in bytes (12 floats * 4 bytes = 48 bytes per dab)
const DAB_DATA_SIZE = 48;
const DAB_DATA_FLOATS = 12;

// We expect tiles per batch to be small for typical canvases (e.g. 5000x3000 => ~12).
// Keep a fixed-capacity uniform buffer to avoid unbounded growth on pathological inputs.
const MAX_TILES_PER_BATCH = 256;

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function shouldLogUploadDebug(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as unknown as { __gpuBrushUploadDebug?: boolean }).__gpuBrushUploadDebug);
}

function createSolidTexture1x1(
  device: GPUDevice,
  label: string,
  rgba: [number, number, number, number]
): GPUTexture {
  const texture = device.createTexture({
    label,
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    new Uint8Array(rgba),
    { bytesPerRow: 4 },
    { width: 1, height: 1 }
  );
  return texture;
}

export class ComputeBrushPipeline {
  private device: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private bindGroupLayout!: GPUBindGroupLayout;
  private uniformBuffer: GPUBuffer;
  private dabBuffer: GPUBuffer;
  private gaussianBuffer: GPUBuffer;
  private uniformStride: number;
  private dabStride: number;

  // CPU-side scratch buffers (fixed size)
  private uniformScratch: ArrayBuffer;
  private uniformScratchView: DataView;
  private dabScratch: ArrayBuffer;
  private dabScratchView: Float32Array;

  // BindGroup cache (reduce GC pressure)
  private cachedBindGroups: Map<string, GPUBindGroup> = new Map();

  // Dummy texture for pattern binding (when pattern_enabled = 0)
  // Must be compatible with sampleType: 'float' (rgba8unorm safe, rgba32float not safe without extension)
  private dummyPatternTexture: GPUTexture;
  // Dummy texture for noise binding (when noise_enabled = 0)
  private dummyNoiseTexture: GPUTexture;

  private canvasWidth: number = 0;
  private canvasHeight: number = 0;

  // Cached color blend mode
  private colorBlendMode: number = 0; // 0 = sRGB, 1 = linear

  constructor(device: GPUDevice) {
    this.device = device;

    // Uniform buffer: Block 0-4 (matches ComputeTextureBrushPipeline)
    // Size increased to 112 bytes to accommodate pattern settings
    this.uniformStride = alignTo(
      UNIFORM_BUFFER_SIZE,
      device.limits.minUniformBufferOffsetAlignment
    );
    this.uniformBuffer = device.createBuffer({
      label: 'Compute Brush Uniforms',
      size: this.uniformStride * MAX_TILES_PER_BATCH,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.uniformScratch = new ArrayBuffer(this.uniformStride * MAX_TILES_PER_BATCH);
    this.uniformScratchView = new DataView(this.uniformScratch);

    // Dab storage buffer (48 bytes per dab)
    this.dabStride = alignTo(
      MAX_DABS_PER_BATCH * DAB_DATA_SIZE,
      device.limits.minStorageBufferOffsetAlignment
    );
    this.dabBuffer = device.createBuffer({
      label: 'Compute Brush Dabs',
      size: this.dabStride,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.dabScratch = new ArrayBuffer(this.dabStride);
    this.dabScratchView = new Float32Array(this.dabScratch);

    // Gaussian LUT buffer
    this.gaussianBuffer = device.createBuffer({
      label: 'Compute Brush Gaussian LUT',
      size: erfLUT.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.gaussianBuffer, 0, erfLUT.buffer);

    // Initialize dummy pattern texture (1x1 white)
    this.dummyPatternTexture = createSolidTexture1x1(
      device,
      'Compute Brush Dummy Pattern',
      [255, 255, 255, 255]
    );

    // Initialize dummy noise texture (1x1 mid-gray; overlay(., 0.5) is neutral)
    this.dummyNoiseTexture = createSolidTexture1x1(
      device,
      'Compute Brush Dummy Noise',
      [128, 128, 128, 255]
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
          buffer: { type: 'read-only-storage' },
        },
        // Binding 5: Pattern Texture (matches ComputeTextureBrushPipeline)
        {
          binding: 5,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float' }, // Using 'float' for filterable/bilinear
        },
        // Binding 6: Noise Texture (tileable)
        {
          binding: 6,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float' },
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
    hasPattern: boolean,
    patternTexture: GPUTexture | null,
    patternSettings: GPUPatternSettings | null,
    noiseEnabled: boolean,
    noiseStrength: number
  ): void {
    // Block 0: Bounding Box
    view.setUint32(byteOffset + 0, bbox.x, true);
    view.setUint32(byteOffset + 4, bbox.y, true);
    view.setUint32(byteOffset + 8, bbox.width, true);
    view.setUint32(byteOffset + 12, bbox.height, true);

    // Block 1: Canvas & Dab Count
    view.setUint32(byteOffset + 16, this.canvasWidth, true);
    view.setUint32(byteOffset + 20, this.canvasHeight, true);
    view.setUint32(byteOffset + 24, dabCount, true);
    view.setUint32(byteOffset + 28, this.colorBlendMode, true);

    // Block 2: Pattern Settings
    view.setUint32(byteOffset + 32, hasPattern ? 1 : 0, true); // pattern_enabled
    view.setUint32(byteOffset + 36, hasPattern && patternSettings!.invert ? 1 : 0, true); // pattern_invert
    const modeMap: Record<string, number> = {
      multiply: 0,
      subtract: 1,
      darken: 2,
      overlay: 3,
      colorDodge: 4,
      colorBurn: 5,
      linearBurn: 6,
      hardMix: 7,
      linearHeight: 8,
      height: 9,
    };
    const modeId = hasPattern ? (modeMap[patternSettings!.mode] ?? 0) : 0;
    view.setUint32(byteOffset + 40, modeId, true); // pattern_mode
    view.setFloat32(byteOffset + 44, hasPattern ? patternSettings!.scale : 100.0, true);

    // Block 3: Adjustments
    view.setFloat32(byteOffset + 48, hasPattern ? patternSettings!.brightness : 0.0, true);
    view.setFloat32(byteOffset + 52, hasPattern ? patternSettings!.contrast : 0.0, true);
    view.setFloat32(byteOffset + 56, hasPattern ? patternSettings!.depth : 0.0, true);
    view.setUint32(byteOffset + 60, 0, true); // padding

    // Block 4: Pattern Size
    if (hasPattern && patternTexture) {
      view.setFloat32(byteOffset + 64, patternTexture.width, true);
      view.setFloat32(byteOffset + 68, patternTexture.height, true);
    } else {
      view.setFloat32(byteOffset + 64, 0, true);
      view.setFloat32(byteOffset + 68, 0, true);
    }
    view.setUint32(byteOffset + 72, noiseEnabled ? 1 : 0, true);
    view.setFloat32(byteOffset + 76, noiseEnabled ? noiseStrength : 0.0, true);
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
    patternSettings: GPUPatternSettings | null = null,
    noiseTexture: GPUTexture | null = null,
    noiseEnabled: boolean = false,
    noiseStrength: number = 1.0
  ): boolean {
    if (dabs.length === 0) return true;

    const hasPattern = Boolean(patternTexture && patternSettings);
    const bindPatternTexture = hasPattern ? patternTexture! : this.dummyPatternTexture;
    const bindNoiseTexture = noiseTexture ?? this.dummyNoiseTexture;

    // This pipeline is designed to process a single batch (<= 128 dabs).
    // Callers should flush/segment to avoid exceeding MAX_DABS_PER_BATCH.
    if (dabs.length > MAX_DABS_PER_BATCH) {
      if (shouldLogUploadDebug()) {
        console.warn('[ComputeBrushPipeline] Too many dabs for single dispatch', {
          dabs: dabs.length,
          max: MAX_DABS_PER_BATCH,
        });
      }
      return false;
    }

    const bbox = this.computePreciseBoundingBox(dabs);
    if (bbox.width <= 0 || bbox.height <= 0) {
      return true;
    }

    const tiles = this.buildTiles(bbox);
    if (tiles.length === 0) {
      return true;
    }

    if (tiles.length > MAX_TILES_PER_BATCH) {
      if (shouldLogUploadDebug()) {
        console.warn('[ComputeBrushPipeline] Too many tiles for fixed uniform buffer', {
          tiles: tiles.length,
          max: MAX_TILES_PER_BATCH,
          bbox,
        });
      }
      return false;
    }

    // Upload dab data for this batch
    this.packDabDataInto(dabs, this.dabScratchView, 0);
    safeWriteBuffer({
      device: this.device,
      dstBuffer: this.dabBuffer,
      dstOffset: 0,
      src: this.dabScratch,
      srcOffset: 0,
      size: dabs.length * DAB_DATA_SIZE,
      label: 'ComputeBrush dab upload',
    });

    // Upload per-tile uniform data
    for (let t = 0; t < tiles.length; t++) {
      const tile = tiles[t]!;
      this.writeUniformData(
        this.uniformScratchView,
        t * this.uniformStride,
        tile,
        dabs.length,
        hasPattern,
        patternTexture,
        patternSettings,
        noiseEnabled,
        noiseStrength
      );
    }

    safeWriteBuffer({
      device: this.device,
      dstBuffer: this.uniformBuffer,
      dstOffset: 0,
      src: this.uniformScratch,
      srcOffset: 0,
      size: tiles.length * this.uniformStride,
      label: 'ComputeBrush uniform upload',
    });

    const bindGroup = this.getOrCreateBindGroup(
      inputTexture,
      outputTexture,
      bindPatternTexture,
      bindNoiseTexture
    );
    const pass = encoder.beginComputePass({ label: 'Compute Brush Pass' });
    pass.setPipeline(this.pipeline);

    for (let t = 0; t < tiles.length; t++) {
      const tile = tiles[t]!;
      const uniformOffset = t * this.uniformStride;
      pass.setBindGroup(0, bindGroup, [uniformOffset, 0]);
      pass.dispatchWorkgroups(Math.ceil(tile.width / 8), Math.ceil(tile.height / 8));
    }

    pass.end();
    return true;
  }

  /**
   * Get or create BindGroup (with caching for performance)
   */
  private getOrCreateBindGroup(
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    patternTexture: GPUTexture,
    noiseTexture: GPUTexture
  ): GPUBindGroup {
    const patternKey = patternTexture.label || 'pat';
    const noiseKey = noiseTexture.label || 'noi';
    const key = `${inputTexture.label || 'input'}_${outputTexture.label || 'output'}_${patternKey}_${noiseKey}`;

    let bindGroup = this.cachedBindGroups.get(key);
    if (!bindGroup) {
      bindGroup = this.device.createBindGroup({
        label: `Compute Brush BindGroup (${key})`,
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
          { binding: 4, resource: { buffer: this.gaussianBuffer } },
          { binding: 5, resource: patternTexture.createView() },
          { binding: 6, resource: noiseTexture.createView() },
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
  private packDabDataInto(dabs: DabInstanceData[], target: Float32Array, startIndex: number): void {
    for (let i = 0; i < dabs.length; i++) {
      const dab = dabs[i]!;
      const offset = startIndex + i * DAB_DATA_FLOATS;
      target[offset + 0] = dab.x;
      target[offset + 1] = dab.y;
      target[offset + 2] = dab.size; // radius
      target[offset + 3] = dab.hardness;
      target[offset + 4] = dab.r;
      target[offset + 5] = dab.g;
      target[offset + 6] = dab.b;
      target[offset + 7] = dab.dabOpacity;
      target[offset + 8] = dab.flow;
      target[offset + 9] = dab.roundness; // roundness (pre-clamped to >= 0.01)
      target[offset + 10] = dab.angleCos; // cos(angle), precomputed
      target[offset + 11] = dab.angleSin; // sin(angle), precomputed
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
    this.gaussianBuffer.destroy();
    this.dummyPatternTexture.destroy();
    this.dummyNoiseTexture.destroy();
    this.cachedBindGroups.clear();
  }
}
