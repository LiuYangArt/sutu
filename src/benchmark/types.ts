export interface LatencyMeasurement {
  inputTimestamp: number; // PointerEvent.timeStamp (same origin clock)
  cpuEncodeStart: number; // CPU encoding start time
  cpuEncodeEnd: number; // CPU encoding end time
  gpuCompleteTimestamp?: number; // GPU actual completion time (only for sampled points)
  pointIndex: number;
}

export interface FrameStats {
  fps: number;
  avgFrameTime: number;
  minFrameTime: number;
  maxFrameTime: number;
  frameTimeStdDev: number;
  p99FrameTime: number;
  droppedFrames: number; // Number of frames with time > 33ms
  consecutiveDrops: number; // Longest streak of dropped frames
}

export interface TrailAnalysis {
  pointCount: number;
  latencies: number[]; // Latency for each point
  avgLatencyFirst10: number; // Average latency of the first 10 points
  avgLatencyLast10: number; // Average latency of the last 10 points
  latencyDrift: number; // Latency drift (last10 - first10)
  hasTrailingLag: boolean; // Whether trailing lag issues are present
}

export interface LagometerStats {
  avgLagDistance: number; // Average lag distance (pixels)
  maxLagDistance: number; // Peak lag distance
  lagExceedCount: number; // Number of times threshold was exceeded
  lagExceedThreshold: number; // Threshold (brush radius + N pixels)
  // Normalized metrics
  lagAsScreenPercent: number; // Max lag as percentage of screen width
  lagAsBrushRadii: number; // Max lag as multiple of brush radius
}

export interface LatencyProfilerStats {
  avgInputLatency: number;
  avgCpuEncodeTime: number;
  avgGpuExecuteTime: number; // Only based on sampled points
  avgTotalRenderLatency: number;
  maxRenderLatency: number;
  p99RenderLatency: number;
}

declare global {
  interface Window {
    __benchmark?: {
      latencyProfiler: {
        getStats: () => LatencyProfilerStats;
        reset: () => void;
      };
      fpsCounter: {
        getStats: () => FrameStats;
      };
      lagometer: {
        getStats: () => LagometerStats;
        reset: () => void;
      };
      resetForScenario?: () => void;
    };
  }
}
