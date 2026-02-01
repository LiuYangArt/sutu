/**
 * GPU Rendering Types
 *
 * Type definitions for WebGPU-based brush rendering.
 */

import type { Rect } from '@/utils/strokeBuffer';
import type { BrushTexture } from '@/stores/tool';
import type { TextureSettings, TextureBlendMode } from '@/components/BrushPanel/types';

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
  endStroke(layerCtx: CanvasRenderingContext2D, opacity: number): Promise<Rect>;
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
  if (hardness >= 0.99) {
    return radius * 1.1;
  }
  // Soft brush: geometric fade expansion
  const geometricFade = (1.0 - hardness) * 2.5;
  return radius * Math.max(1.1, 1.0 + geometricFade);
}
