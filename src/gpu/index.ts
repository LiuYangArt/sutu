/**
 * GPU Rendering Module
 *
 * WebGPU-accelerated brush rendering for Sutu.
 * Provides GPU-based stroke accumulation with automatic fallback to Canvas 2D.
 */

// Types
export type {
  DabInstanceData,
  TextureDabInstanceData,
  GPUContextState,
  FrameMetrics,
  PerformanceSummary,
  BoundingBox,
  RenderBackend,
  IGPUStrokeAccumulator,
  GPUDabParams,
  StrokeCompositeMode,
  GpuScratchHandle,
  GpuStrokePrepareResult,
  GpuStrokeCommitResult,
  GpuBrushCommitReadbackMode,
  GpuBrushCommitMetricsSnapshot,
  GpuLayerBlendModeM3,
  GpuRenderableLayer,
  GpuGradientPoint,
  GpuGradientConfig,
  GpuGradientRenderParams,
  GpuCurvesRenderParams,
} from './types';

export {
  DAB_INSTANCE_SIZE,
  DAB_FLOATS_PER_INSTANCE,
  TEXTURE_DAB_INSTANCE_SIZE,
  TEXTURE_DAB_FLOATS_PER_INSTANCE,
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
export { TextureInstanceBuffer } from './resources/TextureInstanceBuffer';
export { TextureAtlas } from './resources/TextureAtlas';

// Benchmarks
export { runM0Baseline } from './benchmarks/m0Baseline';
export { runFormatCompare } from './benchmarks/formatCompare';
export { runTileSizeCompare } from './benchmarks/tileSizeCompare';

// Layers
export { GpuCanvasRenderer } from './layers/GpuCanvasRenderer';
export { GpuLayerStore } from './layers/GpuLayerStore';
export { TileResidencyManager } from './layers/TileResidencyManager';
export { SelectionMaskGpu } from './layers/SelectionMaskGpu';
export { GpuStrokeCommitCoordinator } from './layers/GpuStrokeCommitCoordinator';
export { GpuStrokeHistoryStore } from './layers/GpuStrokeHistoryStore';
export type {
  GpuStrokeHistoryDirection,
  GpuStrokeHistorySnapshotMode,
  GpuStrokeHistoryApplyPayload,
  GpuStrokeHistoryStats,
  GpuStrokeHistoryTileApplyItem,
} from './layers/GpuStrokeHistoryStore';
export {
  clampResidencyBudgetBytes,
  computeResidencyBudgetFromProbe,
  loadResidencyBudget,
  persistResidencyBudgetFromProbe,
} from './layers/ResidencyBudget';
