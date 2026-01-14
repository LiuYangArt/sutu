/**
 * GPUProfiler - Performance measurement for GPU rendering
 *
 * Tracks frame metrics including:
 * - Input latency (event to pixel update)
 * - GPU execution time (via timestamp queries if available)
 * - Dab throughput
 */

import type { FrameMetrics, PerformanceSummary } from './types';

export class GPUProfiler {
  private metrics: FrameMetrics[] = [];
  private frameId: number = 0;
  private timestampQuerySet: GPUQuerySet | null = null;
  private timestampBuffer: GPUBuffer | null = null;
  private readbackBuffer: GPUBuffer | null = null;
  private enabled: boolean = true;

  /**
   * Initialize profiler with GPU device
   * @param device GPU device (enables timestamp queries if supported)
   */
  async init(device: GPUDevice): Promise<void> {
    if (device.features.has('timestamp-query')) {
      this.timestampQuerySet = device.createQuerySet({
        type: 'timestamp',
        count: 2, // start and end
      });

      // Buffer for resolving timestamps
      this.timestampBuffer = device.createBuffer({
        size: 16, // 2 * uint64
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });

      // Buffer for reading back timestamps
      this.readbackBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });

      console.log('[GPUProfiler] Timestamp queries enabled');
    } else {
      console.log('[GPUProfiler] Timestamp queries not available, using CPU timing');
    }
  }

  /**
   * Enable or disable profiling
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Get timestamp writes configuration for render pass
   */
  getTimestampWrites(): GPURenderPassTimestampWrites | undefined {
    if (!this.enabled || !this.timestampQuerySet) {
      return undefined;
    }

    return {
      querySet: this.timestampQuerySet,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    };
  }

  /**
   * Resolve and read GPU timestamps after render pass
   */
  async resolveTimestamps(encoder: GPUCommandEncoder): Promise<number | null> {
    if (!this.timestampQuerySet || !this.timestampBuffer || !this.readbackBuffer) {
      return null;
    }

    // Resolve timestamps to buffer
    encoder.resolveQuerySet(this.timestampQuerySet, 0, 2, this.timestampBuffer, 0);

    // Copy to readback buffer
    encoder.copyBufferToBuffer(this.timestampBuffer, 0, this.readbackBuffer, 0, 16);

    return null; // Actual reading happens async after submit
  }

  /**
   * Read back GPU time after command buffer is submitted
   */
  async readGPUTime(): Promise<number> {
    if (!this.readbackBuffer) {
      return 0;
    }

    try {
      await this.readbackBuffer.mapAsync(GPUMapMode.READ);
      const data = new BigUint64Array(this.readbackBuffer.getMappedRange());
      const startTime = data[0] ?? BigInt(0);
      const endTime = data[1] ?? BigInt(0);
      this.readbackBuffer.unmap();

      // Convert nanoseconds to milliseconds
      return Number(endTime - startTime) / 1_000_000;
    } catch {
      return 0;
    }
  }

  /**
   * Record frame metrics
   */
  recordFrame(metrics: Partial<FrameMetrics>): void {
    if (!this.enabled) return;

    this.metrics.push({
      frameId: this.frameId++,
      inputEventTime: 0,
      dabCount: 0,
      gpuTimeMs: 0,
      cpuTimeMs: 0,
      totalLatencyMs: 0,
      ...metrics,
    });

    // Keep only recent frames (rolling window)
    if (this.metrics.length > 1000) {
      this.metrics.shift();
    }
  }

  /**
   * Get performance summary for recent frames
   */
  getSummary(): PerformanceSummary {
    const recent = this.metrics.slice(-100);
    if (recent.length === 0) {
      return { avgLatency: 0, p95Latency: 0, avgDabCount: 0, avgGpuTime: 0 };
    }

    const latencies = recent.map((m) => m.totalLatencyMs).sort((a, b) => a - b);
    const p95Index = Math.floor(latencies.length * 0.95);

    const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

    return {
      avgLatency: sum(latencies) / latencies.length,
      p95Latency: latencies[p95Index] ?? 0,
      avgDabCount: sum(recent.map((m) => m.dabCount)) / recent.length,
      avgGpuTime: sum(recent.map((m) => m.gpuTimeMs)) / recent.length,
    };
  }

  /**
   * Get recent latency values for charting
   */
  getRecentLatencies(): number[] {
    return this.metrics.slice(-100).map((m) => m.totalLatencyMs);
  }

  /**
   * Get all recent metrics
   */
  getRecentMetrics(): FrameMetrics[] {
    return this.metrics.slice(-100);
  }

  /**
   * Clear all recorded metrics
   */
  clear(): void {
    this.metrics = [];
    this.frameId = 0;
  }

  /**
   * Release GPU resources
   */
  destroy(): void {
    this.timestampQuerySet?.destroy();
    this.timestampBuffer?.destroy();
    this.readbackBuffer?.destroy();
    this.timestampQuerySet = null;
    this.timestampBuffer = null;
    this.readbackBuffer = null;
  }
}

/**
 * Simple CPU timer for measuring code blocks
 */
export class CPUTimer {
  private startTime: number = 0;

  start(): void {
    this.startTime = performance.now();
  }

  stop(): number {
    return performance.now() - this.startTime;
  }
}
