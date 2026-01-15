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
      inputTimestamp: event.timeStamp, // Use event timestamp for same origin
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
    if (this.measurements.length === 0) {
      return {
        avgInputLatency: 0,
        avgCpuEncodeTime: 0,
        avgGpuExecuteTime: 0,
        avgTotalRenderLatency: 0,
        maxRenderLatency: 0,
        p99RenderLatency: 0,
      };
    }

    let totalInputLatency = 0;
    let totalCpuEncodeTime = 0;
    let totalGpuExecuteTime = 0;
    let gpuSampleCount = 0;
    let totalRenderLatency = 0;
    const renderLatencies: number[] = [];

    for (const m of this.measurements) {
      // Input Latency: cpuEncodeStart - inputTimestamp
      // Note: event.timeStamp might be slightly different base, but usually performance.now() and event.timeStamp are both DOMHighResTimeStamp from navigation start.
      // However, check if inputTimestamp > cpuEncodeStart (should not happen normally unless clock weirdness).
      const inputLatency = Math.max(0, m.cpuEncodeStart - m.inputTimestamp);
      totalInputLatency += inputLatency;

      const cpuTime = Math.max(0, m.cpuEncodeEnd - m.cpuEncodeStart);
      totalCpuEncodeTime += cpuTime;

      // renderTime calculation removed

      if (m.gpuCompleteTimestamp !== undefined) {
        const gpuTime = Math.max(0, m.gpuCompleteTimestamp - m.cpuEncodeEnd);
        totalGpuExecuteTime += gpuTime;
        gpuSampleCount++;
        // For sampled points, render latency includes GPU time
        // renderTime += gpuTime;
      }

      // If not sampled, we only know CPU time.
      // To get "Total Render Latency", ideally we want to estimate GPU time or only count sampled points.
      // The requirement says "Average Render Latency (CPU+GPU)".
      // We should probably only use sampled points for the "Total Render Latency" stats to be accurate,
      // or assume average GPU time for others.
      // Let's use sampled points for total render latency stats if possible, or mixed.
      // Current logic: For stats that require GPU time, we use sampled.
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

    return {
      avgInputLatency: totalInputLatency / this.measurements.length,
      avgCpuEncodeTime: totalCpuEncodeTime / this.measurements.length,
      avgGpuExecuteTime: gpuSampleCount > 0 ? totalGpuExecuteTime / gpuSampleCount : 0,
      avgTotalRenderLatency: totalRenderLatency / count,
      maxRenderLatency:
        renderLatencies.length > 0 ? (renderLatencies[renderLatencies.length - 1] ?? 0) : 0,
      p99RenderLatency: renderLatencies.length > 0 ? (renderLatencies[p99Index] ?? 0) : 0,
    };
  }

  reset() {
    this.measurements = [];
    this.currentMeasurement = null;
  }
}
