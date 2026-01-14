/**
 * GPU Rendering Module
 *
 * WebGPU-accelerated brush rendering for PaintBoard.
 * Provides GPU-based stroke accumulation with automatic fallback to Canvas 2D.
 */

// Types
export type {
  DabInstanceData,
  GPUContextState,
  FrameMetrics,
  PerformanceSummary,
  BoundingBox,
  RenderBackend,
  IGPUStrokeAccumulator,
  GPUDabParams,
} from './types';

export {
  DAB_INSTANCE_SIZE,
  DAB_FLOATS_PER_INSTANCE,
  INITIAL_INSTANCE_CAPACITY,
  BATCH_SIZE_THRESHOLD,
  BATCH_TIME_THRESHOLD_MS,
} from './types';

// Core
export { GPUContext, shouldUseGPU, reportGPUFallback } from './context';
export { GPUStrokeAccumulator } from './GPUStrokeAccumulator';
export { GPUProfiler, CPUTimer } from './profiler';

// Resources
export { PingPongBuffer } from './resources/PingPongBuffer';
export { InstanceBuffer } from './resources/InstanceBuffer';

// Pipeline
export { BrushPipeline } from './pipeline/BrushPipeline';
