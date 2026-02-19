/**
 * StrokeAccumulator - Frontend implementation of the three-level rendering pipeline
 *
 * This implements the Flow/Opacity separation mechanism:
 * - Flow: Per-dab opacity, accumulates within a stroke
 * - Opacity: Ceiling for the entire stroke, applied when compositing to layer
 *
 * Architecture:
 * 1. Dab Level: Individual brush stamps with Flow-controlled alpha
 * 2. Stroke Accumulator: Accumulates dabs within a single stroke
 * 3. Layer Level: Composites stroke with Opacity as ceiling
 *
 * Performance optimization:
 * - Soft brushes (hardness < 95%) use Rust SIMD backend for mask calculation
 * - Persistent buffer avoids frequent getImageData/putImageData calls
 */

import { invoke } from '@tauri-apps/api/core';
import { MaskCache, type MaskCacheParams } from './maskCache';
import { TextureMaskCache } from './textureMaskCache';
import type { BrushTexture, DualBrushSettings, DualBlendMode } from '@/stores/tool';
import type { TextureSettings } from '@/components/BrushPanel/types';
import { patternManager, type PatternData } from './patternManager';
import { calculateTextureInfluence } from './textureRendering';
import { applyScatter } from './scatterDynamics';
import { getNoisePattern, NOISE_PATTERN_ID } from './noiseTexture';

export type MaskType = 'gaussian';

export interface DabParams {
  x: number;
  y: number;
  size: number;
  flow: number; // Per-dab accumulation rate (0-1)
  hardness: number; // Edge hardness (0-1)
  maskType?: MaskType; // Kept for compatibility, unified runtime profile is gaussian
  color: string; // Hex color
  dabOpacity?: number; // Krita-style: multiplier for entire dab (preserves gradient)
  roundness?: number; // Brush roundness (0-1, 1 = circle, <1 = ellipse)
  angle?: number; // Brush angle in degrees (0-360)
  texture?: BrushTexture; // Texture for sampled brushes (from ABR import)
  textureSettings?: TextureSettings | null; // Texture pattern settings (Mode, Scale, Depth, etc.)
  noiseEnabled?: boolean; // Procedural noise (Photoshop Noise panel compatible)
  noiseSize?: number; // 1-100 (%)
  noiseSizeJitter?: number; // 0-100 (%)
  noiseDensityJitter?: number; // 0-100 (%)
  // Shape Dynamics: flip flags for sampled/texture brushes
  flipX?: boolean; // Flip horizontally
  flipY?: boolean; // Flip vertically
  // Wet Edge: hollow center effect (Photoshop-compatible)
  wetEdge?: number; // Wet edge strength (0-1), 0 = off
  // Dual Brush
  dualBrush?: DualBrushSettings & {
    brushTexture?: BrushTexture; // Secondary brush texture
  };
  // Context for relative scaling
  baseSize?: number; // Main brush base size (slider value)
  spacing?: number; // Main brush spacing (0-10, fraction of tip short edge)
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type StrokeFinalizeReason =
  | 'no_active_stroke'
  | 'no_pending_segment'
  | 'segment_below_threshold'
  | 'emitted_segment';

export interface StrokeFinalizeDebugSnapshot {
  reason: StrokeFinalizeReason;
  speedPxPerMs: number;
  normalizedSpeed: number;
  finalSegmentDistance: number;
  emittedDabCount: number;
  remainingDistancePx: number;
  remainingTimeMs: number;
}

export type StrokeCompositeMode = 'paint' | 'erase';

export function compositeStrokePixel(args: {
  dstR: number;
  dstG: number;
  dstB: number;
  dstAlpha: number;
  srcR: number;
  srcG: number;
  srcB: number;
  srcAlpha: number;
  mode: StrokeCompositeMode;
}): { r: number; g: number; b: number; alpha: number } {
  const { dstR, dstG, dstB, dstAlpha, srcR, srcG, srcB, srcAlpha, mode } = args;

  if (mode === 'erase') {
    return {
      r: dstR,
      g: dstG,
      b: dstB,
      alpha: dstAlpha * (1 - srcAlpha),
    };
  }

  const outAlpha = srcAlpha + dstAlpha * (1 - srcAlpha);
  if (outAlpha <= 0) {
    return { r: 0, g: 0, b: 0, alpha: 0 };
  }

  return {
    r: (srcR * srcAlpha + dstR * dstAlpha * (1 - srcAlpha)) / outAlpha,
    g: (srcG * srcAlpha + dstG * dstAlpha * (1 - srcAlpha)) / outAlpha,
    b: (srcB * srcAlpha + dstB * dstAlpha * (1 - srcAlpha)) / outAlpha,
    alpha: outAlpha,
  };
}

const HARD_BRUSH_THRESHOLD = 0.99;
const ROUNDNESS_HARD_PATH_THRESHOLD = 0.999;
const ROUNDNESS_AA_HARDNESS_CLAMP = 0.98;

function clampNoiseScalePercent(scale: number): number {
  if (!Number.isFinite(scale)) return 100;
  return Math.max(1, Math.min(100, scale));
}

function mapNoiseScalePercentToLegacyScale(percent: number): number {
  // Requested mapping:
  // - UI 100 -> previous 80
  // - UI 1 -> previous 0.8 (smaller than previous minimum 1)
  return (percent / 100) * 80;
}

function clampNoiseJitter(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function hash01(x: number, y: number, salt: number): number {
  const v = Math.sin(x * 12.9898 + y * 78.233 + salt * 37.719) * 43758.5453123;
  return v - Math.floor(v);
}

function createNoiseTextureSettings(params: DabParams): TextureSettings {
  const baseScalePercent = clampNoiseScalePercent(params.noiseSize ?? 100);
  const baseScale = mapNoiseScalePercentToLegacyScale(baseScalePercent);
  const sizeJitter = clampNoiseJitter(params.noiseSizeJitter ?? 0) / 100;
  const densityJitter = clampNoiseJitter(params.noiseDensityJitter ?? 0) / 100;

  const sizeSigned = hash01(params.x, params.y, 0.37) * 2 - 1;
  const densitySigned = hash01(params.x, params.y, 1.73) * 2 - 1;

  const jitteredScale = Math.max(0.1, Math.min(1000, baseScale * (1 + sizeSigned * sizeJitter)));
  const jitteredContrast = densitySigned * densityJitter * 50;

  return {
    patternId: NOISE_PATTERN_ID,
    scale: jitteredScale,
    brightness: 0,
    contrast: jitteredContrast,
    textureEachTip: false,
    mode: 'overlay',
    depth: 100, // Keep strength parity with existing Noise behavior
    minimumDepth: 0,
    depthJitter: 0,
    invert: false,
    depthControl: 0,
  };
}

/**
 * Parse hex color to RGB components (0-255)
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) {
    return { r: 0, g: 0, b: 0 };
  }
  return {
    r: parseInt(result[1]!, 16),
    g: parseInt(result[2]!, 16),
    b: parseInt(result[3]!, 16),
  };
}

/**
 * Blend function for Dual Brush (Photoshop Dual Brush panel compatible)
 * 8 modes supported: Multiply, Darken, Overlay, Color Dodge, Color Burn, Linear Burn, Hard Mix, Linear Height
 */
function blendDual(primary: number, secondary: number, mode: DualBlendMode): number {
  const s = Math.max(0, Math.min(1, secondary));
  const p = Math.max(0, Math.min(1, primary));

  switch (mode) {
    case 'multiply':
      return p * s;
    case 'darken':
      return Math.min(p, s);
    case 'overlay':
      return p < 0.5 ? 2.0 * p * s : 1.0 - 2.0 * (1.0 - p) * (1.0 - s);
    case 'colorDodge':
      return s >= 1.0 ? 1.0 : Math.min(1.0, p / (1.0 - s));
    case 'colorBurn':
      return s <= 0 ? 0 : Math.max(0, 1.0 - (1.0 - p) / s);
    case 'linearBurn':
      return Math.max(0, p + s - 1.0);
    case 'hardMix':
      return p + s >= 1.0 ? 1.0 : 0.0;
    case 'linearHeight':
      return p * (0.5 + s * 0.5);
    default:
      return p * s;
  }
}

/**
 * StrokeAccumulator class for accumulating dabs within a single stroke
 */
export class StrokeAccumulator {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private active: boolean = false;
  private dirtyRect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

  // Persistent ImageData buffer - avoids getImageData/putImageData per dab
  // This is the key optimization: we keep the buffer in memory during the stroke
  private imageData: ImageData | null = null;
  private bufferData: Uint8ClampedArray | null = null;

  // Mask cache for pre-computed brush masks (Krita-style optimization)
  private maskCache: MaskCache = new MaskCache();

  // Texture mask cache for sampled brushes (from ABR import)
  private textureMaskCache: TextureMaskCache = new TextureMaskCache();

  // Dual Brush support
  // Secondary caches (independent state for secondary brush)
  private secondaryMaskCache: MaskCache = new MaskCache();
  private secondaryTextureMaskCache: TextureMaskCache = new TextureMaskCache();

  // Stroke-level Dual Mask Accumulators for PS-compatible layer blending
  // Both brushes render to independent alpha buffers, then blend globally
  private primaryMaskAccumulator: Float32Array | null = null;
  private dualMaskAccumulator: Float32Array | null = null;
  private dualMaskAccumulatorDirty: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

  // Dual brush settings for stroke-level blending
  private dualBrushMode: import('@/stores/tool').DualBlendMode | null = null;
  private dualBrushEnabled: boolean = false;
  // Texture settings for stroke-level blending when textureEachTip is OFF
  private strokeTextureSettings: TextureSettings | null = null;
  private strokeTexturePattern: PatternData | null = null;

  // Canvas sync throttling - sync every N dabs instead of every dab
  private syncCounter: number = 0;
  private static readonly SYNC_INTERVAL = 1; // Sync every dab for correct CPU preview

  // Accumulated dirty rect for batched syncing
  private pendingDirtyRect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

  // Reusable ImageData for sync operations - avoids allocation per sync
  private syncImageData: ImageData | null = null;
  private syncImageDataWidth: number = 0;
  private syncImageDataHeight: number = 0;

  // Legacy fields (kept for compatibility)
  private persistentBuffer: Uint8ClampedArray | null = null;
  private useRustPath: boolean = false;

  // Wet Edge settings (Photoshop-compatible stroke-level effect)
  private wetEdgeEnabled: boolean = false;
  private wetEdgeStrength: number = 1.0;
  private wetEdgeHardness: number = 0; // Current brush hardness for adaptive wet edge

  // Wet Edge effect buffer - stores the processed result for preview

  // Wet Edge LUT - precomputed alpha mapping for performance (v4 optimization)
  private wetEdgeLut: Uint8Array = new Uint8Array(256);
  private wetEdgeLutValid: boolean = false;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('Failed to create 2D context for StrokeAccumulator');
    }
    this.ctx = ctx;
    this.clear();
  }

  /**
   * Resize the buffer (clears content)
   */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.clear();
  }

  /**
   * Begin a new stroke
   * @param hardness - Brush hardness (0-1), determines if Rust SIMD path is used
   * @param wetEdge - Wet edge strength (0-1), 0 = disabled
   */
  beginStroke(hardness: number = 1, wetEdge: number = 0): void {
    this.clear();
    this.active = true;

    // Wet Edge settings
    this.wetEdgeEnabled = wetEdge > 0;
    this.wetEdgeStrength = wetEdge;
    this.wetEdgeHardness = hardness;

    // Initialize persistent ImageData buffer for the entire canvas
    // This avoids getImageData/putImageData per dab - major performance win
    this.imageData = this.ctx.createImageData(this.width, this.height);
    this.bufferData = this.imageData.data;

    // Initialize wet edge buffer if enabled
    if (this.wetEdgeEnabled) {
      // Build LUT for this stroke's hardness/strength combination
      this.buildWetEdgeLut(hardness, wetEdge);
    }

    // DISABLED: Rust SIMD path has too much IPC overhead
    this.useRustPath = false;
    this.persistentBuffer = null;
  }

  /**
   * Build wet edge LUT with hardness-adaptive edge boost (v4 optimization)
   *
   * Key insight: Hard brushes have only ~1px anti-aliased edge.
   * The original 2.2x edgeBoost darkens this thin edge, causing visible aliasing.
   *
   * Solution: Reduce edgeBoost toward centerOpacity as hardness increases.
   * When edgeBoost = centerOpacity, the formula becomes uniform scaling,
   * preserving the original anti-aliasing perfectly.
   */
  private buildWetEdgeLut(hardness: number, strength: number): void {
    // Photoshop-matched parameters (tuned from PS sampling):
    // - PS center opacity is around 60-65%
    // - PS edge is clearly visible even on hard brushes
    const centerOpacity = 0.65; // Center keeps 65% of original opacity
    const maxBoost = 1.8; // Maximum edge boost for soft brushes (reduced to avoid harsh edges)
    // Minimum boost for hard brushes - must be noticeably higher than centerOpacity
    // to create visible edge contrast
    const minBoost = 1.4;

    // Dynamic edgeBoost based on hardness (v4 core algorithm)
    // - hardness < 0.7: full wet edge effect
    // - hardness 0.7-1.0: gradual fade to minBoost
    let effectiveBoost: number;
    if (hardness > 0.7) {
      // Transition zone: smooth interpolation
      const t = (hardness - 0.7) / 0.3; // 0.0 -> 1.0
      effectiveBoost = maxBoost * (1 - t) + minBoost * t;
    } else {
      // Soft brushes: full wet edge effect
      effectiveBoost = maxBoost;
    }

    // Build LUT - NO gamma for hard brushes to preserve AA
    for (let i = 0; i < 256; i++) {
      const alphaNorm = i / 255;

      // Skip gamma shaping for hard brushes - preserve original AA gradient
      const shapedAlpha = hardness > 0.7 ? alphaNorm : Math.pow(alphaNorm, 1.3);

      // Core tone mapping: edge (low alpha) -> boost, center (high alpha) -> fade
      const multiplier = effectiveBoost - (effectiveBoost - centerOpacity) * shapedAlpha;

      let wetAlpha = i * multiplier;

      // Blend with original based on strength
      wetAlpha = i * (1 - strength) + wetAlpha * strength;

      this.wetEdgeLut[i] = Math.min(255, Math.round(wetAlpha));
    }

    this.wetEdgeLutValid = true;
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.dirtyRect = {
      left: this.width,
      top: this.height,
      right: 0,
      bottom: 0,
    };
    this.pendingDirtyRect = {
      left: this.width,
      top: this.height,
      right: 0,
      bottom: 0,
    };
    this.syncCounter = 0;
    this.active = false;
    this.imageData = null;
    this.bufferData = null;
    this.persistentBuffer = null;
    this.useRustPath = false;
    this.wetEdgeEnabled = false;
    this.wetEdgeStrength = 1.0;
    this.wetEdgeHardness = 0;

    this.wetEdgeLutValid = false;

    // Clear stroke-level dual mask accumulators
    this.primaryMaskAccumulator = null;
    this.dualMaskAccumulator = null;
    this.dualMaskAccumulatorDirty = {
      left: this.width,
      top: this.height,
      right: 0,
      bottom: 0,
    };
    this.dualBrushEnabled = false;
    this.dualBrushMode = null;
    this.strokeTextureSettings = null;
    this.strokeTexturePattern = null;

    // Don't clear syncImageData - it can be reused across strokes
  }

  /**
   * Check if stroke is active
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Expand dirty rect from Rust dirty rect tuple (left, top, width, height)
   */
  private expandDirtyRectFromRust(rect: [number, number, number, number]): void {
    const [left, top, width, height] = rect;
    if (width === 0 || height === 0) return;
    this.dirtyRect.left = Math.min(this.dirtyRect.left, left);
    this.dirtyRect.top = Math.min(this.dirtyRect.top, top);
    this.dirtyRect.right = Math.max(this.dirtyRect.right, left + width);
    this.dirtyRect.bottom = Math.max(this.dirtyRect.bottom, top + height);
  }

  /**
   * Stamp a dab using Rust SIMD backend (for soft brushes)
   * Uses persistent buffer to avoid IPC overhead per dab
   */
  async stampDabRust(params: DabParams): Promise<void> {
    if (!this.persistentBuffer) {
      // Fallback to JS path if buffer not initialized
      this.stampDab(params);
      return;
    }

    const rgb = hexToRgb(params.color);
    const radius = params.size / 2;

    try {
      const [newBuffer, dirtyRect] = await invoke<[number[], [number, number, number, number]]>(
        'stamp_soft_dab',
        {
          buffer: Array.from(this.persistentBuffer),
          bufferWidth: this.width,
          bufferHeight: this.height,
          cx: params.x,
          cy: params.y,
          radius: radius,
          hardness: params.hardness,
          roundness: params.roundness ?? 1,
          color: [rgb.r, rgb.g, rgb.b] as [number, number, number],
          flow: params.flow,
          dabOpacity: params.dabOpacity ?? 1,
        }
      );

      // Update persistent buffer
      this.persistentBuffer = new Uint8ClampedArray(newBuffer);
      this.expandDirtyRectFromRust(dirtyRect);
    } catch (error) {
      console.error('Rust dab stamp failed, falling back to JS:', error);
      this.stampDab(params);
    }
  }

  /**
   * Check if using Rust SIMD path
   */
  isUsingRustPath(): boolean {
    return this.useRustPath;
  }

  /**
   * Sync persistent buffer to canvas (call before endStroke when using Rust path)
   */
  private syncBufferToCanvas(): void {
    if (!this.persistentBuffer) return;

    // Create ImageData from the persistent buffer
    const imageData = this.ctx.createImageData(this.width, this.height);
    imageData.data.set(this.persistentBuffer);
    this.ctx.putImageData(imageData, 0, 0);
  }

  /**
   * Stamp an elliptical dab onto the buffer with anti-aliasing
   * Uses cached mask for performance (Krita-style optimization)
   * Hard brushes (hardness >= 0.99) use a fast path that skips mask caching
   *
   * Krita-style unified formula: dabAlpha = maskShape * flow * dabOpacity
   * - maskShape: pure geometric gradient (0-1), center always = 1.0
   * - flow: per-dab accumulation rate
   * - dabOpacity: per-dab transparency multiplier
   */
  /**
   * Stamp an elliptical dab onto the buffer with anti-aliasing
   * Uses cached mask for performance (Krita-style optimization)
   * Hard brushes (hardness >= 0.99) use a fast path that skips mask caching
   *
   * Krita-style unified formula: dabAlpha = maskShape * flow * dabOpacity
   * - maskShape: pure geometric gradient (0-1), center always = 1.0
   * - flow: per-dab accumulation rate
   * - dabOpacity: per-dab transparency multiplier
   */
  stampDab(params: DabParams): void {
    if (params.size < 1) return;
    if (!this.bufferData) return;

    const rgb = hexToRgb(params.color);
    const roundness = params.roundness ?? 1;
    const isHardBrush = params.hardness >= HARD_BRUSH_THRESHOLD;
    const isSquashedRoundness = roundness < ROUNDNESS_HARD_PATH_THRESHOLD;

    // Resolve pattern if enabled
    let pattern: PatternData | undefined;
    if (params.textureSettings?.patternId) {
      pattern = patternManager.getPattern(params.textureSettings.patternId);
    }
    this.updateStrokeTextureBlendState(params.textureSettings, pattern);

    // Resolve built-in noise pattern (independent from Texture patterns)
    const noisePattern = params.noiseEnabled ? getNoisePattern() : undefined;
    const noiseSettings = params.noiseEnabled ? createNoiseTextureSettings(params) : undefined;

    // Initialize stroke-level dual brush state if enabled
    if (params.dualBrush?.enabled && !this.dualBrushEnabled) {
      this.dualBrushEnabled = true;
      this.dualBrushMode = params.dualBrush.mode;
      // Lazy-init primary accumulator
      if (!this.primaryMaskAccumulator) {
        this.primaryMaskAccumulator = new Float32Array(this.width * this.height);
      }
    }

    let dabDirtyRect: Rect;

    if (params.texture) {
      dabDirtyRect = this.stampTextureBrush(params, rgb, pattern, noiseSettings, noisePattern);
    } else if (isHardBrush && !isSquashedRoundness) {
      dabDirtyRect = this.stampHardBrush(params, rgb, pattern, noiseSettings, noisePattern);
    } else {
      const hardnessOverride =
        isHardBrush && isSquashedRoundness
          ? Math.min(params.hardness, ROUNDNESS_AA_HARDNESS_CLAMP)
          : undefined;
      dabDirtyRect = this.stampSoftBrush(
        params,
        rgb,
        pattern,
        noiseSettings,
        noisePattern,
        hardnessOverride
      );
    }

    // When dual brush is enabled, also write primary alpha to accumulator
    if (this.dualBrushEnabled && this.primaryMaskAccumulator) {
      this.stampToPrimaryAccumulator(params, dabDirtyRect);
    }

    this.accumulateDirtyRect(dabDirtyRect);
    this.checkAutoSync();
  }

  private updateStrokeTextureBlendState(
    textureSettings: TextureSettings | null | undefined,
    pattern: PatternData | undefined
  ): void {
    const useStrokeLevelTexture = Boolean(
      textureSettings && pattern && !textureSettings.textureEachTip
    );
    if (useStrokeLevelTexture) {
      this.strokeTextureSettings = textureSettings!;
      this.strokeTexturePattern = pattern!;
      return;
    }

    this.strokeTextureSettings = null;
    this.strokeTexturePattern = null;
  }

  /**
   * Write primary brush alpha to stroke-level accumulator (for dual brush blending)
   */
  private stampToPrimaryAccumulator(_params: DabParams, dirtyRect: Rect): void {
    if (!this.primaryMaskAccumulator || !this.bufferData) return;

    const left = Math.max(0, dirtyRect.left);
    const top = Math.max(0, dirtyRect.top);
    const right = Math.min(this.width, dirtyRect.right);
    const bottom = Math.min(this.height, dirtyRect.bottom);

    // Copy alpha from RGBA buffer to primary mask accumulator (max blend)
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const idx = y * this.width + x;
        const alphaIdx = idx * 4 + 3;
        const alphaValue = this.bufferData[alphaIdx]! / 255;
        // Max blending - keep strongest alpha
        if (alphaValue > this.primaryMaskAccumulator[idx]!) {
          this.primaryMaskAccumulator[idx] = alphaValue;
        }
      }
    }
  }

  /**
   * Stamp a secondary brush dab to the stroke-level dual mask accumulator.
   * This is called independently from primary dabs - secondary brush has its own spacing/path.
   *
   * The accumulator covers the entire canvas and secondary dabs are stamped at their
   * absolute canvas coordinates. When primary dabs render, they sample from this accumulator.
   *
   * @param x - Canvas X coordinate
   * @param y - Canvas Y coordinate
   * @param size - Secondary brush size (already scaled by caller)
   * @param dualBrush - Dual brush settings (for texture, scatter, etc.)
   */
  stampSecondaryDab(
    x: number,
    y: number,
    size: number,
    dualBrush: DualBrushSettings & { brushTexture?: BrushTexture },
    strokeAngle: number = 0
  ): void {
    // Lazy initialize accumulator to canvas size
    const accumulatorSize = this.width * this.height;
    if (!this.dualMaskAccumulator) {
      this.dualMaskAccumulator = new Float32Array(accumulatorSize);
      this.dualMaskAccumulatorDirty = {
        left: this.width,
        top: this.height,
        right: 0,
        bottom: 0,
      };
    }

    // Calculate effective size and scatter
    const effectiveSize = Math.max(1, size);
    const roundness = Math.max(0.01, Math.min(1, (dualBrush.roundness ?? 100) / 100));
    const isSquashedRoundness = roundness < ROUNDNESS_HARD_PATH_THRESHOLD;

    // Handle potential string values for scatter
    let scatterVal = dualBrush.scatter ?? 0;
    if (typeof scatterVal !== 'number') {
      const parsed = parseFloat(String(scatterVal));
      scatterVal = isNaN(parsed) ? 0 : parsed;
    }

    const count = Math.max(1, dualBrush.count || 1);
    const scatterSettings = {
      scatter: scatterVal,
      scatterControl: 'off' as const,
      bothAxes: dualBrush.bothAxes,
      count,
      countControl: 'off' as const,
      countJitter: 0,
    };
    const scatteredPositions = applyScatter(
      {
        x,
        y,
        strokeAngle,
        diameter: effectiveSize,
        dynamics: {
          pressure: 1,
          tiltX: 0,
          tiltY: 0,
          rotation: 0,
          direction: 0,
          initialDirection: 0,
          fadeProgress: 0,
        },
      },
      scatterSettings
    );

    // Setup secondary cache
    let useTexture = false;
    if (dualBrush.brushTexture) {
      useTexture = true;
      if (!this.secondaryTextureMaskCache.setTextureSync(dualBrush.brushTexture)) {
        void this.secondaryTextureMaskCache.setTexture(dualBrush.brushTexture);
        return; // Texture not ready yet
      }
      // Note: mask generation moved inside loop for per-dab angle jitter
    }
    // Note: for non-texture brushes, mask generation is also inside loop

    // Stamp loop (for count > 1)
    for (const pos of scatteredPositions) {
      const stampX = pos.x;
      const stampY = pos.y;

      // Apply angle jitter (PS behavior: each secondary tip has random rotation)
      const randomAngle = Math.random() * 360;

      // Stamp to accumulator with rotation
      if (useTexture) {
        // Update mask with new angle for this dab
        const texParams = {
          size: effectiveSize,
          roundness,
          angle: randomAngle,
        };
        if (this.secondaryTextureMaskCache.needsUpdate(texParams)) {
          this.secondaryTextureMaskCache.generateMask(texParams);
        }
        this.secondaryTextureMaskCache.stampToMask(
          this.dualMaskAccumulator,
          this.width,
          this.height,
          stampX,
          stampY,
          1.0
        );
      } else {
        // Update mask with new angle for this dab
        const maskParams = {
          size: effectiveSize,
          hardness: isSquashedRoundness ? ROUNDNESS_AA_HARDNESS_CLAMP : 1.0,
          roundness,
          angle: randomAngle,
        };
        if (this.secondaryMaskCache.needsUpdate(maskParams)) {
          this.secondaryMaskCache.generateMask(maskParams);
        }
        this.secondaryMaskCache.stampToMask(
          this.dualMaskAccumulator,
          this.width,
          this.height,
          stampX,
          stampY,
          1.0
        );
      }

      // Expand dirty rect
      const radius = effectiveSize / 2;
      this.dualMaskAccumulatorDirty.left = Math.min(
        this.dualMaskAccumulatorDirty.left,
        Math.floor(stampX - radius)
      );
      this.dualMaskAccumulatorDirty.top = Math.min(
        this.dualMaskAccumulatorDirty.top,
        Math.floor(stampY - radius)
      );
      this.dualMaskAccumulatorDirty.right = Math.max(
        this.dualMaskAccumulatorDirty.right,
        Math.ceil(stampX + radius)
      );
      this.dualMaskAccumulatorDirty.bottom = Math.max(
        this.dualMaskAccumulatorDirty.bottom,
        Math.ceil(stampY + radius)
      );
    }
  }

  /**
   * Handle stamping for texture-based brushes
   */
  private stampTextureBrush(
    params: DabParams,
    rgb: { r: number; g: number; b: number },
    pattern?: PatternData,
    noiseSettings?: TextureSettings | null,
    noisePattern?: PatternData
  ): Rect {
    const {
      texture,
      size,
      roundness = 1,
      angle = 0,
      flow,
      dabOpacity = 1.0,
      textureSettings,
    } = params;

    if (!texture) return { left: 0, top: 0, right: 0, bottom: 0 };

    // Fix for Wet Edge on Texture Brushes (v4 regression fix)
    // If we are using a texture brush, we MUST use soft-brush wet edge settings (hardness=0)
    // to ensure full edge boost and gamma are applied.
    // If the stroke started with hardness > 0 (e.g. default 1.0), we need to rebuild the LUT now.
    if (this.wetEdgeEnabled && this.wetEdgeHardness > 0) {
      this.wetEdgeHardness = 0;
      this.buildWetEdgeLut(0, this.wetEdgeStrength);
    }

    // Always try to set texture - TextureMaskCache handles change detection internally
    // This ensures we switch to the new texture when brush preset changes
    if (!this.textureMaskCache.setTextureSync(texture)) {
      // Async loading - skip this dab (texture will be ready for next)
      void this.textureMaskCache.setTexture(texture);
      return { left: 0, top: 0, right: 0, bottom: 0 };
    }

    const textureParams = { size, roundness, angle };
    if (this.textureMaskCache.needsUpdate(textureParams)) {
      this.textureMaskCache.generateMask(textureParams);
    }

    // NOTE: Dual brush blend is now applied at stroke-level in applyDualBrushBlend()
    // This fixes the clipping issue where secondary dabs were cut by primary mask bounds

    return this.textureMaskCache.stampToBuffer(
      this.bufferData!,
      this.width,
      this.height,
      params.x,
      params.y,
      flow,
      dabOpacity,
      rgb.r,
      rgb.g,
      rgb.b,
      textureSettings,
      pattern,
      noiseSettings,
      noisePattern,
      null, // dualMask - now handled at stroke level
      undefined // dualMode
    );
  }

  /**
   * Handle stamping for hard brushes (hardness >= 0.99)
   */
  private stampHardBrush(
    params: DabParams,
    rgb: { r: number; g: number; b: number },
    pattern?: PatternData,
    noiseSettings?: TextureSettings | null,
    noisePattern?: PatternData
  ): Rect {
    const radius = params.size / 2;

    // NOTE: Dual brush blend is now applied at stroke-level in applyDualBrushBlend()

    return this.maskCache.stampHardBrush(
      this.bufferData!,
      this.width,
      this.height,
      params.x,
      params.y,
      radius,
      params.roundness ?? 1,
      params.angle ?? 0,
      params.flow,
      params.dabOpacity ?? 1.0,
      rgb.r,
      rgb.g,
      rgb.b,
      params.wetEdge ?? 0,
      params.textureSettings,
      pattern,
      noiseSettings,
      noisePattern,
      null, // dualMask - now handled at stroke level
      undefined // dualMode
    );
  }

  /**
   * Handle stamping for soft brushes
   */
  private stampSoftBrush(
    params: DabParams,
    rgb: { r: number; g: number; b: number },
    pattern?: PatternData,
    noiseSettings?: TextureSettings | null,
    noisePattern?: PatternData,
    hardnessOverride?: number
  ): Rect {
    // Soft brushes use cached mask
    const hardness = hardnessOverride ?? params.hardness;
    const cacheParams: MaskCacheParams = {
      size: params.size,
      hardness,
      roundness: params.roundness ?? 1,
      angle: params.angle ?? 0,
    };

    // Only regenerate mask when parameters change (major performance win)
    if (this.maskCache.needsUpdate(cacheParams)) {
      this.maskCache.generateMask(cacheParams);
    }

    // NOTE: Dual brush blend is now applied at stroke-level in applyDualBrushBlend()

    // Use cached mask for fast blending
    return this.maskCache.stampToBuffer(
      this.bufferData!,
      this.width,
      this.height,
      params.x,
      params.y,
      params.flow,
      params.dabOpacity ?? 1.0,
      rgb.r,
      rgb.g,
      rgb.b,
      params.wetEdge ?? 0,
      params.textureSettings,
      pattern,
      noiseSettings,
      noisePattern,
      null, // dualMask - now handled at stroke level
      undefined // dualMode
    );
  }

  /**
   * Accumulate the dirty rectangle from a single dab
   */
  private accumulateDirtyRect(dabDirtyRect: Rect): void {
    if (dabDirtyRect.right > dabDirtyRect.left && dabDirtyRect.bottom > dabDirtyRect.top) {
      this.dirtyRect.left = Math.min(this.dirtyRect.left, dabDirtyRect.left);
      this.dirtyRect.top = Math.min(this.dirtyRect.top, dabDirtyRect.top);
      this.dirtyRect.right = Math.max(this.dirtyRect.right, dabDirtyRect.right);
      this.dirtyRect.bottom = Math.max(this.dirtyRect.bottom, dabDirtyRect.bottom);

      // Accumulate pending dirty rect for batched sync
      this.pendingDirtyRect.left = Math.min(this.pendingDirtyRect.left, dabDirtyRect.left);
      this.pendingDirtyRect.top = Math.min(this.pendingDirtyRect.top, dabDirtyRect.top);
      this.pendingDirtyRect.right = Math.max(this.pendingDirtyRect.right, dabDirtyRect.right);
      this.pendingDirtyRect.bottom = Math.max(this.pendingDirtyRect.bottom, dabDirtyRect.bottom);
    }
  }

  /**
   * Check if we should sync to canvas (throttled)
   */
  private checkAutoSync(): void {
    // Throttled canvas sync - sync every N dabs instead of every dab
    this.syncCounter++;
    if (this.syncCounter >= StrokeAccumulator.SYNC_INTERVAL) {
      this.syncPendingToCanvas();
      this.syncCounter = 0;
    }
  }

  /**
   * Sync pending dirty region to canvas for preview
   */
  private syncPendingToCanvas(): void {
    if (!this.bufferData) return;

    const hasPending =
      this.pendingDirtyRect.right > this.pendingDirtyRect.left &&
      this.pendingDirtyRect.bottom > this.pendingDirtyRect.top;
    const hasDualDirty =
      this.dualBrushEnabled &&
      this.dualMaskAccumulator &&
      this.dualMaskAccumulatorDirty.right > this.dualMaskAccumulatorDirty.left &&
      this.dualMaskAccumulatorDirty.bottom > this.dualMaskAccumulatorDirty.top;

    if (!hasPending && !hasDualDirty) return;

    let left = hasPending ? this.pendingDirtyRect.left : this.dualMaskAccumulatorDirty.left;
    let top = hasPending ? this.pendingDirtyRect.top : this.dualMaskAccumulatorDirty.top;
    let right = hasPending ? this.pendingDirtyRect.right : this.dualMaskAccumulatorDirty.right;
    let bottom = hasPending ? this.pendingDirtyRect.bottom : this.dualMaskAccumulatorDirty.bottom;

    if (hasPending && hasDualDirty) {
      left = Math.min(left, this.dualMaskAccumulatorDirty.left);
      top = Math.min(top, this.dualMaskAccumulatorDirty.top);
      right = Math.max(right, this.dualMaskAccumulatorDirty.right);
      bottom = Math.max(bottom, this.dualMaskAccumulatorDirty.bottom);
    }

    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(this.width, right);
    bottom = Math.min(this.height, bottom);

    const width = right - left;
    const height = bottom - top;

    if (width <= 0 || height <= 0) return;

    // Reuse ImageData if dimensions match, otherwise allocate new one
    if (
      !this.syncImageData ||
      this.syncImageDataWidth !== width ||
      this.syncImageDataHeight !== height
    ) {
      this.syncImageData = new ImageData(width, height);
      this.syncImageDataWidth = width;
      this.syncImageDataHeight = height;
    }

    // Extract region from persistent buffer and sync to canvas
    const regionData = this.syncImageData;
    for (let py = 0; py < height; py++) {
      const srcStart = ((top + py) * this.width + left) * 4;
      const dstStart = py * width * 4;
      regionData.data.set(this.bufferData.subarray(srcStart, srcStart + width * 4), dstStart);
    }

    // Apply texture blend at stroke level when Texture Each Tip is OFF.
    this.applyTextureBlendStrokeLevel(regionData, left, top, width, height);

    // Apply dual brush blend on the preview region (do not mutate bufferData)
    if (this.dualBrushEnabled) {
      this.applyDualBrushBlend(regionData, left, top, width, height);
    }

    // Apply wet edge effect after dual blend (preview-only)
    if (this.wetEdgeEnabled) {
      this.applyWetEdgeEffect(regionData);
    }

    this.ctx.putImageData(regionData, left, top);

    // Reset pending dirty rect
    this.pendingDirtyRect = {
      left: this.width,
      top: this.height,
      right: 0,
      bottom: 0,
    };

    if (hasDualDirty) {
      this.dualMaskAccumulatorDirty = {
        left: this.width,
        top: this.height,
        right: 0,
        bottom: 0,
      };
    }
  }

  private applyTextureBlendStrokeLevel(
    regionData: ImageData,
    left: number,
    top: number,
    width: number,
    height: number
  ): void {
    const settings = this.strokeTextureSettings;
    const pattern = this.strokeTexturePattern;
    if (!settings || !pattern || settings.textureEachTip) return;

    const depth = Math.max(0, Math.min(1, settings.depth / 100));
    if (depth <= 0.001) return;

    const data = regionData.data;
    for (let py = 0; py < height; py++) {
      const y = top + py;
      const rowStart = py * width * 4;
      for (let px = 0; px < width; px++) {
        const x = left + px;
        const alphaIdx = rowStart + px * 4 + 3;
        const baseAlpha = (data[alphaIdx] ?? 0) / 255;
        if (baseAlpha <= 0.001) continue;
        const multiplier = calculateTextureInfluence(
          x,
          y,
          settings,
          pattern,
          depth,
          baseAlpha,
          baseAlpha
        );
        data[alphaIdx] = Math.round(Math.max(0, Math.min(255, baseAlpha * multiplier * 255)));
      }
    }
  }

  /**
   * Apply Dual Brush blend at stroke-level (PS-compatible layer blending)
   *
   * This method blends primaryMaskAccumulator with dualMaskAccumulator using the
   * selected blend mode, then modulates preview alpha only.
   *
   * Key insight: This is called PER-SYNC, not per-dab, allowing secondary brush
   * patterns to extend beyond primary brush boundaries (fixing the clipping issue).
   */
  private applyDualBrushBlend(
    regionData: ImageData,
    left: number,
    top: number,
    width: number,
    height: number
  ): void {
    if (!this.primaryMaskAccumulator || !this.dualMaskAccumulator || !this.dualBrushMode) {
      return;
    }

    const mode = this.dualBrushMode;

    const data = regionData.data;

    for (let py = 0; py < height; py++) {
      const y = top + py;
      const rowStart = y * this.width + left;
      const dataRowStart = py * width * 4;
      for (let px = 0; px < width; px++) {
        const idx = rowStart + px;
        const alphaIdx = dataRowStart + px * 4 + 3;

        const primaryVal = this.primaryMaskAccumulator[idx] ?? 0;
        const secondaryVal = this.dualMaskAccumulator[idx] ?? 0;

        // Skip if neither brush has coverage here
        if (primaryVal < 0.001 && secondaryVal < 0.001) continue;

        // Apply blend mode
        const blendedAlpha = blendDual(primaryVal, secondaryVal, mode);

        // Modulate preview alpha with the blended result
        // The key fix: we scale the existing alpha (which includes primary brush shape)
        // by the ratio of (blended / primary) to preserve color but change opacity
        if (primaryVal > 0.001) {
          const scale = blendedAlpha / primaryVal;
          const currentAlpha = data[alphaIdx]!;
          data[alphaIdx] = Math.round(Math.min(255, currentAlpha * scale));
        } else if (secondaryVal > 0.001) {
          // Primary is zero but secondary is not - this shouldn't happen in normal blending
          // since we're blending primary's shapes with secondary, not adding secondary alone
        }
      }
    }
  }

  /**
   * Apply wet edge effect using LUT-based alpha mapping (v4 optimization)
   *
   * Key improvements over v3:
   * 1. Hardness-adaptive edgeBoost: Hard brushes get reduced/no edge enhancement
   * 2. LUT-based: O(1) lookup instead of per-pixel float math
   * 3. Gamma correction: Smoother soft-edge transitions
   *
   * This eliminates the "black halo" aliasing on hard brushes while
   * preserving the wet edge effect on soft brushes.
   */
  private applyWetEdgeEffect(regionData: ImageData): void {
    if (!this.wetEdgeLutValid) return;

    const lut = this.wetEdgeLut;
    const data = regionData.data;

    for (let i = 0; i < data.length; i += 4) {
      const originalAlpha = data[i + 3]!;

      if (originalAlpha < 1) {
        // Fully transparent
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 0;
        continue;
      }

      // LUT lookup: precomputed alpha mapping with hardness-adaptive edgeBoost
      data[i + 3] = lut[originalAlpha]!;
    }
  }

  /**
   * End the stroke and composite to layer with opacity ceiling
   *
   * @param layerCtx - Target layer context
   * @param opacity - Maximum opacity (ceiling) for this stroke
   * @param compositeMode - paint: source-over, erase: destination-out
   * @returns The dirty rectangle that was modified
   */
  endStroke(
    layerCtx: CanvasRenderingContext2D,
    opacity: number,
    compositeMode: StrokeCompositeMode = 'paint'
  ): Rect {
    if (!this.active) {
      return { left: 0, top: 0, right: 0, bottom: 0 };
    }

    // Flush any pending canvas sync before compositing
    this.syncPendingToCanvas();

    // Sync persistent buffer to canvas (for Rust path)
    if (this.useRustPath) {
      this.syncBufferToCanvas();
    }

    this.active = false;

    // Clamp dirty rect to buffer bounds
    const rect: Rect = {
      left: Math.max(0, this.dirtyRect.left),
      top: Math.max(0, this.dirtyRect.top),
      right: Math.min(this.width, this.dirtyRect.right),
      bottom: Math.min(this.height, this.dirtyRect.bottom),
    };

    const rectWidth = rect.right - rect.left;
    const rectHeight = rect.bottom - rect.top;

    if (rectWidth <= 0 || rectHeight <= 0) {
      return rect;
    }

    // Get stroke buffer data
    const strokeData = this.ctx.getImageData(rect.left, rect.top, rectWidth, rectHeight);

    // Get layer data
    const layerData = layerCtx.getImageData(rect.left, rect.top, rectWidth, rectHeight);

    // Apply opacity multiplier (Post-Multiply)
    // The opacity controls the layer-level accumulation, not the dab-level clamping
    const opacityFloat = Math.max(0, Math.min(1, opacity));

    for (let i = 0; i < strokeData.data.length; i += 4) {
      const strokeAlpha = strokeData.data[i + 3] ?? 0;

      if (strokeAlpha === 0) continue;

      // Apply opacity scaling
      const scaledAlpha = strokeAlpha * opacityFloat;
      const srcAlpha = scaledAlpha / 255;

      // Get stroke color (unpremultiply if needed)
      const srcR = strokeData.data[i] ?? 0;
      const srcG = strokeData.data[i + 1] ?? 0;
      const srcB = strokeData.data[i + 2] ?? 0;

      // Get layer color
      const dstR = layerData.data[i] ?? 0;
      const dstG = layerData.data[i + 1] ?? 0;
      const dstB = layerData.data[i + 2] ?? 0;
      const dstAlpha = (layerData.data[i + 3] ?? 0) / 255;

      const out = compositeStrokePixel({
        dstR,
        dstG,
        dstB,
        dstAlpha,
        srcR,
        srcG,
        srcB,
        srcAlpha,
        mode: compositeMode,
      });

      layerData.data[i] = Math.round(Math.max(0, Math.min(255, out.r)));
      layerData.data[i + 1] = Math.round(Math.max(0, Math.min(255, out.g)));
      layerData.data[i + 2] = Math.round(Math.max(0, Math.min(255, out.b)));
      layerData.data[i + 3] = Math.round(Math.max(0, Math.min(255, out.alpha * 255)));
    }

    // Write back to layer
    layerCtx.putImageData(layerData, rect.left, rect.top);

    return rect;
  }

  /**
   * Get the dirty rectangle
   */
  getDirtyRect(): Rect {
    return { ...this.dirtyRect };
  }

  /**
   * Get buffer dimensions
   */
  getDimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /**
   * Get the internal canvas (for preview rendering)
   */
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }
}
