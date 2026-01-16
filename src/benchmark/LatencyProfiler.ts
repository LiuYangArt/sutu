import { LatencyMeasurement, LatencyProfilerStats } from './types';

export class LatencyProfiler {
  private measurements: LatencyMeasurement[] = [];
  private device?: GPUDevice;
  private currentMeasurement: LatencyMeasurement | null = null;
  private isEnabled: boolean = false;

  constructor(device?: GPUDevice) {
    this.device = device;
  }

  setDevice(device: GPUDevice) {
    this.device = device;
  }

  enable() {
    this.isEnabled = true;
    this.measurements = [];
  }

  disable() {
    this.isEnabled = false;
  }

  // Call in PointerEvent handler
  markInputReceived(pointIndex: number, event: PointerEvent): void {
    if (!this.isEnabled) return;

    this.currentMeasurement = {
      inputTimestamp: event.timeStamp,
      queueEnterTime: performance.now(),
      cpuEncodeStart: 0,
      cpuEncodeEnd: 0,
      pointIndex,
    };
  }

  // Call at the start of rendering
  markCpuEncodeStart(): void {
    if (!this.isEnabled || !this.currentMeasurement) return;
    this.currentMeasurement.cpuEncodeStart = performance.now();
  }

  // Call after GPU commands are submitted
  async markRenderSubmit(pointIndex: number): Promise<void> {
    if (!this.isEnabled || !this.currentMeasurement) return;
    // Check if the measurement matches the pointIndex to avoid mismatches
    if (this.currentMeasurement.pointIndex !== pointIndex) {
      // Warning: index mismatch? For now just ignore or proceed if acceptable
    }

    const cpuEnd = performance.now();
    this.currentMeasurement.cpuEncodeEnd = cpuEnd;

    const measurement = this.currentMeasurement;
    // Clear current measurement so we don't reuse it accidentally
    this.currentMeasurement = null;

    // Sample GPU completion time avoiding blocking every frame
    if (this.shouldSampleGpu(pointIndex)) {
      if (this.device) {
        await this.device.queue.onSubmittedWorkDone();
      }
      measurement.gpuCompleteTimestamp = performance.now();
    }

    this.measurements.push(measurement);
  }

  getMeasurements(): LatencyMeasurement[] {
    return this.measurements;
  }

  // Sampling strategy: every N points, skip cold start
  shouldSampleGpu(pointIndex: number): boolean {
    // Skip first 20 points (cold start), then sample every 20 points
    return pointIndex >= 20 && pointIndex % 20 === 0;
  }

  // Get statistics
  getStats(): LatencyProfilerStats {
    const emptySegments = {
      inputToQueue: 0,
      queueWait: 0,
      cpuEncode: 0,
      gpuExecute: 0,
    };

    if (this.measurements.length === 0) {
      return {
        avgInputLatency: 0,
        avgQueueWaitTime: 0,
        avgCpuEncodeTime: 0,
        avgGpuExecuteTime: 0,
        avgTotalRenderLatency: 0,
        maxRenderLatency: 0,
        p99RenderLatency: 0,
        segments: emptySegments,
      };
    }

    let totalInputLatency = 0;
    let totalQueueWaitTime = 0;
    let totalCpuEncodeTime = 0;
    let totalGpuExecuteTime = 0;
    let gpuSampleCount = 0;
    let totalRenderLatency = 0;
    const renderLatencies: number[] = [];

    // Q3: Segment accumulators
    let totalInputToQueue = 0;
    let queueWaitCount = 0;

    for (const m of this.measurements) {
      // Input Latency: cpuEncodeStart - inputTimestamp
      const inputLatency = Math.max(0, m.cpuEncodeStart - m.inputTimestamp);
      totalInputLatency += inputLatency;

      // Q3: Calculate queue wait time if available
      if (m.queueEnterTime !== undefined) {
        const inputToQueue = Math.max(0, m.queueEnterTime - m.inputTimestamp);
        const queueWait = Math.max(0, m.cpuEncodeStart - m.queueEnterTime);
        totalInputToQueue += inputToQueue;
        totalQueueWaitTime += queueWait;
        queueWaitCount++;
      }

      const cpuTime = Math.max(0, m.cpuEncodeEnd - m.cpuEncodeStart);
      totalCpuEncodeTime += cpuTime;

      if (m.gpuCompleteTimestamp !== undefined) {
        const gpuTime = Math.max(0, m.gpuCompleteTimestamp - m.cpuEncodeEnd);
        totalGpuExecuteTime += gpuTime;
        gpuSampleCount++;
      }
    }

    // Recalculate render latencies just for sampled points for p99 and max
    const sampledMeasurements = this.measurements.filter(
      (m) => m.gpuCompleteTimestamp !== undefined
    );

    for (const m of sampledMeasurements) {
      // Render Latency as defined in doc: CPU Encode + GPU Execute
      const cpuTime = m.cpuEncodeEnd - m.cpuEncodeStart;
      const gpuTime = m.gpuCompleteTimestamp! - m.cpuEncodeEnd;
      renderLatencies.push(cpuTime + gpuTime);
      totalRenderLatency += cpuTime + gpuTime;
    }

    // Fallback if no GPU sampled (e.g. CPU mode or few points)
    if (sampledMeasurements.length === 0 && this.measurements.length > 0) {
      // Just CPU time
      for (const m of this.measurements) {
        renderLatencies.push(m.cpuEncodeEnd - m.cpuEncodeStart);
        totalRenderLatency += m.cpuEncodeEnd - m.cpuEncodeStart;
      }
    }

    const count =
      sampledMeasurements.length > 0 ? sampledMeasurements.length : this.measurements.length;

    renderLatencies.sort((a, b) => a - b);
    const p99Index = Math.floor(renderLatencies.length * 0.99);

    // Q3: Calculate segment averages for bottleneck identification
    const segments = {
      inputToQueue: queueWaitCount > 0 ? totalInputToQueue / queueWaitCount : 0,
      queueWait: queueWaitCount > 0 ? totalQueueWaitTime / queueWaitCount : 0,
      cpuEncode: totalCpuEncodeTime / this.measurements.length,
      gpuExecute: gpuSampleCount > 0 ? totalGpuExecuteTime / gpuSampleCount : 0,
    };

    return {
      avgInputLatency: totalInputLatency / this.measurements.length,
      avgQueueWaitTime: segments.queueWait,
      avgCpuEncodeTime: segments.cpuEncode,
      avgGpuExecuteTime: segments.gpuExecute,
      avgTotalRenderLatency: totalRenderLatency / count,
      maxRenderLatency:
        renderLatencies.length > 0 ? (renderLatencies[renderLatencies.length - 1] ?? 0) : 0,
      p99RenderLatency: renderLatencies.length > 0 ? (renderLatencies[p99Index] ?? 0) : 0,
      segments,
    };
  }

  reset() {
    this.measurements = [];
    this.currentMeasurement = null;
  }
}
