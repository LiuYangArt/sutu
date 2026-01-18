/**
 * GPUStrokeAccumulator - GPU-accelerated stroke buffer
 *
 * Mirrors the CPU StrokeAccumulator API for seamless backend switching.
 * Uses WebGPU Render Pipeline with Instancing for batched dab rendering.
 *
 * Key features:
 * - Ping-Pong double buffering to avoid read/write conflicts
 * - GPU Instancing for efficient batched dab submission
 * - Alpha Darken blending implemented in fragment shader
 * - Automatic batch flushing based on count/time thresholds
 */

import type { Rect } from '@/utils/strokeBuffer';
import type { GPUDabParams, DabInstanceData, TextureDabInstanceData } from './types';
import { DAB_INSTANCE_SIZE, TEXTURE_DAB_INSTANCE_SIZE, calculateEffectiveRadius } from './types';
import { PingPongBuffer } from './resources/PingPongBuffer';
import { InstanceBuffer } from './resources/InstanceBuffer';
import { TextureInstanceBuffer } from './resources/TextureInstanceBuffer';
import { BrushPipeline } from './pipeline/BrushPipeline';
import { TextureBrushPipeline } from './pipeline/TextureBrushPipeline';
import { ComputeBrushPipeline } from './pipeline/ComputeBrushPipeline';
import { ComputeTextureBrushPipeline } from './pipeline/ComputeTextureBrushPipeline';
import { TextureAtlas } from './resources/TextureAtlas';
import { GPUProfiler, CPUTimer } from './profiler';
import { useToolStore, type ColorBlendMode, type GPURenderScaleMode } from '@/stores/tool';

export class GPUStrokeAccumulator {
  private device: GPUDevice;
  private pingPongBuffer: PingPongBuffer;
  private instanceBuffer: InstanceBuffer;
  private brushPipeline: BrushPipeline;
  private computeBrushPipeline: ComputeBrushPipeline;
  private useComputeShader: boolean = true; // Re-enabled for no-bbox test
  private profiler: GPUProfiler;

  // Texture brush resources (separate from parametric brush)
  private textureInstanceBuffer: TextureInstanceBuffer;
  private textureBrushPipeline: TextureBrushPipeline;
  private computeTextureBrushPipeline: ComputeTextureBrushPipeline;
  private textureAtlas: TextureAtlas;
  private useTextureComputeShader: boolean = true; // Enable compute shader for texture brush

  // Current stroke mode: 'parametric' or 'texture'
  private strokeMode: 'parametric' | 'texture' = 'parametric';

  private width: number;
  private height: number;
  private active: boolean = false;
  private dirtyRect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

  // Preview canvas for compatibility with existing rendering system
  private previewCanvas: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;

  // Batch timing control
  private dabsSinceLastFlush: number = 0;

  // Readback buffer for GPU → CPU transfer
  private readbackBuffer: GPUBuffer | null = null;
  private readbackBytesPerRow: number = 0;

  // Preview readback buffer (separate to avoid conflicts)
  private previewReadbackBuffer: GPUBuffer | null = null;
  private previewUpdatePending: boolean = false;
  private previewNeedsUpdate: boolean = false; // Flag to ensure final update

  // Promise-based preview update tracking (optimization 1)
  private currentPreviewPromise: Promise<void> | null = null;

  // Device lost state tracking (optimization 3)
  private deviceLost: boolean = false;

  // Cached color blend mode to avoid redundant updates
  private cachedColorBlendMode: ColorBlendMode = 'linear';

  // Cached render scale mode to avoid redundant updates
  private cachedRenderScaleMode: GPURenderScaleMode = 'off';

  // Current actual render scale (computed from mode + brush params)
  private currentRenderScale: number = 1.0;

  // Performance timing
  private cpuTimer: CPUTimer = new CPUTimer();

  constructor(device: GPUDevice, width: number, height: number) {
    this.device = device;
    this.width = width;
    this.height = height;

    // Initialize GPU resources
    this.pingPongBuffer = new PingPongBuffer(device, width, height);
    this.instanceBuffer = new InstanceBuffer(device);
    this.brushPipeline = new BrushPipeline(device);
    this.brushPipeline.updateCanvasSize(width, height);
    this.computeBrushPipeline = new ComputeBrushPipeline(device);
    this.computeBrushPipeline.updateCanvasSize(width, height);
    this.profiler = new GPUProfiler();

    // Initialize texture brush resources
    this.textureInstanceBuffer = new TextureInstanceBuffer(device);
    this.textureBrushPipeline = new TextureBrushPipeline(device);
    this.textureBrushPipeline.updateCanvasSize(width, height);
    this.computeTextureBrushPipeline = new ComputeTextureBrushPipeline(device);
    this.computeTextureBrushPipeline.updateCanvasSize(width, height);
    this.textureAtlas = new TextureAtlas(device);

    // Initialize preview canvas
    this.previewCanvas = document.createElement('canvas');
    this.previewCanvas.width = width;
    this.previewCanvas.height = height;
    const ctx = this.previewCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('[GPUStrokeAccumulator] Failed to create preview canvas context');
    }
    this.previewCtx = ctx;

    // Initialize readback buffer
    this.createReadbackBuffer();

    // Initialize profiler
    void this.profiler.init(device);

    // Setup device lost handler (optimization 3)
    void this.device.lost.then((info) => {
      console.warn('[GPUStrokeAccumulator] GPU device lost:', info.message);
      this.deviceLost = true;
    });
  }

  private createReadbackBuffer(): void {
    // Use actual texture dimensions (may be scaled)
    const texW = this.pingPongBuffer.textureWidth;
    const texH = this.pingPongBuffer.textureHeight;

    // rgba32float = 16 bytes per pixel (4 channels * 4 bytes/channel)
    // Rows must be aligned to 256 bytes
    this.readbackBytesPerRow = Math.ceil((texW * 16) / 256) * 256;
    const size = this.readbackBytesPerRow * texH;

    this.readbackBuffer = this.device.createBuffer({
      label: 'Stroke Readback Buffer',
      size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // Separate buffer for preview to avoid mapping conflicts
    this.previewReadbackBuffer = this.device.createBuffer({
      label: 'Preview Readback Buffer',
      size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }

  /** Destroy and recreate readback buffers (after texture resize) */
  private recreateReadbackBuffers(): void {
    this.readbackBuffer?.destroy();
    this.previewReadbackBuffer?.destroy();
    this.createReadbackBuffer();
  }

  /**
   * Resize the accumulator (clears content)
   */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) {
      return;
    }

    this.width = width;
    this.height = height;

    // Resize with current render scale
    this.pingPongBuffer.resize(width, height, this.currentRenderScale);
    this.brushPipeline.updateCanvasSize(
      this.pingPongBuffer.textureWidth,
      this.pingPongBuffer.textureHeight
    );
    this.computeBrushPipeline.updateCanvasSize(
      this.pingPongBuffer.textureWidth,
      this.pingPongBuffer.textureHeight
    );
    this.textureBrushPipeline.updateCanvasSize(
      this.pingPongBuffer.textureWidth,
      this.pingPongBuffer.textureHeight
    );
    this.computeTextureBrushPipeline.updateCanvasSize(
      this.pingPongBuffer.textureWidth,
      this.pingPongBuffer.textureHeight
    );

    this.previewCanvas.width = width;
    this.previewCanvas.height = height;

    this.recreateReadbackBuffers();

    this.clear();
  }

  /**
   * Begin a new stroke
   */
  beginStroke(): void {
    this.clear();
    this.active = true;
    this.dabsSinceLastFlush = 0;

    // Clear GPU buffers
    this.pingPongBuffer.clear(this.device);

    // Sync color blend mode from store
    this.syncColorBlendMode();

    // Sync render scale from store
    this.syncRenderScale();
  }

  /**
   * Sync color blend mode from store to shader uniform
   */
  private syncColorBlendMode(): void {
    const mode = useToolStore.getState().colorBlendMode;
    if (mode !== this.cachedColorBlendMode) {
      this.brushPipeline.updateColorBlendMode(mode);
      this.computeBrushPipeline.updateColorBlendMode(mode);
      this.textureBrushPipeline.updateColorBlendMode(mode);
      this.computeTextureBrushPipeline.updateColorBlendMode(mode);
      this.cachedColorBlendMode = mode;
    }
  }

  /**
   * Sync render scale from store to ping-pong buffer
   * Auto mode: downsample to 50% for soft large brushes (hardness < 70, size > 300)
   */
  private syncRenderScale(): void {
    const { gpuRenderScaleMode: mode, brushHardness, brushSize } = useToolStore.getState();

    const shouldDownsample = mode === 'auto' && brushHardness < 70 && brushSize > 300;
    const targetScale = shouldDownsample ? 0.5 : 1.0;

    if (mode !== this.cachedRenderScaleMode || targetScale !== this.currentRenderScale) {
      this.cachedRenderScaleMode = mode;
      this.currentRenderScale = targetScale;

      this.pingPongBuffer.setRenderScale(targetScale);
      this.brushPipeline.updateCanvasSize(
        this.pingPongBuffer.textureWidth,
        this.pingPongBuffer.textureHeight
      );
      this.computeBrushPipeline.updateCanvasSize(
        this.pingPongBuffer.textureWidth,
        this.pingPongBuffer.textureHeight
      );
      this.textureBrushPipeline.updateCanvasSize(
        this.pingPongBuffer.textureWidth,
        this.pingPongBuffer.textureHeight
      );
      this.computeTextureBrushPipeline.updateCanvasSize(
        this.pingPongBuffer.textureWidth,
        this.pingPongBuffer.textureHeight
      );
      this.recreateReadbackBuffers();
    }
  }

  /**
   * Clear the accumulator
   */
  clear(): void {
    this.active = false;
    this.instanceBuffer.clear();
    this.textureInstanceBuffer.clear();
    this.strokeMode = 'parametric';
    this.dirtyRect = {
      left: this.width,
      top: this.height,
      right: 0,
      bottom: 0,
    };
    this.previewCtx.clearRect(0, 0, this.width, this.height);
    this.dabsSinceLastFlush = 0;
  }

  /**
   * Check if stroke is active
   */
  isActive(): boolean {
    return this.active;
  }

  stampDab(params: GPUDabParams): void {
    if (!this.active) return;

    const rgb = this.hexToRgb(params.color);
    const scale = this.currentRenderScale;

    // Texture brush path - completely separate from parametric brush
    if (params.texture) {
      // Set stroke mode on first dab (cannot mix modes within a stroke)
      if (this.dabsSinceLastFlush === 0 && this.strokeMode === 'parametric') {
        this.strokeMode = 'texture';
      }

      // Try to set texture (may need async loading)
      if (!this.textureAtlas.setTextureSync(params.texture)) {
        // Texture not ready - trigger async load and skip this dab
        void this.textureAtlas.setTexture(params.texture);
        return;
      }

      const textureDabData: TextureDabInstanceData = {
        x: params.x * scale,
        y: params.y * scale,
        size: params.size * scale, // diameter, not radius
        roundness: params.roundness ?? 1.0,
        angle: ((params.angle ?? 0) * Math.PI) / 180, // Convert to radians
        r: rgb.r / 255,
        g: rgb.g / 255,
        b: rgb.b / 255,
        dabOpacity: params.dabOpacity ?? 1.0,
        flow: params.flow,
        texWidth: params.texture.width,
        texHeight: params.texture.height,
      };

      this.textureInstanceBuffer.push(textureDabData);
      // Dirty rect calculation for texture brush
      const halfSize = params.size / 2;
      this.expandDirtyRectTexture(params.x, params.y, halfSize);
      this.dabsSinceLastFlush++;

      return;
    }

    // Parametric brush path (unchanged)
    const radius = params.size / 2;
    const dabData: DabInstanceData = {
      x: params.x * scale,
      y: params.y * scale,
      size: radius * scale,
      hardness: params.hardness,
      r: rgb.r / 255,
      g: rgb.g / 255,
      b: rgb.b / 255,
      dabOpacity: params.dabOpacity ?? 1.0,
      flow: params.flow,
    };

    this.instanceBuffer.push(dabData);

    // Dirty rect is in logical coordinates (for preview canvas)
    this.expandDirtyRect(params.x, params.y, radius, params.hardness);
    this.dabsSinceLastFlush++;
  }

  /**
   * Expand dirty rect for texture brush (simpler calculation)
   */
  private expandDirtyRectTexture(x: number, y: number, halfSize: number): void {
    const margin = 2;
    this.dirtyRect.left = Math.min(this.dirtyRect.left, Math.floor(x - halfSize - margin));
    this.dirtyRect.top = Math.min(this.dirtyRect.top, Math.floor(y - halfSize - margin));
    this.dirtyRect.right = Math.max(this.dirtyRect.right, Math.ceil(x + halfSize + margin));
    this.dirtyRect.bottom = Math.max(this.dirtyRect.bottom, Math.ceil(y + halfSize + margin));
  }

  private expandDirtyRect(x: number, y: number, radius: number, hardness: number): void {
    const effectiveRadius = calculateEffectiveRadius(radius, hardness);
    const margin = 2;
    this.dirtyRect.left = Math.min(this.dirtyRect.left, Math.floor(x - effectiveRadius - margin));
    this.dirtyRect.top = Math.min(this.dirtyRect.top, Math.floor(y - effectiveRadius - margin));
    this.dirtyRect.right = Math.max(this.dirtyRect.right, Math.ceil(x + effectiveRadius + margin));
    this.dirtyRect.bottom = Math.max(
      this.dirtyRect.bottom,
      Math.ceil(y + effectiveRadius + margin)
    );
  }

  /**
   * Force flush pending dabs to GPU (used for benchmarking)
   */
  flush(): void {
    if (this.strokeMode === 'texture') {
      this.flushTextureBatch();
    } else {
      this.flushBatch();
    }
  }

  /**
   * Flush pending dabs to GPU using Compute Shader (optimized path)
   * or per-dab Render Pipeline (fallback path).
   */
  private flushBatch(): void {
    if (this.instanceBuffer.count === 0) {
      return;
    }

    this.cpuTimer.start();

    // 1. Get data and upload to GPU
    const dabs = this.instanceBuffer.getDabsData();
    const bbox = this.instanceBuffer.getBoundingBox();

    // Flush uploads to GPU and resets the pending/bbox counters
    const { buffer: gpuBatchBuffer } = this.instanceBuffer.flush();

    const encoder = this.device.createCommandEncoder({
      label: 'Brush Batch Encoder',
    });

    // Try compute shader path first
    if (this.useComputeShader) {
      // Compute shader: batch all dabs in single dispatch
      const dr = this.dirtyRect;
      const scale = this.currentRenderScale;

      // Copy source to dest to preserve previous strokes
      const copyX = Math.floor(dr.left * scale);
      const copyY = Math.floor(dr.top * scale);
      const copyW = Math.ceil((dr.right - dr.left) * scale);
      const copyH = Math.ceil((dr.bottom - dr.top) * scale);
      if (copyW > 0 && copyH > 0) {
        this.pingPongBuffer.copyRect(encoder, copyX, copyY, copyW, copyH);
      }

      // Single dispatch for all dabs
      const success = this.computeBrushPipeline.dispatch(
        encoder,
        this.pingPongBuffer.source,
        this.pingPongBuffer.dest,
        dabs
      );

      if (success) {
        // Swap so next flushBatch reads from the updated texture
        this.pingPongBuffer.swap();

        void this.profiler.resolveTimestamps(encoder);
        this.device.queue.submit([encoder.finish()]);

        const cpuTime = this.cpuTimer.stop();
        this.profiler.recordFrame({
          dabCount: dabs.length,
          cpuTimeMs: cpuTime,
        });

        this.previewNeedsUpdate = true;
        if (!this.previewUpdatePending) {
          void this.updatePreview();
        }
        return;
      }

      // Compute shader failed, fall through to render pipeline
      console.warn('[GPUStrokeAccumulator] Compute shader failed, falling back to render pipeline');
    }

    // Fallback: per-dab render pipeline
    this.flushBatchLegacy(dabs, gpuBatchBuffer, bbox, encoder);
  }

  /**
   * Legacy per-dab render pipeline (fallback when compute shader unavailable)
   */
  private flushBatchLegacy(
    dabs: DabInstanceData[],
    gpuBatchBuffer: GPUBuffer,
    bbox: { x: number; y: number; width: number; height: number },
    encoder: GPUCommandEncoder
  ): void {
    // Setup scissor
    const scissor = this.computeScissorRect(bbox);

    // Render loop
    let prevDabRect: { x: number; y: number; w: number; h: number } | null = null;

    for (let i = 0; i < dabs.length; i++) {
      const dab = dabs[i]!;
      const dabRect = this.computeDabBounds(dab);

      // Partial Copy Logic: Sync Dest with Source
      if (i === 0) {
        // First dab: copy accumulated dirty rect
        // IMPORTANT: dirtyRect is in logical coordinates, need to scale to texture space
        const dr = this.dirtyRect;
        const scale = this.currentRenderScale;
        const copyX = Math.floor(dr.left * scale);
        const copyY = Math.floor(dr.top * scale);
        const copyW = Math.ceil((dr.right - dr.left) * scale);
        const copyH = Math.ceil((dr.bottom - dr.top) * scale);
        if (copyW > 0 && copyH > 0) {
          this.pingPongBuffer.copyRect(encoder, copyX, copyY, copyW, copyH);
        }
      } else if (prevDabRect) {
        // Subsequent dabs: copy previous dab's bounds
        this.pingPongBuffer.copyRect(
          encoder,
          prevDabRect.x,
          prevDabRect.y,
          prevDabRect.w,
          prevDabRect.h
        );
      }

      // Render Pass
      const pass = encoder.beginRenderPass({
        label: `Dab Pass ${i}`,
        colorAttachments: [
          {
            view: this.pingPongBuffer.dest.createView(),
            loadOp: 'load',
            storeOp: 'store',
          },
        ],
        // Only timestamp first pass
        timestampWrites: i === 0 ? this.profiler.getTimestampWrites() : undefined,
      });

      if (scissor) {
        pass.setScissorRect(scissor.x, scissor.y, scissor.w, scissor.h);
      }

      pass.setPipeline(this.brushPipeline.renderPipeline);
      pass.setBindGroup(0, this.brushPipeline.createBindGroup(this.pingPongBuffer.source));

      // Use offset into the single large batch buffer
      const offset = i * DAB_INSTANCE_SIZE;
      pass.setVertexBuffer(0, gpuBatchBuffer, offset, DAB_INSTANCE_SIZE);
      pass.draw(6, 1);
      pass.end();

      this.pingPongBuffer.swap();
      prevDabRect = dabRect;
    }

    void this.profiler.resolveTimestamps(encoder);
    this.device.queue.submit([encoder.finish()]);

    const cpuTime = this.cpuTimer.stop();
    this.profiler.recordFrame({
      dabCount: dabs.length,
      cpuTimeMs: cpuTime,
    });

    this.previewNeedsUpdate = true;
    if (!this.previewUpdatePending) {
      void this.updatePreview();
    }
  }

  /**
   * Flush pending texture dabs to GPU using Compute Shader (optimized path)
   * or per-dab Render Pipeline (fallback path).
   */
  private flushTextureBatch(): void {
    if (this.textureInstanceBuffer.count === 0) return;

    const currentTexture = this.textureAtlas.getCurrentTexture();
    if (!currentTexture) {
      console.warn('[GPUStrokeAccumulator] No texture available for texture brush');
      this.textureInstanceBuffer.clear();
      return;
    }

    this.cpuTimer.start();

    // 1. Get data and upload to GPU
    const dabs = this.textureInstanceBuffer.getDabsData();
    const bbox = this.textureInstanceBuffer.getBoundingBox();
    const { buffer: gpuBatchBuffer } = this.textureInstanceBuffer.flush();

    const encoder = this.device.createCommandEncoder({
      label: 'Texture Brush Batch Encoder',
    });

    // Try compute shader path first
    if (this.useTextureComputeShader) {
      const dr = this.dirtyRect;
      const scale = this.currentRenderScale;

      // Copy source to dest to preserve previous strokes
      const copyX = Math.floor(dr.left * scale);
      const copyY = Math.floor(dr.top * scale);
      const copyW = Math.ceil((dr.right - dr.left) * scale);
      const copyH = Math.ceil((dr.bottom - dr.top) * scale);
      if (copyW > 0 && copyH > 0) {
        this.pingPongBuffer.copyRect(encoder, copyX, copyY, copyW, copyH);
      }

      // Single dispatch for all dabs
      const success = this.computeTextureBrushPipeline.dispatch(
        encoder,
        this.pingPongBuffer.source,
        this.pingPongBuffer.dest,
        currentTexture,
        dabs
      );

      if (success) {
        // Swap so next flushBatch reads from the updated texture
        this.pingPongBuffer.swap();

        void this.profiler.resolveTimestamps(encoder);
        this.device.queue.submit([encoder.finish()]);

        const cpuTime = this.cpuTimer.stop();
        this.profiler.recordFrame({
          dabCount: dabs.length,
          cpuTimeMs: cpuTime,
        });

        this.previewNeedsUpdate = true;
        if (!this.previewUpdatePending) {
          void this.updatePreview();
        }
        return;
      }

      // Compute shader failed, fall through to render pipeline
      console.warn(
        '[GPUStrokeAccumulator] Texture compute shader failed, falling back to render pipeline'
      );
    }

    // Fallback: per-dab render pipeline
    this.flushTextureBatchLegacy(dabs, gpuBatchBuffer, bbox, encoder, currentTexture);
  }

  /**
   * Legacy per-dab render pipeline for texture brush (fallback when compute shader unavailable)
   */
  private flushTextureBatchLegacy(
    dabs: TextureDabInstanceData[],
    gpuBatchBuffer: GPUBuffer,
    bbox: { x: number; y: number; width: number; height: number },
    encoder: GPUCommandEncoder,
    currentTexture: import('./resources/TextureAtlas').GPUBrushTexture
  ): void {
    // Setup scissor
    const scissor = this.computeScissorRect(bbox);

    // Render loop
    let prevDabRect: { x: number; y: number; w: number; h: number } | null = null;

    for (let i = 0; i < dabs.length; i++) {
      const dab = dabs[i]!;
      const dabRect = this.computeTextureDabBounds(dab);

      // Partial Copy Logic: Sync Dest with Source
      if (i === 0) {
        const dr = this.dirtyRect;
        const scale = this.currentRenderScale;
        const copyX = Math.floor(dr.left * scale);
        const copyY = Math.floor(dr.top * scale);
        const copyW = Math.ceil((dr.right - dr.left) * scale);
        const copyH = Math.ceil((dr.bottom - dr.top) * scale);
        if (copyW > 0 && copyH > 0) {
          this.pingPongBuffer.copyRect(encoder, copyX, copyY, copyW, copyH);
        }
      } else if (prevDabRect) {
        this.pingPongBuffer.copyRect(
          encoder,
          prevDabRect.x,
          prevDabRect.y,
          prevDabRect.w,
          prevDabRect.h
        );
      }

      // Render Pass
      const pass = encoder.beginRenderPass({
        label: `Texture Dab Pass ${i}`,
        colorAttachments: [
          {
            view: this.pingPongBuffer.dest.createView(),
            loadOp: 'load',
            storeOp: 'store',
          },
        ],
        timestampWrites: i === 0 ? this.profiler.getTimestampWrites() : undefined,
      });

      if (scissor) {
        pass.setScissorRect(scissor.x, scissor.y, scissor.w, scissor.h);
      }

      pass.setPipeline(this.textureBrushPipeline.renderPipeline);
      pass.setBindGroup(
        0,
        this.textureBrushPipeline.createBindGroup(this.pingPongBuffer.source, currentTexture)
      );

      const offset = i * TEXTURE_DAB_INSTANCE_SIZE;
      pass.setVertexBuffer(0, gpuBatchBuffer, offset, TEXTURE_DAB_INSTANCE_SIZE);
      pass.draw(6, 1);
      pass.end();

      this.pingPongBuffer.swap();
      prevDabRect = dabRect;
    }

    void this.profiler.resolveTimestamps(encoder);
    this.device.queue.submit([encoder.finish()]);

    const cpuTime = this.cpuTimer.stop();
    this.profiler.recordFrame({
      dabCount: dabs.length,
      cpuTimeMs: cpuTime,
    });

    this.previewNeedsUpdate = true;
    if (!this.previewUpdatePending) {
      void this.updatePreview();
    }
  }

  /**
   * Calculate bounding box for a texture dab
   */
  private computeTextureDabBounds(dab: TextureDabInstanceData): {
    x: number;
    y: number;
    w: number;
    h: number;
  } {
    const margin = 2;
    const halfSize = dab.size / 2 + margin;
    return {
      x: Math.floor(dab.x - halfSize),
      y: Math.floor(dab.y - halfSize),
      w: Math.ceil(halfSize * 2),
      h: Math.ceil(halfSize * 2),
    };
  }

  /**
   * Calculate scissor rect for the batch (in texture coordinates)
   */
  private computeScissorRect(bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): { x: number; y: number; w: number; h: number } | null {
    if (bbox.width <= 0 || bbox.height <= 0) return null;

    // bbox is already in texture coordinates (scaled by renderScale in stampDab)
    const texW = this.pingPongBuffer.textureWidth;
    const texH = this.pingPongBuffer.textureHeight;

    const x = Math.max(0, Math.floor(bbox.x));
    const y = Math.max(0, Math.floor(bbox.y));
    const w = Math.min(texW - x, Math.ceil(bbox.width));
    const h = Math.min(texH - y, Math.ceil(bbox.height));

    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }

  /**
   * Calculate bounding box for a single dab (including AA margin)
   */
  private computeDabBounds(dab: DabInstanceData): { x: number; y: number; w: number; h: number } {
    const margin = 2;
    const dabRadius = calculateEffectiveRadius(dab.size, dab.hardness) + margin;
    return {
      x: Math.floor(dab.x - dabRadius),
      y: Math.floor(dab.y - dabRadius),
      w: Math.ceil(dabRadius * 2),
      h: Math.ceil(dabRadius * 2),
    };
  }

  /**
   * Async update preview canvas from GPU texture
   * Uses Promise storage and buffer state guard to prevent race conditions
   * Optimization 5: Mark retry when buffer busy instead of silent skip
   * Optimization 8: Handle buffer deadlock defense
   */
  private async updatePreview(): Promise<void> {
    // Optimization 1: If already running, return existing promise (most efficient wait)
    if (this.currentPreviewPromise) {
      return this.currentPreviewPromise;
    }

    if (!this.previewReadbackBuffer) {
      return;
    }

    // Optimization 8: If buffer is mapped but no promise (shouldn't happen), try to unmap
    if (this.previewReadbackBuffer.mapState === 'mapped') {
      try {
        this.previewReadbackBuffer.unmap();
      } catch {
        // Ignore unmap errors
      }
    }

    // Optimization 5: If buffer is pending, mark retry instead of silent skip
    if (this.previewReadbackBuffer.mapState !== 'unmapped') {
      console.warn('[GPUStrokeAccumulator] Buffer is not unmapped, will retry');
      this.previewNeedsUpdate = true; // Ensure next call will retry
      return;
    }

    this.previewNeedsUpdate = false;

    // Store the promise for concurrent access
    this.currentPreviewPromise = (async () => {
      try {
        // Copy current texture to preview readback buffer
        const encoder = this.device.createCommandEncoder();
        const texW = this.pingPongBuffer.textureWidth;
        const texH = this.pingPongBuffer.textureHeight;
        encoder.copyTextureToBuffer(
          { texture: this.pingPongBuffer.source },
          { buffer: this.previewReadbackBuffer!, bytesPerRow: this.readbackBytesPerRow },
          [texW, texH]
        );
        this.device.queue.submit([encoder.finish()]);

        // Wait for GPU and map buffer
        await this.previewReadbackBuffer!.mapAsync(GPUMapMode.READ);
        const gpuData = new Float32Array(this.previewReadbackBuffer!.getMappedRange());

        // Get dirty rect bounds (in logical/canvas coordinates)
        const rect = {
          left: Math.max(0, this.dirtyRect.left),
          top: Math.max(0, this.dirtyRect.top),
          right: Math.min(this.width, this.dirtyRect.right),
          bottom: Math.min(this.height, this.dirtyRect.bottom),
        };

        const rectWidth = rect.right - rect.left;
        const rectHeight = rect.bottom - rect.top;
        const scale = this.currentRenderScale;

        if (rectWidth > 0 && rectHeight > 0) {
          // Create ImageData for the dirty region (full resolution preview)
          const imageData = this.previewCtx.createImageData(rectWidth, rectHeight);
          const floatsPerRow = this.readbackBytesPerRow / 4;

          // Sample from scaled texture with bilinear-ish nearest neighbor
          for (let py = 0; py < rectHeight; py++) {
            for (let px = 0; px < rectWidth; px++) {
              // Map preview pixel to texture pixel (nearest neighbor)
              const texX = Math.floor((rect.left + px) * scale);
              const texY = Math.floor((rect.top + py) * scale);
              const srcIdx = texY * floatsPerRow + texX * 4;
              const dstIdx = (py * rectWidth + px) * 4;

              // Convert float (0-1) to uint8 (0-255)
              imageData.data[dstIdx] = Math.round((gpuData[srcIdx] ?? 0) * 255);
              imageData.data[dstIdx + 1] = Math.round((gpuData[srcIdx + 1] ?? 0) * 255);
              imageData.data[dstIdx + 2] = Math.round((gpuData[srcIdx + 2] ?? 0) * 255);
              imageData.data[dstIdx + 3] = Math.round((gpuData[srcIdx + 3] ?? 0) * 255);
            }
          }

          this.previewCtx.putImageData(imageData, rect.left, rect.top);
        }

        this.previewReadbackBuffer!.unmap();
      } catch (e) {
        console.error('[GPUStrokeAccumulator] Preview update failed:', e);
      } finally {
        this.currentPreviewPromise = null;
        this.previewUpdatePending = false;
        // If more updates were requested while we were updating, do another round
        if (this.previewNeedsUpdate) {
          void this.updatePreview();
        }
      }
    })();

    await this.currentPreviewPromise;
  }

  /**
   * End stroke and composite to layer (legacy API for backward compatibility)
   * Uses previewCanvas as source to ensure WYSIWYG (preview = composite)
   * @returns The dirty rectangle that was modified
   */
  async endStroke(layerCtx: CanvasRenderingContext2D, opacity: number): Promise<Rect> {
    await this.prepareEndStroke();
    return this.compositeToLayer(layerCtx, opacity);
  }

  /**
   * Prepare for end stroke - flush remaining dabs and wait for GPU/preview ready
   * This is the async part that can be awaited before the sync composite
   * Optimization 2: Split async preparation from sync composite for atomic transaction
   * Optimization 6: Always execute updatePreview to ensure data completeness
   */
  async prepareEndStroke(): Promise<void> {
    if (!this.active) {
      return;
    }

    // Optimization 3: Context Lost defense
    if (this.deviceLost) {
      console.warn('[GPUStrokeAccumulator] GPU device lost during prepareEndStroke');
      return;
    }

    // Flush any remaining dabs (texture or parametric based on stroke mode)
    if (this.strokeMode === 'texture') {
      this.flushTextureBatch();
    } else {
      this.flushBatch();
    }

    // Wait for GPU to complete all submitted work
    await this.device.queue.onSubmittedWorkDone();

    // Wait for any in-progress preview update to complete (using Promise, not polling)
    if (this.currentPreviewPromise) {
      await this.currentPreviewPromise;
    }

    // Optimization 6: Always execute updatePreview to ensure final batch is readback
    // Even if previewNeedsUpdate is false, we need to guarantee data completeness
    await this.updatePreview();
  }

  /**
   * Composite stroke to layer - synchronous operation
   * Must be called after prepareEndStroke() completes
   * Optimization 2: This is the sync part that should be in same JS task as clear()
   * Optimization 4: Removed !this.active check - caller guarantees correctness
   * @returns The dirty rectangle that was modified
   */
  compositeToLayer(layerCtx: CanvasRenderingContext2D, opacity: number): Rect {
    // Optimization 4: No active check here - caller (useBrushRenderer) guarantees
    // this is called immediately after prepareEndStroke() in same sync block.
    // The old check caused stroke loss when user started new stroke during await.

    // Composite from previewCanvas (not GPU texture) to ensure WYSIWYG
    this.compositeFromPreview(layerCtx, opacity);

    this.active = false;

    // Return clamped dirty rect
    return {
      left: Math.max(0, this.dirtyRect.left),
      top: Math.max(0, this.dirtyRect.top),
      right: Math.min(this.width, this.dirtyRect.right),
      bottom: Math.min(this.height, this.dirtyRect.bottom),
    };
  }

  /**
   * Composite from previewCanvas to layer (WYSIWYG approach)
   * Uses the same data that was displayed as preview
   */
  private compositeFromPreview(layerCtx: CanvasRenderingContext2D, opacity: number): void {
    const rect = {
      left: Math.max(0, this.dirtyRect.left),
      top: Math.max(0, this.dirtyRect.top),
      right: Math.min(this.width, this.dirtyRect.right),
      bottom: Math.min(this.height, this.dirtyRect.bottom),
    };

    const rectWidth = rect.right - rect.left;
    const rectHeight = rect.bottom - rect.top;

    if (rectWidth <= 0 || rectHeight <= 0) return;

    // Read stroke data from previewCanvas (same as what user saw)
    const strokeData = this.previewCtx.getImageData(rect.left, rect.top, rectWidth, rectHeight);

    // Get layer data for compositing
    const layerData = layerCtx.getImageData(rect.left, rect.top, rectWidth, rectHeight);

    // Composite using Porter-Duff over
    for (let i = 0; i < strokeData.data.length; i += 4) {
      const strokeR = strokeData.data[i]!;
      const strokeG = strokeData.data[i + 1]!;
      const strokeB = strokeData.data[i + 2]!;
      const strokeA = strokeData.data[i + 3]! / 255;

      if (strokeA < 0.001) continue;

      // Apply opacity scaling
      const srcAlpha = strokeA * opacity;

      const dstR = layerData.data[i]!;
      const dstG = layerData.data[i + 1]!;
      const dstB = layerData.data[i + 2]!;
      const dstAlpha = layerData.data[i + 3]! / 255;

      // Porter-Duff over
      const outAlpha = srcAlpha + dstAlpha * (1 - srcAlpha);

      if (outAlpha > 0) {
        layerData.data[i] = Math.round(
          (strokeR * srcAlpha + dstR * dstAlpha * (1 - srcAlpha)) / outAlpha
        );
        layerData.data[i + 1] = Math.round(
          (strokeG * srcAlpha + dstG * dstAlpha * (1 - srcAlpha)) / outAlpha
        );
        layerData.data[i + 2] = Math.round(
          (strokeB * srcAlpha + dstB * dstAlpha * (1 - srcAlpha)) / outAlpha
        );
        layerData.data[i + 3] = Math.round(outAlpha * 255);
      }
    }

    // Write back to layer
    layerCtx.putImageData(layerData, rect.left, rect.top);
  }

  /**
   * Get preview canvas for display during stroke
   * Updated asynchronously via updatePreview() after each flushBatch()
   */
  getCanvas(): HTMLCanvasElement {
    return this.previewCanvas;
  }

  /**
   * Get the dirty rectangle
   */
  getDirtyRect(): Rect {
    return { ...this.dirtyRect };
  }

  /**
   * Get buffer dimensions
   */
  getDimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /**
   * Get performance summary
   */
  getPerformanceSummary() {
    return this.profiler.getSummary();
  }

  /**
   * Parse hex color to RGB
   */
  private hexToRgb(hex: string): { r: number; g: number; b: number } {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) {
      return { r: 0, g: 0, b: 0 };
    }
    return {
      r: parseInt(result[1]!, 16),
      g: parseInt(result[2]!, 16),
      b: parseInt(result[3]!, 16),
    };
  }

  /**
   * Release all GPU resources
   */
  destroy(): void {
    this.pingPongBuffer.destroy();
    this.instanceBuffer.destroy();
    this.brushPipeline.destroy();
    this.computeBrushPipeline.destroy();
    this.textureInstanceBuffer.destroy();
    this.textureBrushPipeline.destroy();
    this.computeTextureBrushPipeline.destroy();
    this.textureAtlas.destroy();
    this.readbackBuffer?.destroy();
    this.previewReadbackBuffer?.destroy();
    this.profiler.destroy();
  }
}
