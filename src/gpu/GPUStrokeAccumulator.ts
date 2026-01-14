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
import { BATCH_SIZE_THRESHOLD, BATCH_TIME_THRESHOLD_MS } from './types';
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
    // rgba16float = 8 bytes per pixel
    // Rows must be aligned to 256 bytes
    this.readbackBytesPerRow = Math.ceil((this.width * 8) / 256) * 256;
    const size = this.readbackBytesPerRow * this.height;

    this.readbackBuffer = this.device.createBuffer({
      label: 'Stroke Readback Buffer',
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
      a: (params.dabOpacity ?? 1.0) * params.flow,
    };

    this.instanceBuffer.push(dabData);
    this.expandDirtyRect(params.x, params.y, radius);
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

  private expandDirtyRect(x: number, y: number, radius: number): void {
    const margin = 2; // AA margin
    this.dirtyRect.left = Math.min(this.dirtyRect.left, Math.floor(x - radius - margin));
    this.dirtyRect.top = Math.min(this.dirtyRect.top, Math.floor(y - radius - margin));
    this.dirtyRect.right = Math.max(this.dirtyRect.right, Math.ceil(x + radius + margin));
    this.dirtyRect.bottom = Math.max(this.dirtyRect.bottom, Math.ceil(y + radius + margin));
  }

  /**
   * Flush pending dabs to GPU
   */
  private flushBatch(): void {
    if (this.instanceBuffer.count === 0) return;

    this.cpuTimer.start();

    const { buffer, count } = this.instanceBuffer.flush();
    const bbox = this.instanceBuffer.getBoundingBox();

    const encoder = this.device.createCommandEncoder({
      label: 'Brush Batch Encoder',
    });

    // 1. Copy source to dest (preserve existing content)
    this.pingPongBuffer.copySourceToDest(encoder);

    // 2. Create bind group with source texture for reading
    const bindGroup = this.brushPipeline.createBindGroup(this.pingPongBuffer.source);

    // 3. Begin render pass, write to dest
    const pass = encoder.beginRenderPass({
      label: 'Brush Render Pass',
      colorAttachments: [
        {
          view: this.pingPongBuffer.dest.createView(),
          loadOp: 'load', // Keep copied content
          storeOp: 'store',
        },
      ],
      timestampWrites: this.profiler.getTimestampWrites(),
    });

    // 4. Set scissor rect for optimization
    if (bbox.width > 0 && bbox.height > 0) {
      const scissorX = Math.max(0, bbox.x);
      const scissorY = Math.max(0, bbox.y);
      const scissorW = Math.min(this.width - scissorX, bbox.width);
      const scissorH = Math.min(this.height - scissorY, bbox.height);

      if (scissorW > 0 && scissorH > 0) {
        pass.setScissorRect(scissorX, scissorY, scissorW, scissorH);
      }
    }

    // 5. Draw instanced quads
    pass.setPipeline(this.brushPipeline.renderPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, buffer);
    pass.draw(6, count); // 6 vertices per quad, count instances
    pass.end();

    // Resolve profiler timestamps
    void this.profiler.resolveTimestamps(encoder);

    this.device.queue.submit([encoder.finish()]);

    // 6. Swap ping-pong buffers
    this.pingPongBuffer.swap();

    const cpuTime = this.cpuTimer.stop();
    this.profiler.recordFrame({
      dabCount: count,
      cpuTimeMs: cpuTime,
    });
  }

  /**
   * End stroke and composite to layer
   * @returns The dirty rectangle that was modified
   */
  async endStroke(layerCtx: CanvasRenderingContext2D, opacity: number): Promise<Rect> {
    if (!this.active) {
      return { left: 0, top: 0, right: 0, bottom: 0 };
    }

    // Flush any remaining dabs
    this.flushBatch();

    this.active = false;

    // Wait for GPU to complete
    await this.device.queue.onSubmittedWorkDone();

    // Composite to layer
    await this.compositeToLayer(layerCtx, opacity);

    // Return clamped dirty rect
    return {
      left: Math.max(0, this.dirtyRect.left),
      top: Math.max(0, this.dirtyRect.top),
      right: Math.min(this.width, this.dirtyRect.right),
      bottom: Math.min(this.height, this.dirtyRect.bottom),
    };
  }

  /**
   * Read GPU texture and composite to layer canvas
   */
  private async compositeToLayer(
    layerCtx: CanvasRenderingContext2D,
    opacity: number
  ): Promise<void> {
    if (!this.readbackBuffer) return;

    const rect = {
      left: Math.max(0, this.dirtyRect.left),
      top: Math.max(0, this.dirtyRect.top),
      right: Math.min(this.width, this.dirtyRect.right),
      bottom: Math.min(this.height, this.dirtyRect.bottom),
    };

    const rectWidth = rect.right - rect.left;
    const rectHeight = rect.bottom - rect.top;

    if (rectWidth <= 0 || rectHeight <= 0) return;

    // Copy GPU texture to readback buffer
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.pingPongBuffer.source },
      { buffer: this.readbackBuffer, bytesPerRow: this.readbackBytesPerRow },
      [this.width, this.height]
    );
    this.device.queue.submit([encoder.finish()]);

    // Map and read data
    await this.readbackBuffer.mapAsync(GPUMapMode.READ);
    const gpuData = new Float32Array(this.readbackBuffer.getMappedRange());

    // Get layer data for compositing
    const layerData = layerCtx.getImageData(rect.left, rect.top, rectWidth, rectHeight);
    const floatsPerRow = this.readbackBytesPerRow / 4; // Float32 = 4 bytes

    // Composite using Porter-Duff over
    for (let py = 0; py < rectHeight; py++) {
      for (let px = 0; px < rectWidth; px++) {
        const bufferX = rect.left + px;
        const bufferY = rect.top + py;
        const srcIdx = bufferY * floatsPerRow + bufferX * 4;
        const dstIdx = (py * rectWidth + px) * 4;

        const strokeR = gpuData[srcIdx]!;
        const strokeG = gpuData[srcIdx + 1]!;
        const strokeB = gpuData[srcIdx + 2]!;
        const strokeA = gpuData[srcIdx + 3]!;

        if (strokeA < 0.001) continue;

        // Apply opacity scaling
        const srcAlpha = strokeA * opacity;

        const dstR = layerData.data[dstIdx]!;
        const dstG = layerData.data[dstIdx + 1]!;
        const dstB = layerData.data[dstIdx + 2]!;
        const dstAlpha = layerData.data[dstIdx + 3]! / 255;

        // Porter-Duff over
        const outAlpha = srcAlpha + dstAlpha * (1 - srcAlpha);

        if (outAlpha > 0) {
          layerData.data[dstIdx] = Math.round(
            (strokeR * 255 * srcAlpha + dstR * dstAlpha * (1 - srcAlpha)) / outAlpha
          );
          layerData.data[dstIdx + 1] = Math.round(
            (strokeG * 255 * srcAlpha + dstG * dstAlpha * (1 - srcAlpha)) / outAlpha
          );
          layerData.data[dstIdx + 2] = Math.round(
            (strokeB * 255 * srcAlpha + dstB * dstAlpha * (1 - srcAlpha)) / outAlpha
          );
          layerData.data[dstIdx + 3] = Math.round(outAlpha * 255);
        }
      }
    }

    this.readbackBuffer.unmap();

    // Write back to layer
    layerCtx.putImageData(layerData, rect.left, rect.top);
  }

  /**
   * Get preview canvas for display during stroke
   * NOTE: For real-time preview, we'd need async GPU readback which adds latency.
   * Current implementation returns a canvas that may be slightly behind.
   */
  getCanvas(): HTMLCanvasElement {
    // For now, return empty preview canvas
    // Real implementation would need WebGPU → Canvas bridge
    // Options:
    // 1. Use WebGPU canvas context (preferred but requires canvas integration)
    // 2. Async readback (adds latency)
    // 3. CPU fallback during stroke, GPU for composite only
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
    this.profiler.destroy();
  }
}
