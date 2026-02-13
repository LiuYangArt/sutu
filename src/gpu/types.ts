/**
 * GPU Rendering Types
 *
 * Type definitions for WebGPU-based brush rendering.
 */

import type { Rect } from '@/utils/strokeBuffer';
import type { BrushTexture } from '@/stores/tool';
import type { TextureSettings, TextureBlendMode } from '@/components/BrushPanel/types';
import type { TileCoord } from './layers/GpuLayerStore';
import type { BlendMode } from '@/stores/document';
import type { ColorStop, GradientShape, OpacityStop } from '@/stores/gradient';

/**
 * Dab instance data for GPU instancing
 * Layout: 48 bytes per instance (12 floats)
 */
export interface DabInstanceData {
  x: number; // Dab center X
  y: number; // Dab center Y
  size: number; // Dab radius
  hardness: number; // Edge hardness (0-1)
  r: number; // Color R (0-1)
  g: number; // Color G (0-1)
  b: number; // Color B (0-1)
  dabOpacity: number; // Alpha ceiling for Alpha Darken (0-1)
  flow: number; // Per-dab flow multiplier (0-1)
  roundness: number; // Brush roundness (0.01-1.0, pre-clamped)
  angleCos: number; // cos(angle) - precomputed on CPU
  angleSin: number; // sin(angle) - precomputed on CPU
}

/**
 * GPU context state
 */
export interface GPUContextState {
  supported: boolean;
  device: GPUDevice | null;
  adapter: GPUAdapter | null;
  features: Set<string>;
  limits: GPUSupportedLimits | null;
}

/**
 * Frame performance metrics
 */
export interface FrameMetrics {
  frameId: number;
  inputEventTime: DOMHighResTimeStamp;
  dabCount: number;
  gpuTimeMs: number;
  cpuTimeMs: number;
  totalLatencyMs: number;
}

/**
 * Performance summary statistics
 */
export interface PerformanceSummary {
  avgLatency: number;
  p95Latency: number;
  avgDabCount: number;
  avgGpuTime: number;
}

/**
 * Bounding box for scissor test
 */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Render backend type
 */
export type RenderBackend = 'gpu' | 'canvas2d';

export interface GpuScratchHandle {
  texture: GPUTexture;
  renderScale: number;
}

export type StrokeCompositeMode = 'paint' | 'erase';

export interface GpuStrokePrepareResult {
  dirtyRect: Rect | null;
  strokeOpacity: number;
  compositeMode: StrokeCompositeMode;
  scratch: GpuScratchHandle | null;
}

export interface GpuStrokeCommitResult {
  committed: boolean;
  dirtyRect: Rect | null;
  dirtyTiles: TileCoord[];
  timings: {
    prepareMs: number;
    commitMs: number;
    readbackMs: number;
  };
}

export type GpuBrushCommitReadbackMode = 'enabled' | 'disabled';

export type GpuLayerBlendModeM3 =
  | 'normal'
  | 'dissolve'
  | 'darken'
  | 'multiply'
  | 'color-burn'
  | 'linear-burn'
  | 'darker-color'
  | 'lighten'
  | 'screen'
  | 'color-dodge'
  | 'linear-dodge'
  | 'lighter-color'
  | 'overlay'
  | 'soft-light'
  | 'hard-light'
  | 'vivid-light'
  | 'linear-light'
  | 'pin-light'
  | 'hard-mix'
  | 'difference'
  | 'exclusion'
  | 'subtract'
  | 'divide'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export interface GpuRenderableLayer {
  id: string;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
  revision: number;
}

export interface GpuGradientPoint {
  x: number;
  y: number;
}

export interface GpuGradientConfig {
  shape: GradientShape;
  colorStops: ColorStop[];
  opacityStops: OpacityStop[];
  blendMode: BlendMode;
  opacity: number;
  reverse: boolean;
  dither: boolean;
  transparency: boolean;
  foregroundColor: string;
  backgroundColor: string;
}

export interface GpuGradientRenderParams extends GpuGradientConfig {
  start: GpuGradientPoint;
  end: GpuGradientPoint;
  dirtyRect: Rect | null;
}

export interface GpuCurvesRenderParams {
  rgbLut: Uint8Array;
  redLut: Uint8Array;
  greenLut: Uint8Array;
  blueLut: Uint8Array;
  dirtyRect: Rect | null;
}

export interface GpuBrushCommitMetricsSnapshot {
  attemptCount: number;
  committedCount: number;
  avgPrepareMs: number;
  avgCommitMs: number;
  avgReadbackMs: number;
  avgTotalMs: number;
  maxTotalMs: number;
  totalDirtyTiles: number;
  avgDirtyTiles: number;
  maxDirtyTiles: number;
  lastCommitAtMs: number | null;
  readbackMode: GpuBrushCommitReadbackMode;
  readbackBypassedCount: number;
}

/**
 * GPU Stroke Accumulator interface
 * Mirrors the CPU StrokeAccumulator API for seamless switching
 */
export interface IGPUStrokeAccumulator {
  resize(width: number, height: number): void;
  beginStroke(): void;
  clear(): void;
  isActive(): boolean;
  stampDab(params: GPUDabParams): void;
  endStroke(
    layerCtx: CanvasRenderingContext2D,
    opacity: number,
    compositeMode?: StrokeCompositeMode
  ): Promise<Rect>;
  getCanvas(): HTMLCanvasElement;
  getDirtyRect(): Rect;
  getDimensions(): { width: number; height: number };
  destroy(): void;
}

/**
 * GPU-compatible dab parameters
 */
export interface GPUDabParams {
  x: number;
  y: number;
  size: number;
  flow: number;
  hardness: number;
  color: string;
  dabOpacity?: number;
  roundness?: number;
  angle?: number;
  /** Texture for sampled brushes (from ABR import) */
  texture?: BrushTexture;
  /** Texture settings for pattern modulation */
  textureSettings?: TextureSettings | null;
  /** Noise toggle (applied as overlay on tip alpha) */
  noiseEnabled?: boolean;
}

/**
 * GPU-compatible pattern settings (subset of TextureSettings)
 */
export interface GPUPatternSettings {
  patternId: string | null;
  scale: number;
  brightness: number;
  contrast: number;
  depth: number;
  invert: boolean;
  mode: TextureBlendMode;
}

/**
 * Instance buffer layout constants for parametric brushes
 */
export const DAB_INSTANCE_SIZE = 48; // bytes per instance (12 floats)
export const DAB_FLOATS_PER_INSTANCE = 12; // floats per instance
export const INITIAL_INSTANCE_CAPACITY = 1024;

/**
 * Texture dab instance data for GPU instancing
 * Layout: 48 bytes per instance (12 floats)
 */
export interface TextureDabInstanceData {
  x: number; // Dab center X
  y: number; // Dab center Y
  size: number; // Dab diameter (not radius)
  roundness: number; // Brush roundness (0-1)
  angle: number; // Rotation angle in radians
  r: number; // Color R (0-1)
  g: number; // Color G (0-1)
  b: number; // Color B (0-1)
  dabOpacity: number; // Alpha ceiling for Alpha Darken (0-1)
  flow: number; // Per-dab flow multiplier (0-1)
  texWidth: number; // Original texture width
  texHeight: number; // Original texture height
}

/**
 * Instance buffer layout constants for texture brushes
 */
export const TEXTURE_DAB_INSTANCE_SIZE = 48; // bytes per instance (12 floats)
export const TEXTURE_DAB_FLOATS_PER_INSTANCE = 12; // floats per instance

/**
 * Batch processing thresholds
 */
export const BATCH_SIZE_THRESHOLD = 64; // Dabs per encoder submit (per-dab loop inside)
export const BATCH_TIME_THRESHOLD_MS = 4; // Flush after N ms

const HARD_BRUSH_THRESHOLD = 0.99;
const SOFT_MASK_MAX_EXTENT = 1.8;

/**
 * Calculate effective radius for bounding box and early culling.
 * Must match computeBrush.wgsl calculate_effective_radius logic.
 */
export function calculateEffectiveRadius(radius: number, hardness: number): number {
  // Small brush: ensure minimum effective radius (matches WGSL)
  if (radius < 2.0) {
    return Math.max(1.5, radius + 1.0);
  }
  // Hard brush: slight expansion for AA band
  if (hardness >= HARD_BRUSH_THRESHOLD) {
    return radius * 1.1;
  }
  // Soft brush: keep in sync with MaskCache.SOFT_MAX_EXTENT and computeBrush.wgsl
  return radius * SOFT_MASK_MAX_EXTENT;
}
