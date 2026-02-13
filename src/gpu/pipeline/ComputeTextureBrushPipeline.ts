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
import { safeWriteBuffer } from '../utils/safeGpuUpload';

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

export class ComputeTextureBrushPipeline {
  private device: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private bindGroupLayout!: GPUBindGroupLayout;
  private uniformBuffer: GPUBuffer;
  private dabBuffer: GPUBuffer;
  private dummyPatternTexture: GPUTexture;
  private dummyNoiseTexture: GPUTexture;
  private uniformStride: number;
  private dabStride: number;

  // CPU-side scratch buffers (fixed size)
  private uniformScratch: ArrayBuffer;
  private uniformScratchView: DataView;
  private dabScratch: ArrayBuffer;
  private dabScratchView: Float32Array;

  // BindGroup cache (reduce GC pressure)
  // Key format: "inputLabel_outputLabel_brushTextureLabel_patternTextureLabel"
  private cachedBindGroups: Map<string, GPUBindGroup> = new Map();

  private canvasWidth: number = 0;
  private canvasHeight: number = 0;

  constructor(device: GPUDevice) {
    this.device = device;

    // Uniform buffer
    this.uniformStride = alignTo(
      UNIFORM_BUFFER_SIZE,
      device.limits.minUniformBufferOffsetAlignment
    );
    this.uniformBuffer = device.createBuffer({
      label: 'Compute Texture Brush Uniforms',
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
      label: 'Compute Texture Brush Dabs',
      size: this.dabStride,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.dabScratch = new ArrayBuffer(this.dabStride);
    this.dabScratchView = new Float32Array(this.dabScratch);

    // Create dummy 1x1 white texture for bind group validity when no pattern is used
    this.dummyPatternTexture = createSolidTexture1x1(
      device,
      'Dummy Pattern Texture',
      [255, 255, 255, 255]
    );

    // Initialize dummy noise texture (1x1 mid-gray; overlay(., 0.5) is neutral)
    this.dummyNoiseTexture = createSolidTexture1x1(
      device,
      'Dummy Noise Texture',
      [128, 128, 128, 255]
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
          storageTexture: { access: 'write-only', format: 'rgba16float' },
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
        {
          binding: 6,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float' }, // Noise texture
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
    patternSettings: GPUPatternSettings | null,
    noiseEnabled: boolean,
    noiseStrength: number
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
    view.setUint32(byteOffset + 28, 1, true); // Fixed linear mode

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
      view.setUint32(byteOffset + 60, patternSettings.textureEachTip ? 1 : 0, true);

      // Block 4
      view.setFloat32(byteOffset + 64, patternTexture.width, true);
      view.setFloat32(byteOffset + 68, patternTexture.height, true);
    } else {
      view.setUint32(byteOffset + 32, 0, true);
      view.setFloat32(byteOffset + 64, 0, true);
      view.setFloat32(byteOffset + 68, 0, true);
    }

    // Block 5: Noise (overlay on tip alpha)
    view.setUint32(byteOffset + 72, noiseEnabled ? 1 : 0, true);
    view.setFloat32(byteOffset + 76, noiseEnabled ? noiseStrength : 0.0, true);
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
    patternSettings: GPUPatternSettings | null = null,
    noiseTexture: GPUTexture | null = null,
    noiseEnabled: boolean = false,
    noiseStrength: number = 1.0
  ): boolean {
    if (dabs.length === 0) return true;

    const usePattern =
      patternTexture !== null && patternSettings !== null && patternSettings.patternId !== null;
    const activePatternTexture = usePattern ? patternTexture! : this.dummyPatternTexture;
    const activeNoiseTexture = noiseTexture ?? this.dummyNoiseTexture;

    // This pipeline is designed to process a single batch (<= 128 dabs).
    // Callers should flush/segment to avoid exceeding MAX_DABS_PER_BATCH.
    if (dabs.length > MAX_DABS_PER_BATCH) {
      if (shouldLogUploadDebug()) {
        console.warn('[ComputeTextureBrushPipeline] Too many dabs for single dispatch', {
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
        console.warn('[ComputeTextureBrushPipeline] Too many tiles for fixed uniform buffer', {
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
      label: 'ComputeTextureBrush dab upload',
    });

    // Upload per-tile uniform data
    for (let t = 0; t < tiles.length; t++) {
      const tile = tiles[t]!;
      this.writeUniformData(
        this.uniformScratchView,
        t * this.uniformStride,
        tile,
        dabs.length,
        usePattern,
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
      label: 'ComputeTextureBrush uniform upload',
    });

    const bindGroup = this.getOrCreateBindGroup(
      inputTexture,
      outputTexture,
      brushTexture,
      activePatternTexture,
      activeNoiseTexture
    );
    const pass = encoder.beginComputePass({ label: 'Compute Texture Brush Pass' });
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
   * Get or create BindGroup with caching
   */
  private getOrCreateBindGroup(
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    brushTexture: GPUBrushTexture,
    patternTexture: GPUTexture,
    noiseTexture: GPUTexture
  ): GPUBindGroup {
    const brushLabel = brushTexture.texture.label || 'brush';
    const patternLabel = patternTexture.label || 'none';
    const noiseLabel = noiseTexture.label || 'noise';
    const key = `${inputTexture.label || 'inp'}_${outputTexture.label || 'out'}_${brushLabel}_${patternLabel}_${noiseLabel}`;

    let bindGroup = this.cachedBindGroups.get(key);
    if (!bindGroup) {
      bindGroup = this.device.createBindGroup({
        label: `Compute Texture Brush BindGroup (${key})`,
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
          { binding: 4, resource: brushTexture.view },
          { binding: 5, resource: patternTexture.createView() },
          { binding: 6, resource: noiseTexture.createView() },
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
      const safeTexW = Math.max(1, dab.texWidth);
      const safeTexH = Math.max(1, dab.texHeight);
      const texAspect = safeTexW / safeTexH;
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
    this.dummyNoiseTexture.destroy();
    this.cachedBindGroups.clear();
  }
}
