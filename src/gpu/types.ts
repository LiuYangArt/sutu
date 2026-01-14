/**
 * GPU Rendering Types
 *
 * Type definitions for WebGPU-based brush rendering.
 */

import type { Rect } from '@/utils/strokeBuffer';

/**
 * Dab instance data for GPU instancing
 * Layout: 36 bytes per instance (9 floats)
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
}

/**
 * Instance buffer layout constants
 */
export const DAB_INSTANCE_SIZE = 36; // bytes per instance
export const DAB_FLOATS_PER_INSTANCE = 9; // floats per instance
export const INITIAL_INSTANCE_CAPACITY = 1024;

/**
 * Batch processing thresholds
 */
export const BATCH_SIZE_THRESHOLD = 64; // Dabs per encoder submit (per-dab loop inside)
export const BATCH_TIME_THRESHOLD_MS = 4; // Flush after N ms

/**
 * Calculate effective radius for soft brush quad expansion.
 * Must match brush.wgsl vertex shader logic.
 */
export function calculateEffectiveRadius(radius: number, hardness: number): number {
  if (hardness >= 0.99) return radius;
  const fade = (1.0 - hardness) * 2.0;
  return radius * (1.0 + fade);
}
