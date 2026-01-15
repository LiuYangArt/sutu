import { TrailAnalysis, LatencyMeasurement } from './types';

export class StrokeTrailAnalyzer {
  // Analyze latency curve of a single stroke
  analyzeStroke(measurements: LatencyMeasurement[]): TrailAnalysis {
    if (measurements.length === 0) {
      return {
        pointCount: 0,
        latencies: [],
        avgLatencyFirst10: 0,
        avgLatencyLast10: 0,
        latencyDrift: 0,
        hasTrailingLag: false,
      };
    }

    // Sort by pointIndex just in case
    measurements.sort((a, b) => a.pointIndex - b.pointIndex);

    // Calculate full Render Latency for each point
    // Note: Render Latency = cpuEncodeEnd - cpuEncodeStart + (maybe GPU time)
    // For trailing lag analysis, we care about the "Total System Latency" drift.
    // Ideally: (Render End Time) - (Input Time).
    // If not sampled, we only have CPU End Time.
    // If we use CPU End Time as proxy for "Submitted", it's fine for drift detection *unless* GPU queue is backing up.
    // Ideally we should use sampled points for accurate drift if possible, or interpolation.
    // For now, let's use what we have. If GPU time is available, use it. If not, use CPU end.

    const latencies = measurements.map((m) => {
      const endTime =
        m.gpuCompleteTimestamp !== undefined ? m.gpuCompleteTimestamp : m.cpuEncodeEnd;
      return endTime - m.inputTimestamp;
    });

    const pointCount = measurements.length;

    // First 10
    const first10Count = Math.min(pointCount, 10);
    const first10Sum = latencies.slice(0, first10Count).reduce((a, b) => a + b, 0);
    const avgLatencyFirst10 = first10Count > 0 ? first10Sum / first10Count : 0;

    // Last 10
    const last10Start = Math.max(0, pointCount - 10);
    const last10 = latencies.slice(last10Start);
    const last10Sum = last10.reduce((a, b) => a + b, 0);
    const avgLatencyLast10 = last10.length > 0 ? last10Sum / last10.length : 0;

    const latencyDrift = avgLatencyLast10 - avgLatencyFirst10;

    return {
      pointCount,
      latencies,
      avgLatencyFirst10,
      avgLatencyLast10,
      latencyDrift,
      hasTrailingLag: this.detectTrailingLagValue(latencyDrift),
    };
  }

  // Detect if trailing lag issues exist
  // Threshold: drift > 5ms
  detectTrailingLag(analysis: TrailAnalysis): boolean {
    return analysis.hasTrailingLag;
  }

  private detectTrailingLagValue(drift: number): boolean {
    return drift > 5;
  }
}
