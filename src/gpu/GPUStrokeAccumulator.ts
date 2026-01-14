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
import type { GPUDabParams, DabInstanceData } from './types';
import {
  BATCH_SIZE_THRESHOLD,
  BATCH_TIME_THRESHOLD_MS,
  DAB_INSTANCE_SIZE,
  calculateEffectiveRadius,
} from './types';
import { PingPongBuffer } from './resources/PingPongBuffer';
import { InstanceBuffer } from './resources/InstanceBuffer';
import { BrushPipeline } from './pipeline/BrushPipeline';
import { GPUProfiler, CPUTimer } from './profiler';

export class GPUStrokeAccumulator {
  private device: GPUDevice;
  private pingPongBuffer: PingPongBuffer;
  private instanceBuffer: InstanceBuffer;
  private brushPipeline: BrushPipeline;
  private profiler: GPUProfiler;

  private width: number;
  private height: number;
  private active: boolean = false;
  private dirtyRect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

  // Preview canvas for compatibility with existing rendering system
  private previewCanvas: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;

  // Batch timing control
  private lastFlushTime: number = 0;
  private dabsSinceLastFlush: number = 0;

  // Readback buffer for GPU → CPU transfer
  private readbackBuffer: GPUBuffer | null = null;
  private readbackBytesPerRow: number = 0;

  // Preview readback buffer (separate to avoid conflicts)
  private previewReadbackBuffer: GPUBuffer | null = null;
  private previewUpdatePending: boolean = false;
  private previewNeedsUpdate: boolean = false; // Flag to ensure final update

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
    this.profiler = new GPUProfiler();

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
  }

  private createReadbackBuffer(): void {
    // rgba32float = 16 bytes per pixel (4 channels * 4 bytes/channel)
    // Rows must be aligned to 256 bytes
    this.readbackBytesPerRow = Math.ceil((this.width * 16) / 256) * 256;
    const size = this.readbackBytesPerRow * this.height;

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

  /**
   * Resize the accumulator (clears content)
   */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) {
      return;
    }

    this.width = width;
    this.height = height;

    this.pingPongBuffer.resize(width, height);
    this.brushPipeline.updateCanvasSize(width, height);

    this.previewCanvas.width = width;
    this.previewCanvas.height = height;

    this.readbackBuffer?.destroy();
    this.previewReadbackBuffer?.destroy();
    this.createReadbackBuffer();

    this.clear();
  }

  /**
   * Begin a new stroke
   */
  beginStroke(): void {
    this.clear();
    this.active = true;
    this.lastFlushTime = performance.now();
    this.dabsSinceLastFlush = 0;

    // Clear GPU buffers
    this.pingPongBuffer.clear(this.device);
  }

  /**
   * Clear the accumulator
   */
  clear(): void {
    this.active = false;
    this.instanceBuffer.clear();
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

  /**
   * Stamp a dab onto the buffer
   * Compatible with CPU StrokeAccumulator.stampDab() API
   */
  stampDab(params: GPUDabParams): void {
    if (!this.active) return;

    const rgb = this.hexToRgb(params.color);
    const radius = params.size / 2;

    const dabData: DabInstanceData = {
      x: params.x,
      y: params.y,
      size: radius,
      hardness: params.hardness,
      r: rgb.r / 255,
      g: rgb.g / 255,
      b: rgb.b / 255,
      dabOpacity: params.dabOpacity ?? 1.0,
      flow: params.flow,
    };

    this.instanceBuffer.push(dabData);
    this.expandDirtyRect(params.x, params.y, radius, params.hardness);
    this.dabsSinceLastFlush++;

    // Check if batch should be flushed
    const now = performance.now();
    const shouldFlush =
      this.instanceBuffer.count >= BATCH_SIZE_THRESHOLD ||
      now - this.lastFlushTime >= BATCH_TIME_THRESHOLD_MS;

    if (shouldFlush) {
      this.flushBatch();
      this.lastFlushTime = now;
    }
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
   * Flush pending dabs to GPU using per-dab loop with optimized partial copies.
   * Each dab gets its own render pass to ensure correct Alpha Darken accumulation.
   */
  private flushBatch(): void {
    if (this.instanceBuffer.count === 0) return;

    this.cpuTimer.start();

    // 1. Get data and upload to GPU
    const dabs = this.instanceBuffer.getDabsData();
    const bbox = this.instanceBuffer.getBoundingBox();
    // Flush uploads to GPU and resets the pending/bbox counters
    const { buffer: gpuBatchBuffer } = this.instanceBuffer.flush();

    const encoder = this.device.createCommandEncoder({
      label: 'Brush Batch Encoder',
    });

    // 2. Setup scissor
    const scissor = this.computeScissorRect(bbox);

    // 3. Render loop
    let prevDabRect: { x: number; y: number; w: number; h: number } | null = null;

    for (let i = 0; i < dabs.length; i++) {
      const dab = dabs[i]!;
      const dabRect = this.computeDabBounds(dab);

      // Partial Copy Logic: Sync Dest with Source
      if (i === 0) {
        // First dab: copy accumulated dirty rect
        const dr = this.dirtyRect;
        const copyW = dr.right - dr.left;
        const copyH = dr.bottom - dr.top;
        if (copyW > 0 && copyH > 0) {
          this.pingPongBuffer.copyRect(encoder, dr.left, dr.top, copyW, copyH);
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
   * Calculate scissor rect for the batch
   */
  private computeScissorRect(bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): { x: number; y: number; w: number; h: number } | null {
    if (bbox.width <= 0 || bbox.height <= 0) return null;

    const x = Math.max(0, bbox.x);
    const y = Math.max(0, bbox.y);
    const w = Math.min(this.width - x, bbox.width);
    const h = Math.min(this.height - y, bbox.height);

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
   */
  private async updatePreview(): Promise<void> {
    if (this.previewUpdatePending || !this.previewReadbackBuffer) {
      return;
    }

    this.previewUpdatePending = true;
    this.previewNeedsUpdate = false;

    try {
      // Copy current texture to preview readback buffer
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: this.pingPongBuffer.source },
        { buffer: this.previewReadbackBuffer, bytesPerRow: this.readbackBytesPerRow },
        [this.width, this.height]
      );
      this.device.queue.submit([encoder.finish()]);

      // Wait for GPU and map buffer
      await this.previewReadbackBuffer.mapAsync(GPUMapMode.READ);
      const gpuData = new Float32Array(this.previewReadbackBuffer.getMappedRange());

      // Get dirty rect bounds
      const rect = {
        left: Math.max(0, this.dirtyRect.left),
        top: Math.max(0, this.dirtyRect.top),
        right: Math.min(this.width, this.dirtyRect.right),
        bottom: Math.min(this.height, this.dirtyRect.bottom),
      };

      const rectWidth = rect.right - rect.left;
      const rectHeight = rect.bottom - rect.top;

      if (rectWidth > 0 && rectHeight > 0) {
        // Create ImageData for the dirty region
        const imageData = this.previewCtx.createImageData(rectWidth, rectHeight);
        const floatsPerRow = this.readbackBytesPerRow / 4;

        for (let py = 0; py < rectHeight; py++) {
          for (let px = 0; px < rectWidth; px++) {
            const bufferX = rect.left + px;
            const bufferY = rect.top + py;
            const srcIdx = bufferY * floatsPerRow + bufferX * 4;
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

      this.previewReadbackBuffer.unmap();
    } catch {
      // Ignore errors during preview update
    } finally {
      this.previewUpdatePending = false;
      // If more updates were requested while we were updating, do another round
      if (this.previewNeedsUpdate) {
        void this.updatePreview();
      }
    }
  }

  /**
   * End stroke and composite to layer
   * Uses previewCanvas as source to ensure WYSIWYG (preview = composite)
   * @returns The dirty rectangle that was modified
   */
  async endStroke(layerCtx: CanvasRenderingContext2D, opacity: number): Promise<Rect> {
    if (!this.active) {
      return { left: 0, top: 0, right: 0, bottom: 0 };
    }

    // Flush any remaining dabs
    this.flushBatch();

    this.active = false;

    // Wait for GPU to complete all submitted work
    await this.device.queue.onSubmittedWorkDone();

    // Wait for preview to be fully updated (WYSIWYG: use same data as preview)
    await this.waitForPreviewReady();

    // Composite from previewCanvas (not GPU texture) to ensure WYSIWYG
    this.compositeFromPreview(layerCtx, opacity);

    // Return clamped dirty rect
    return {
      left: Math.max(0, this.dirtyRect.left),
      top: Math.max(0, this.dirtyRect.top),
      right: Math.min(this.width, this.dirtyRect.right),
      bottom: Math.min(this.height, this.dirtyRect.bottom),
    };
  }

  /**
   * Wait for preview canvas to be fully updated
   * This ensures WYSIWYG - preview and composite use same data
   */
  private async waitForPreviewReady(): Promise<void> {
    // If preview update is pending, wait for it to complete
    while (this.previewUpdatePending || this.previewNeedsUpdate) {
      // Trigger update if needed
      if (this.previewNeedsUpdate && !this.previewUpdatePending) {
        void this.updatePreview();
      }
      // Small delay to allow async update to progress
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    // Do a final synchronous update to ensure previewCanvas matches GPU texture
    await this.updatePreviewSync();
  }

  /**
   * Synchronous preview update for endStroke
   * Reads GPU texture and updates previewCanvas
   */
  private async updatePreviewSync(): Promise<void> {
    if (!this.previewReadbackBuffer) return;

    // Copy current texture to preview readback buffer
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.pingPongBuffer.source },
      { buffer: this.previewReadbackBuffer, bytesPerRow: this.readbackBytesPerRow },
      [this.width, this.height]
    );
    this.device.queue.submit([encoder.finish()]);

    // Wait for GPU and map buffer
    await this.previewReadbackBuffer.mapAsync(GPUMapMode.READ);
    const gpuData = new Float32Array(this.previewReadbackBuffer.getMappedRange());

    // Get dirty rect bounds
    const rect = {
      left: Math.max(0, this.dirtyRect.left),
      top: Math.max(0, this.dirtyRect.top),
      right: Math.min(this.width, this.dirtyRect.right),
      bottom: Math.min(this.height, this.dirtyRect.bottom),
    };

    const rectWidth = rect.right - rect.left;
    const rectHeight = rect.bottom - rect.top;

    if (rectWidth > 0 && rectHeight > 0) {
      // Create ImageData for the dirty region
      const imageData = this.previewCtx.createImageData(rectWidth, rectHeight);
      const floatsPerRow = this.readbackBytesPerRow / 4;

      for (let py = 0; py < rectHeight; py++) {
        for (let px = 0; px < rectWidth; px++) {
          const bufferX = rect.left + px;
          const bufferY = rect.top + py;
          const srcIdx = bufferY * floatsPerRow + bufferX * 4;
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

    this.previewReadbackBuffer.unmap();
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
    this.readbackBuffer?.destroy();
    this.previewReadbackBuffer?.destroy();
    this.profiler.destroy();
  }
}
