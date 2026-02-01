/**
 * GPUStrokeAccumulator - GPU-accelerated stroke buffer
 *
 * Mirrors the CPU StrokeAccumulator API for seamless backend switching.
 * Uses WebGPU Render Pipeline with Instancing for batched dab rendering.
 *
 * Key features:
 * - Ping-Pong double buffering to avoid read/write conflicts
 * - GPU Instancing for efficient batched dab submission
 * - Alpha Darken blending implemented in fragment shader
 * - Automatic batch flushing based on count/time thresholds
 */

import type { Rect } from '@/utils/strokeBuffer';
import type { GPUDabParams, DabInstanceData, TextureDabInstanceData } from './types';
import { DAB_INSTANCE_SIZE, TEXTURE_DAB_INSTANCE_SIZE, calculateEffectiveRadius } from './types';
import { PingPongBuffer } from './resources/PingPongBuffer';
import { InstanceBuffer } from './resources/InstanceBuffer';
import { TextureInstanceBuffer } from './resources/TextureInstanceBuffer';
import { BrushPipeline } from './pipeline/BrushPipeline';
import { useSelectionStore } from '@/stores/selection';
import { TextureBrushPipeline } from './pipeline/TextureBrushPipeline';
import { ComputeBrushPipeline } from './pipeline/ComputeBrushPipeline';
import { ComputeTextureBrushPipeline } from './pipeline/ComputeTextureBrushPipeline';
import { ComputeWetEdgePipeline } from './pipeline/ComputeWetEdgePipeline';
import { ComputeDualMaskPipeline } from './pipeline/ComputeDualMaskPipeline';
import { ComputeDualTextureMaskPipeline } from './pipeline/ComputeDualTextureMaskPipeline';
import { ComputeDualBlendPipeline } from './pipeline/ComputeDualBlendPipeline';
import { GPUPatternCache } from './resources/GPUPatternCache';
import { TextureAtlas } from './resources/TextureAtlas';
import { GPUProfiler, CPUTimer } from './profiler';
import { useToolStore } from '@/stores/tool';
import type { DualBlendMode, DualBrushSettings } from '@/stores/tool';
import { useSettingsStore, type ColorBlendMode, type GPURenderScaleMode } from '@/stores/settings';
import { patternManager } from '@/utils/patternManager';
import { applyScatter } from '@/utils/scatterDynamics';

export class GPUStrokeAccumulator {
  private device: GPUDevice;
  private pingPongBuffer: PingPongBuffer;
  private instanceBuffer: InstanceBuffer;
  private brushPipeline: BrushPipeline;
  private computeBrushPipeline: ComputeBrushPipeline;
  private useComputeShader: boolean = true; // Re-enabled with full copy fix
  private profiler: GPUProfiler;

  // Texture brush resources (separate from parametric brush)
  private textureInstanceBuffer: TextureInstanceBuffer;
  private textureBrushPipeline: TextureBrushPipeline;
  private computeTextureBrushPipeline: ComputeTextureBrushPipeline;
  private textureAtlas: TextureAtlas;
  private patternCache: GPUPatternCache;
  private useTextureComputeShader: boolean = true; // Enable compute shader for texture brush

  // Dual brush resources (secondary mask + stroke-level blend)
  private secondaryInstanceBuffer: InstanceBuffer;
  private secondaryTextureInstanceBuffer: TextureInstanceBuffer;
  private dualMaskBuffer: PingPongBuffer;
  private dualBlendTexture: GPUTexture;
  private dualTextureAtlas: TextureAtlas;
  private computeDualMaskPipeline: ComputeDualMaskPipeline;
  private computeDualTextureMaskPipeline: ComputeDualTextureMaskPipeline;
  private computeDualBlendPipeline: ComputeDualBlendPipeline;

  private dualBrushEnabled: boolean = false;
  private dualMaskActive: boolean = false;
  private dualBrushMode: DualBlendMode | null = null;
  private dualDirtyRect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  private dualPostPending: boolean = false;

  private fallbackRequest: string | null = null;

  // Debug: first-dispatch profiling (one-time logs)
  private debugFirstFlush: boolean = false;
  private debugFirstPrimaryDispatch: boolean = false;
  private debugFirstSecondaryDispatch: boolean = false;
  private debugFirstDualBlend: boolean = false;
  private debugFirstWetEdgeDispatch: boolean = false;
  private debugFirstPreviewReadback: boolean = false;
  private debugNextWetEdgeDispatch: boolean = false;
  private debugNextWetEdgeLabel: string | null = null;
  private debugNextPreviewReadback: boolean = false;
  private debugNextPreviewLabel: string | null = null;

  // Current stroke mode: 'parametric' or 'texture'
  private strokeMode: 'parametric' | 'texture' = 'parametric';

  // Track current pattern settings to detect changes and trigger flush
  private currentPatternSettings: import('./types').GPUPatternSettings | null = null;

  private width: number;
  private height: number;
  private active: boolean = false;
  private dirtyRect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

  // Preview canvas for compatibility with existing rendering system
  private previewCanvas: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;

  // Batch timing control
  private dabsSinceLastFlush: number = 0;

  // Auto-flush threshold: Must be <= WGSL MAX_SHARED_DABS (128) to prevent silent truncation.
  // Using 64 as a conservative value to avoid triggering dispatchInBatches which has ping-pong bugs.
  private static readonly MAX_SAFE_BATCH_SIZE = 64;

  // Readback buffer for GPU → CPU transfer
  private readbackBuffer: GPUBuffer | null = null;
  private readbackBytesPerRow: number = 0;

  // Preview readback buffer (separate to avoid conflicts)
  private previewReadbackBuffer: GPUBuffer | null = null;
  private previewUpdatePending: boolean = false;
  private previewNeedsUpdate: boolean = false; // Flag to ensure final update

  // Promise-based preview update tracking (optimization 1)
  private currentPreviewPromise: Promise<void> | null = null;

  // Device lost state tracking (optimization 3)
  private deviceLost: boolean = false;

  // Cached color blend mode to avoid redundant updates
  private cachedColorBlendMode: ColorBlendMode = 'linear';

  // Cached render scale mode to avoid redundant updates
  private cachedRenderScaleMode: GPURenderScaleMode = 'off';

  // Current actual render scale (computed from mode + brush params)
  private currentRenderScale: number = 1.0;

  // Performance timing
  private cpuTimer: CPUTimer = new CPUTimer();

  // Wet Edge post-processing (stroke-level effect)
  private wetEdgePipeline: ComputeWetEdgePipeline;
  private wetEdgeEnabled: boolean = false;
  private wetEdgeStrength: number = 0;
  private wetEdgeHardness: number = 0;

  constructor(device: GPUDevice, width: number, height: number) {
    this.device = device;
    this.width = width;
    this.height = height;

    // Initialize GPU resources
    this.pingPongBuffer = new PingPongBuffer(device, width, height);
    this.instanceBuffer = new InstanceBuffer(device);
    this.brushPipeline = new BrushPipeline(device);
    this.brushPipeline.updateCanvasSize(width, height);
    this.computeBrushPipeline = new ComputeBrushPipeline(device);
    this.computeBrushPipeline.updateCanvasSize(width, height);
    this.profiler = new GPUProfiler();

    // Initialize texture brush resources
    this.textureInstanceBuffer = new TextureInstanceBuffer(device);
    this.textureBrushPipeline = new TextureBrushPipeline(device);
    this.textureBrushPipeline.updateCanvasSize(width, height);
    this.computeTextureBrushPipeline = new ComputeTextureBrushPipeline(device);
    this.computeTextureBrushPipeline.updateCanvasSize(width, height);
    this.textureAtlas = new TextureAtlas(device);
    this.patternCache = new GPUPatternCache(device);

    // Initialize dual brush resources
    this.secondaryInstanceBuffer = new InstanceBuffer(device);
    this.secondaryTextureInstanceBuffer = new TextureInstanceBuffer(device);
    this.dualMaskBuffer = new PingPongBuffer(device, width, height);
    this.dualTextureAtlas = new TextureAtlas(device);
    this.computeDualMaskPipeline = new ComputeDualMaskPipeline(device);
    this.computeDualMaskPipeline.updateCanvasSize(
      this.dualMaskBuffer.textureWidth,
      this.dualMaskBuffer.textureHeight
    );
    this.computeDualTextureMaskPipeline = new ComputeDualTextureMaskPipeline(device);
    this.computeDualTextureMaskPipeline.updateCanvasSize(
      this.dualMaskBuffer.textureWidth,
      this.dualMaskBuffer.textureHeight
    );
    this.computeDualBlendPipeline = new ComputeDualBlendPipeline(device);
    this.computeDualBlendPipeline.updateCanvasSize(
      this.pingPongBuffer.textureWidth,
      this.pingPongBuffer.textureHeight
    );
    this.dualBlendTexture = this.createDualBlendTexture();

    // Initialize wet edge post-processing pipeline
    this.wetEdgePipeline = new ComputeWetEdgePipeline(device);
    this.wetEdgePipeline.updateCanvasSize(width, height);

    // Initialize preview canvas
    this.previewCanvas = document.createElement('canvas');
    this.previewCanvas.width = width;
    this.previewCanvas.height = height;
    const ctx = this.previewCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('[GPUStrokeAccumulator] Failed to create preview canvas context');
    }
    this.previewCtx = ctx;

    // Initialize readback buffer
    this.createReadbackBuffer();

    // Initialize profiler
    void this.profiler.init(device);

    // Setup device lost handler (optimization 3)
    void this.device.lost.then((info) => {
      console.warn('[GPUStrokeAccumulator] GPU device lost:', info.message);
      this.deviceLost = true;
    });

    this.prewarmPipelines();
    this.initializePresentableTextures();
  }

  private createDualBlendTexture(): GPUTexture {
    return this.device.createTexture({
      label: 'Dual Blend Texture',
      size: [this.pingPongBuffer.textureWidth, this.pingPongBuffer.textureHeight],
      format: 'rgba32float',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
  }

  private recreateDualBlendTexture(): void {
    this.dualBlendTexture.destroy();
    this.dualBlendTexture = this.createDualBlendTexture();
  }

  private prewarmPipelines(): void {
    try {
      // Allocate display texture early to avoid first-stroke hitch when Wet Edge is enabled.
      this.pingPongBuffer.ensureDisplayTexture();

      const dummyInput = this.device.createTexture({
        label: 'Prewarm Input',
        size: [1, 1],
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });

      const dummyOutput = this.device.createTexture({
        label: 'Prewarm Output',
        size: [1, 1],
        format: 'rgba32float',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.COPY_DST,
      });

      const dummyDual = this.device.createTexture({
        label: 'Prewarm Dual',
        size: [1, 1],
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });

      const dummyBrushTexture = this.device.createTexture({
        label: 'Prewarm Brush',
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });

      this.device.queue.writeTexture(
        { texture: dummyBrushTexture },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 }
      );

      const dummyDab: DabInstanceData = {
        x: 0.5,
        y: 0.5,
        size: 1,
        hardness: 1,
        r: 1,
        g: 1,
        b: 1,
        dabOpacity: 1,
        flow: 1,
        roundness: 1,
        angleCos: 1,
        angleSin: 0,
      };

      const dummyTextureDab: TextureDabInstanceData = {
        x: 0.5,
        y: 0.5,
        size: 1,
        roundness: 1,
        angle: 0,
        r: 1,
        g: 1,
        b: 1,
        dabOpacity: 1,
        flow: 1,
        texWidth: 1,
        texHeight: 1,
      };

      const encoder = this.device.createCommandEncoder({
        label: 'GPU Prewarm Encoder',
      });

      this.computeDualMaskPipeline.dispatch(encoder, dummyInput, dummyOutput, [dummyDab]);
      this.computeDualTextureMaskPipeline.dispatch(
        encoder,
        dummyInput,
        dummyOutput,
        dummyBrushTexture,
        [dummyTextureDab]
      );
      this.computeDualBlendPipeline.dispatch(
        encoder,
        dummyInput,
        dummyDual,
        dummyOutput,
        { left: 0, top: 0, right: 1, bottom: 1 },
        0,
        1.0
      );
      this.wetEdgePipeline.dispatch(
        encoder,
        dummyInput,
        dummyOutput,
        { left: 0, top: 0, right: 1, bottom: 1 },
        0,
        0,
        1.0
      );

      this.device.queue.submit([encoder.finish()]);

      dummyInput.destroy();
      dummyOutput.destroy();
      dummyDual.destroy();
      dummyBrushTexture.destroy();
    } catch (error) {
      console.warn('[GPUStrokeAccumulator] Prewarm failed:', error);
    }
  }

  private initializePresentableTextures(): void {
    try {
      // Ensure display texture exists so we can write into it.
      this.pingPongBuffer.ensureDisplayTexture();

      // Clear raw buffers to defined zero state before using them as inputs.
      this.pingPongBuffer.clear(this.device);
      this.dualMaskBuffer.clear(this.device);

      const fullRect: Rect = {
        left: 0,
        top: 0,
        right: this.width,
        bottom: this.height,
      };

      const encoder = this.device.createCommandEncoder({
        label: 'GPU Startup Init Encoder',
      });

      // Initialize dual blend output (avoid first-read implicit clear cost).
      this.computeDualBlendPipeline.dispatch(
        encoder,
        this.pingPongBuffer.source,
        this.dualMaskBuffer.source,
        this.dualBlendTexture,
        fullRect,
        0,
        this.currentRenderScale
      );

      // Initialize wet edge display output.
      this.wetEdgePipeline.dispatch(
        encoder,
        this.pingPongBuffer.source,
        this.pingPongBuffer.display,
        fullRect,
        0,
        0,
        this.currentRenderScale
      );

      this.device.queue.submit([encoder.finish()]);
    } catch (error) {
      console.warn('[GPUStrokeAccumulator] Startup init failed:', error);
    }
  }

  private createReadbackBuffer(): void {
    // Use actual texture dimensions (may be scaled)
    const texW = this.pingPongBuffer.textureWidth;
    const texH = this.pingPongBuffer.textureHeight;

    // rgba32float = 16 bytes per pixel (4 channels * 4 bytes/channel)
    // Rows must be aligned to 256 bytes
    this.readbackBytesPerRow = Math.ceil((texW * 16) / 256) * 256;
    const size = this.readbackBytesPerRow * texH;

    this.readbackBuffer = this.device.createBuffer({
      label: 'Stroke Readback Buffer',
      size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // Separate buffer for preview to avoid mapping conflicts
    this.previewReadbackBuffer = this.device.createBuffer({
      label: 'Preview Readback Buffer',
      size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }

  /** Destroy and recreate readback buffers (after texture resize) */
  private recreateReadbackBuffers(): void {
    this.readbackBuffer?.destroy();
    this.previewReadbackBuffer?.destroy();
    this.createReadbackBuffer();
  }

  /**
   * Resize the accumulator (clears content)
   */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) {
      return;
    }

    this.width = width;
    this.height = height;

    // Resize with current render scale
    this.pingPongBuffer.resize(width, height, this.currentRenderScale);
    this.brushPipeline.updateCanvasSize(
      this.pingPongBuffer.textureWidth,
      this.pingPongBuffer.textureHeight
    );
    this.computeBrushPipeline.updateCanvasSize(
      this.pingPongBuffer.textureWidth,
      this.pingPongBuffer.textureHeight
    );
    this.textureBrushPipeline.updateCanvasSize(
      this.pingPongBuffer.textureWidth,
      this.pingPongBuffer.textureHeight
    );
    this.computeTextureBrushPipeline.updateCanvasSize(
      this.pingPongBuffer.textureWidth,
      this.pingPongBuffer.textureHeight
    );
    this.wetEdgePipeline.updateCanvasSize(
      this.pingPongBuffer.textureWidth,
      this.pingPongBuffer.textureHeight
    );
    this.dualMaskBuffer.resize(width, height, this.currentRenderScale);
    this.computeDualMaskPipeline.updateCanvasSize(
      this.dualMaskBuffer.textureWidth,
      this.dualMaskBuffer.textureHeight
    );
    this.computeDualTextureMaskPipeline.updateCanvasSize(
      this.dualMaskBuffer.textureWidth,
      this.dualMaskBuffer.textureHeight
    );
    this.computeDualBlendPipeline.updateCanvasSize(
      this.pingPongBuffer.textureWidth,
      this.pingPongBuffer.textureHeight
    );
    this.recreateDualBlendTexture();

    this.previewCanvas.width = width;
    this.previewCanvas.height = height;

    this.recreateReadbackBuffers();

    this.clear();
  }

  /**
   * Begin a new stroke
   */
  beginStroke(): void {
    this.clear();
    this.active = true;
    this.dabsSinceLastFlush = 0;

    // Clear GPU buffers
    this.pingPongBuffer.clear(this.device);

    // Sync color blend mode from store
    this.syncColorBlendMode();

    // Sync render scale from store
    this.syncRenderScale();

    // Sync wet edge settings from store
    this.syncWetEdgeSettings();

    // Pre-warm display texture if wet edge is enabled
    // This moves the lazy initialization cost from the first flushBatch to beginStroke
    if (this.wetEdgeEnabled) {
      this.pingPongBuffer.ensureDisplayTexture();
    }
  }

  /**
   * Sync wet edge settings from store
   */
  private syncWetEdgeSettings(): void {
    const { wetEdgeEnabled, wetEdge, brushHardness } = useToolStore.getState();
    const prevEnabled = this.wetEdgeEnabled;
    const nextEnabled = wetEdgeEnabled && wetEdge > 0;
    this.wetEdgeEnabled = nextEnabled;
    this.wetEdgeStrength = wetEdge;
    // Convert hardness from 0-100 to 0-1 range
    this.wetEdgeHardness = brushHardness / 100;

    if (!prevEnabled && nextEnabled) {
      this.debugNextWetEdgeDispatch = true;
      this.debugNextWetEdgeLabel = 'wetedge-enable';
      this.debugNextPreviewReadback = true;
      this.debugNextPreviewLabel = 'wetedge-enable';
      console.log(
        '[GPUStrokeAccumulator] WetEdge enabled: profile next dispatch + preview readback'
      );
    }
  }

  private beginWetEdgeDebug(context: string): { start: number; label: string | null } {
    if (this.debugNextWetEdgeDispatch) {
      this.debugNextWetEdgeDispatch = false;
      const label = this.debugNextWetEdgeLabel ?? 'next';
      this.debugNextWetEdgeLabel = null;
      const start = performance.now();
      console.log(`[GPUStrokeAccumulator] WetEdge ${context} dispatch (${label}) start`);
      return { start, label };
    }

    if (!this.debugFirstWetEdgeDispatch) {
      this.debugFirstWetEdgeDispatch = true;
      const start = performance.now();
      console.log(`[GPUStrokeAccumulator] WetEdge ${context} dispatch first start`);
      return { start, label: 'first' };
    }

    return { start: 0, label: null };
  }

  private endWetEdgeDebug(context: string, start: number, label: string | null): void {
    if (start > 0) {
      const suffix = label ? ` (${label})` : '';
      console.log(
        `[GPUStrokeAccumulator] WetEdge ${context} dispatch${suffix} end: ${(performance.now() - start).toFixed(2)}ms`
      );
    }
  }

  /**
   * Sync color blend mode from store to shader uniform
   */
  private syncColorBlendMode(): void {
    const mode = useSettingsStore.getState().brush.colorBlendMode;
    if (mode !== this.cachedColorBlendMode) {
      this.brushPipeline.updateColorBlendMode(mode);
      this.computeBrushPipeline.updateColorBlendMode(mode);
      this.textureBrushPipeline.updateColorBlendMode(mode);
      this.computeTextureBrushPipeline.updateColorBlendMode(mode);
      this.cachedColorBlendMode = mode;
    }
  }

  /**
   * Sync render scale from store to ping-pong buffer
   * Auto mode: downsample to 50% for soft large brushes (hardness < 70, size > 300)
   */
  private syncRenderScale(): void {
    const { gpuRenderScaleMode: mode } = useSettingsStore.getState().brush;
    const { brushHardness, brushSize } = useToolStore.getState();

    const shouldDownsample = mode === 'auto' && brushHardness < 70 && brushSize > 300;
    const targetScale = shouldDownsample ? 0.5 : 1.0;

    if (mode !== this.cachedRenderScaleMode || targetScale !== this.currentRenderScale) {
      this.cachedRenderScaleMode = mode;
      this.currentRenderScale = targetScale;

      this.pingPongBuffer.setRenderScale(targetScale);
      this.brushPipeline.updateCanvasSize(
        this.pingPongBuffer.textureWidth,
        this.pingPongBuffer.textureHeight
      );
      this.computeBrushPipeline.updateCanvasSize(
        this.pingPongBuffer.textureWidth,
        this.pingPongBuffer.textureHeight
      );
      this.textureBrushPipeline.updateCanvasSize(
        this.pingPongBuffer.textureWidth,
        this.pingPongBuffer.textureHeight
      );
      this.computeTextureBrushPipeline.updateCanvasSize(
        this.pingPongBuffer.textureWidth,
        this.pingPongBuffer.textureHeight
      );
      this.dualMaskBuffer.setRenderScale(targetScale);
      this.computeDualMaskPipeline.updateCanvasSize(
        this.dualMaskBuffer.textureWidth,
        this.dualMaskBuffer.textureHeight
      );
      this.computeDualTextureMaskPipeline.updateCanvasSize(
        this.dualMaskBuffer.textureWidth,
        this.dualMaskBuffer.textureHeight
      );
      this.computeDualBlendPipeline.updateCanvasSize(
        this.pingPongBuffer.textureWidth,
        this.pingPongBuffer.textureHeight
      );
      this.recreateDualBlendTexture();
      this.recreateReadbackBuffers();
    }
  }

  /**
   * Clear the accumulator
   */
  clear(): void {
    this.active = false;
    this.instanceBuffer.clear();
    this.textureInstanceBuffer.clear();
    this.secondaryInstanceBuffer.clear();
    this.secondaryTextureInstanceBuffer.clear();
    this.strokeMode = 'parametric';
    this.dirtyRect = {
      left: this.width,
      top: this.height,
      right: 0,
      bottom: 0,
    };
    this.dualDirtyRect = {
      left: this.width,
      top: this.height,
      right: 0,
      bottom: 0,
    };
    this.previewCtx.clearRect(0, 0, this.width, this.height);
    this.previewCtx.clearRect(0, 0, this.width, this.height);
    this.dabsSinceLastFlush = 0;
    this.currentPatternSettings = null;
    this.patternCache.update(null);
    this.dualBrushEnabled = false;
    this.dualMaskActive = false;
    this.dualBrushMode = null;
    this.dualPostPending = false;
    this.fallbackRequest = null;
    this.dualMaskBuffer.clear(this.device);
  }

  /**
   * Check if stroke is active
   */
  isActive(): boolean {
    return this.active;
  }

  setDualBrushState(enabled: boolean, mode?: DualBlendMode | null): void {
    this.dualBrushEnabled = enabled;
    if (!enabled) {
      this.dualBrushMode = null;
      this.dualMaskActive = false;
      this.dualPostPending = false;
      return;
    }
    if (mode) {
      this.dualBrushMode = mode;
    }
  }

  consumeFallbackRequest(): string | null {
    const reason = this.fallbackRequest;
    this.fallbackRequest = null;
    return reason;
  }

  abortStroke(): void {
    this.clear();
  }

  /**
   * Stamp a secondary (dual brush) dab to the dual mask accumulator.
   */
  stampSecondaryDab(
    x: number,
    y: number,
    size: number,
    dualBrush: DualBrushSettings,
    strokeAngle: number = 0
  ): void {
    if (!this.active) return;

    this.dualBrushEnabled = true;
    this.dualBrushMode = dualBrush.mode;

    const effectiveSize = Math.max(1, size);
    const roundness = Math.max(0.01, Math.min(1, (dualBrush.roundness ?? 100) / 100));
    const isSquashedRoundness = roundness < 0.999;

    let scatterVal = dualBrush.scatter ?? 0;
    if (typeof scatterVal !== 'number') {
      const parsed = parseFloat(String(scatterVal));
      scatterVal = Number.isNaN(parsed) ? 0 : parsed;
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

    const scale = this.currentRenderScale;
    const useTexture = Boolean(dualBrush.texture);

    if (useTexture && dualBrush.texture) {
      if (!this.dualTextureAtlas.setTextureSync(dualBrush.texture)) {
        void this.dualTextureAtlas.setTexture(dualBrush.texture);
        return;
      }
    }

    for (const pos of scatteredPositions) {
      const randomAngle = Math.random() * 360;
      const angleRad = (randomAngle * Math.PI) / 180;

      if (useTexture && dualBrush.texture) {
        const textureDab: TextureDabInstanceData = {
          x: pos.x * scale,
          y: pos.y * scale,
          size: effectiveSize * scale,
          roundness,
          angle: angleRad,
          r: 1,
          g: 1,
          b: 1,
          dabOpacity: 1,
          flow: 1,
          texWidth: dualBrush.texture.width,
          texHeight: dualBrush.texture.height,
        };
        this.secondaryTextureInstanceBuffer.push(textureDab);
        this.dualMaskActive = true;
      } else {
        const radius = effectiveSize / 2;
        const dabData: DabInstanceData = {
          x: pos.x * scale,
          y: pos.y * scale,
          size: radius * scale,
          hardness: isSquashedRoundness ? 0.98 : 1.0,
          r: 1,
          g: 1,
          b: 1,
          dabOpacity: 1,
          flow: 1,
          roundness,
          angleCos: Math.cos(angleRad),
          angleSin: Math.sin(angleRad),
        };
        this.secondaryInstanceBuffer.push(dabData);
        this.dualMaskActive = true;
      }

      const radius = effectiveSize / 2;
      this.expandDualDirtyRect(pos.x, pos.y, radius);
    }
  }

  stampDab(params: GPUDabParams): void {
    if (!this.active) return;

    const rgb = this.hexToRgb(params.color);
    const scale = this.currentRenderScale;

    // Texture brush path - completely separate from parametric brush
    if (params.texture) {
      // Set stroke mode on first dab (cannot mix modes within a stroke)
      if (this.dabsSinceLastFlush === 0 && this.strokeMode === 'parametric') {
        this.strokeMode = 'texture';
      }

      // Try to set texture (may need async loading)
      if (!this.textureAtlas.setTextureSync(params.texture)) {
        // Texture not ready - trigger async load and skip this dab
        void this.textureAtlas.setTexture(params.texture);
        return;
      }

      // Pattern Handling
      // If texture settings changed (e.g. depth, scale, id), we must flush current batch
      // because these are passed as Uniforms to the compute shader.
      const newPatternSettings = this.extractPatternSettings(params.textureSettings);

      if (this.hasPatternSettingsChanged(newPatternSettings)) {
        this.flushTextureBatch(this.dualMaskActive);
        this.dabsSinceLastFlush = 0; // Reset counter after flush
      }

      this.currentPatternSettings = newPatternSettings;
      if (this.currentPatternSettings && this.currentPatternSettings.patternId) {
        // Trigger async load if pattern not yet in cache
        if (!patternManager.hasPattern(this.currentPatternSettings.patternId)) {
          void patternManager.loadPattern(this.currentPatternSettings.patternId);
        }
        this.patternCache.update(this.currentPatternSettings.patternId);
      } else {
        this.patternCache.update(null);
      }

      const textureDabData: TextureDabInstanceData = {
        x: params.x * scale,
        y: params.y * scale,
        size: params.size * scale, // diameter, not radius
        roundness: params.roundness ?? 1.0,
        angle: ((params.angle ?? 0) * Math.PI) / 180, // Convert to radians
        r: rgb.r / 255,
        g: rgb.g / 255,
        b: rgb.b / 255,
        dabOpacity: params.dabOpacity ?? 1.0,
        flow: params.flow,
        texWidth: params.texture.width,
        texHeight: params.texture.height,
      };

      this.textureInstanceBuffer.push(textureDabData);
      // Dirty rect calculation for texture brush
      const halfSize = params.size / 2;
      this.expandDirtyRectTexture(params.x, params.y, halfSize);
      this.dabsSinceLastFlush++;

      // Auto-flush when batch is full to avoid triggering dispatchInBatches
      // which has ping-pong bugs causing stroke discontinuity
      if (this.textureInstanceBuffer.count >= GPUStrokeAccumulator.MAX_SAFE_BATCH_SIZE) {
        this.flushTextureBatch(this.dualMaskActive);
      }

      return;
    }

    // Parametric brush path
    // Pattern Handling for Parametric Brush
    const newPatternSettings = this.extractPatternSettings(params.textureSettings);

    if (this.hasPatternSettingsChanged(newPatternSettings)) {
      this.flushTextureBatch(this.dualMaskActive); // Flush texture batch too to be safe (shared state)
      this.flushBatch(this.dualMaskActive);
      this.dabsSinceLastFlush = 0;
    }

    this.currentPatternSettings = newPatternSettings;
    if (this.currentPatternSettings?.patternId) {
      // Trigger async load if pattern not yet in cache
      const patternId = this.currentPatternSettings.patternId;
      if (!patternManager.hasPattern(patternId)) {
        void patternManager.loadPattern(patternId);
      }
      this.patternCache.update(patternId);
    } else {
      this.patternCache.update(null);
    }

    const radius = params.size / 2;
    // Precompute angle trigonometry and clamp roundness on CPU
    const roundness = Math.max(params.roundness ?? 1.0, 0.01);
    const angleRad = ((params.angle ?? 0) * Math.PI) / 180;
    const dabData: DabInstanceData = {
      x: params.x * scale,
      y: params.y * scale,
      size: radius * scale,
      hardness: params.hardness,
      r: rgb.r / 255,
      g: rgb.g / 255,
      b: rgb.b / 255,
      dabOpacity: params.dabOpacity ?? 1.0,
      flow: params.flow,
      roundness: roundness,
      angleCos: Math.cos(angleRad),
      angleSin: Math.sin(angleRad),
    };

    this.instanceBuffer.push(dabData);

    // Dirty rect is in logical coordinates (for preview canvas)
    this.expandDirtyRect(params.x, params.y, radius, params.hardness);
    this.dabsSinceLastFlush++;

    // Auto-flush when batch is full to avoid triggering dispatchInBatches
    // which has ping-pong bugs causing stroke discontinuity
    if (this.instanceBuffer.count >= GPUStrokeAccumulator.MAX_SAFE_BATCH_SIZE) {
      this.flushBatch(this.dualMaskActive);
    }
  }

  /**
   * Expand dirty rect for texture brush (simpler calculation)
   */
  private expandDirtyRectTexture(x: number, y: number, halfSize: number): void {
    const margin = 2;
    this.dirtyRect.left = Math.min(this.dirtyRect.left, Math.floor(x - halfSize - margin));
    this.dirtyRect.top = Math.min(this.dirtyRect.top, Math.floor(y - halfSize - margin));
    this.dirtyRect.right = Math.max(this.dirtyRect.right, Math.ceil(x + halfSize + margin));
    this.dirtyRect.bottom = Math.max(this.dirtyRect.bottom, Math.ceil(y + halfSize + margin));
  }

  private expandDirtyRect(x: number, y: number, radius: number, hardness: number): void {
    const effectiveRadius = calculateEffectiveRadius(radius, hardness);
    const margin = 2;
    this.dirtyRect.left = Math.min(this.dirtyRect.left, Math.floor(x - effectiveRadius - margin));
    this.dirtyRect.top = Math.min(this.dirtyRect.top, Math.floor(y - effectiveRadius - margin));
    this.dirtyRect.right = Math.max(this.dirtyRect.right, Math.ceil(x + effectiveRadius + margin));
    this.dirtyRect.bottom = Math.max(
      this.dirtyRect.bottom,
      Math.ceil(y + effectiveRadius + margin)
    );
  }

  private expandDualDirtyRect(x: number, y: number, radius: number): void {
    const margin = 2;
    this.dualDirtyRect.left = Math.min(this.dualDirtyRect.left, Math.floor(x - radius - margin));
    this.dualDirtyRect.top = Math.min(this.dualDirtyRect.top, Math.floor(y - radius - margin));
    this.dualDirtyRect.right = Math.max(this.dualDirtyRect.right, Math.ceil(x + radius + margin));
    this.dualDirtyRect.bottom = Math.max(this.dualDirtyRect.bottom, Math.ceil(y + radius + margin));
  }

  private hasDirtyRect(rect: Rect): boolean {
    return rect.right > rect.left && rect.bottom > rect.top;
  }

  private getCombinedDirtyRect(): Rect {
    const primaryValid = this.hasDirtyRect(this.dirtyRect);
    const dualValid = this.dualMaskActive && this.hasDirtyRect(this.dualDirtyRect);

    if (!primaryValid && dualValid) {
      return { ...this.dualDirtyRect };
    }
    if (!dualValid) {
      return { ...this.dirtyRect };
    }

    return {
      left: Math.min(this.dirtyRect.left, this.dualDirtyRect.left),
      top: Math.min(this.dirtyRect.top, this.dualDirtyRect.top),
      right: Math.max(this.dirtyRect.right, this.dualDirtyRect.right),
      bottom: Math.max(this.dirtyRect.bottom, this.dualDirtyRect.bottom),
    };
  }

  /**
   * Force flush pending dabs to GPU (used for benchmarking)
   */
  flush(): void {
    if (this.deviceLost && this.dualBrushEnabled) {
      this.requestCpuFallback('GPU device lost');
      return;
    }

    const debugFirst = !this.debugFirstFlush;
    let debugMark = 0;
    if (debugFirst) {
      this.debugFirstFlush = true;
      debugMark = performance.now();
      console.log('[GPUStrokeAccumulator] First flush start');
    }

    const deferPost = this.dualMaskActive;

    const primaryDidFlush =
      this.strokeMode === 'texture'
        ? this.flushTextureBatch(deferPost)
        : this.flushBatch(deferPost);

    if (debugFirst) {
      const now = performance.now();
      console.log(`[GPUStrokeAccumulator] First flush primary: ${(now - debugMark).toFixed(2)}ms`);
      debugMark = now;
    }

    if (this.fallbackRequest) {
      return;
    }

    const secondaryDidFlush = this.flushSecondaryBatches();

    if (debugFirst) {
      const now = performance.now();
      console.log(
        `[GPUStrokeAccumulator] First flush secondary: ${(now - debugMark).toFixed(2)}ms`
      );
      debugMark = now;
    }

    if (this.fallbackRequest) {
      return;
    }

    if (this.dualMaskActive && (primaryDidFlush || secondaryDidFlush || this.dualPostPending)) {
      this.applyDualBlend();
      this.dualPostPending = false;
      if (debugFirst) {
        const now = performance.now();
        console.log(
          `[GPUStrokeAccumulator] First flush dual+wet: ${(now - debugMark).toFixed(2)}ms`
        );
        debugMark = now;
      }
    }
  }

  /**
   * Flush pending dabs to GPU using Compute Shader (optimized path)
   * or per-dab Render Pipeline (fallback path).
   */
  private flushBatch(deferPost: boolean = false): boolean {
    if (this.instanceBuffer.count === 0) {
      return false;
    }

    this.cpuTimer.start();

    // 1. Get data and upload to GPU
    const dabs = this.instanceBuffer.getDabsData();
    const bbox = this.instanceBuffer.getBoundingBox();

    // Flush uploads to GPU and resets the pending/bbox counters
    const { buffer: gpuBatchBuffer } = this.instanceBuffer.flush();

    const encoder = this.device.createCommandEncoder({
      label: 'Brush Batch Encoder',
    });

    // Try compute shader path first
    if (this.useComputeShader) {
      // Compute shader: batch all dabs in single dispatch
      // IMPORTANT: Copy the ENTIRE source to dest before dispatch
      // This ensures Compute Shader reads the accumulated result from previous flushes
      this.pingPongBuffer.copySourceToDest(encoder);

      let debugStart = 0;
      if (!this.debugFirstPrimaryDispatch) {
        this.debugFirstPrimaryDispatch = true;
        debugStart = performance.now();
        console.log('[GPUStrokeAccumulator] Primary compute first dispatch start');
      }

      // Single dispatch for all dabs
      const success = this.computeBrushPipeline.dispatch(
        encoder,
        this.pingPongBuffer.source,
        this.pingPongBuffer.dest,
        dabs,
        this.patternCache.getTexture(),
        this.currentPatternSettings
      );

      if (debugStart > 0) {
        console.log(
          `[GPUStrokeAccumulator] Primary compute first dispatch end: ${(performance.now() - debugStart).toFixed(2)}ms`
        );
      }

      if (success) {
        // Swap so next flushBatch reads from the updated texture
        this.pingPongBuffer.swap();

        if (!deferPost) {
          // Apply wet edge post-processing if enabled
          // IMPORTANT: Wet edge reads from raw buffer (source) and writes to display buffer
          // It does NOT modify the raw buffer to avoid idempotency issues (Alpha = f(f(Alpha)))
          if (this.wetEdgeEnabled && this.wetEdgeStrength > 0.01) {
            const wetDebug = this.beginWetEdgeDebug('primary');
            this.wetEdgePipeline.dispatch(
              encoder,
              this.pingPongBuffer.source, // Raw buffer (input, read-only)
              this.pingPongBuffer.display, // Display buffer (output)
              this.dirtyRect,
              this.wetEdgeHardness,
              this.wetEdgeStrength,
              this.currentRenderScale
            );
            this.endWetEdgeDebug('primary', wetDebug.start, wetDebug.label);
            // Note: No swap here - display buffer is separate from ping-pong
          }
        } else {
          this.dualPostPending = true;
        }

        void this.profiler.resolveTimestamps(encoder);
        this.device.queue.submit([encoder.finish()]);

        const cpuTime = this.cpuTimer.stop();
        this.profiler.recordFrame({
          dabCount: dabs.length,
          cpuTimeMs: cpuTime,
        });

        if (!deferPost) {
          this.previewNeedsUpdate = true;
          if (!this.previewUpdatePending) {
            void this.updatePreview();
          }
        }
        return true;
      }

      // Compute shader failed, fall through to render pipeline
      console.warn('[GPUStrokeAccumulator] Compute shader failed, falling back to render pipeline');
      if (this.dualBrushEnabled || this.dualMaskActive) {
        this.requestCpuFallback('GPU compute unavailable for dual brush (primary)');
        return false;
      }
    }

    if (!this.useComputeShader && (this.dualBrushEnabled || this.dualMaskActive)) {
      this.requestCpuFallback('GPU compute disabled for dual brush (primary)');
      return false;
    }

    // Fallback: per-dab render pipeline
    this.flushBatchLegacy(dabs, gpuBatchBuffer, bbox, encoder);
    return true;
  }

  /**
   * Legacy per-dab render pipeline (fallback when compute shader unavailable)
   */
  private flushBatchLegacy(
    dabs: DabInstanceData[],
    gpuBatchBuffer: GPUBuffer,
    bbox: { x: number; y: number; width: number; height: number },
    encoder: GPUCommandEncoder
  ): void {
    // Setup scissor
    const scissor = this.computeScissorRect(bbox);

    // Render loop
    let prevDabRect: { x: number; y: number; w: number; h: number } | null = null;

    for (let i = 0; i < dabs.length; i++) {
      const dab = dabs[i]!;
      const dabRect = this.computeDabBounds(dab);

      // Partial Copy Logic: Sync Dest with Source
      if (i === 0) {
        // First dab: copy accumulated dirty rect
        // IMPORTANT: dirtyRect is in logical coordinates, need to scale to texture space
        const dr = this.dirtyRect;
        const scale = this.currentRenderScale;
        const copyX = Math.floor(dr.left * scale);
        const copyY = Math.floor(dr.top * scale);
        const copyW = Math.ceil((dr.right - dr.left) * scale);
        const copyH = Math.ceil((dr.bottom - dr.top) * scale);
        if (copyW > 0 && copyH > 0) {
          this.pingPongBuffer.copyRect(encoder, copyX, copyY, copyW, copyH);
        }
      } else if (prevDabRect) {
        // Subsequent dabs: copy previous dab's bounds
        this.pingPongBuffer.copyRect(
          encoder,
          prevDabRect.x,
          prevDabRect.y,
          prevDabRect.w,
          prevDabRect.h
        );
      }

      // Render Pass
      const pass = encoder.beginRenderPass({
        label: `Dab Pass ${i}`,
        colorAttachments: [
          {
            view: this.pingPongBuffer.dest.createView(),
            loadOp: 'load',
            storeOp: 'store',
          },
        ],
        // Only timestamp first pass
        timestampWrites: i === 0 ? this.profiler.getTimestampWrites() : undefined,
      });

      if (scissor) {
        pass.setScissorRect(scissor.x, scissor.y, scissor.w, scissor.h);
      }

      pass.setPipeline(this.brushPipeline.renderPipeline);
      pass.setBindGroup(0, this.brushPipeline.createBindGroup(this.pingPongBuffer.source));

      // Use offset into the single large batch buffer
      const offset = i * DAB_INSTANCE_SIZE;
      pass.setVertexBuffer(0, gpuBatchBuffer, offset, DAB_INSTANCE_SIZE);
      pass.draw(6, 1);
      pass.end();

      this.pingPongBuffer.swap();
      prevDabRect = dabRect;
    }

    void this.profiler.resolveTimestamps(encoder);
    this.device.queue.submit([encoder.finish()]);

    const cpuTime = this.cpuTimer.stop();
    this.profiler.recordFrame({
      dabCount: dabs.length,
      cpuTimeMs: cpuTime,
    });

    this.previewNeedsUpdate = true;
    if (!this.previewUpdatePending) {
      void this.updatePreview();
    }
  }

  /**
   * Flush pending texture dabs to GPU using Compute Shader (optimized path)
   * or per-dab Render Pipeline (fallback path).
   */
  private flushTextureBatch(deferPost: boolean = false): boolean {
    if (this.textureInstanceBuffer.count === 0) return false;

    const currentTexture = this.textureAtlas.getCurrentTexture();
    if (!currentTexture) {
      console.warn('[GPUStrokeAccumulator] No texture available for texture brush');
      this.textureInstanceBuffer.clear();
      return false;
    }

    this.cpuTimer.start();

    // 1. Get data and upload to GPU
    const dabs = this.textureInstanceBuffer.getDabsData();
    const bbox = this.textureInstanceBuffer.getBoundingBox();
    const { buffer: gpuBatchBuffer } = this.textureInstanceBuffer.flush();

    const encoder = this.device.createCommandEncoder({
      label: 'Texture Brush Batch Encoder',
    });

    // Try compute shader path first
    if (this.useTextureComputeShader) {
      const dr = this.dirtyRect;

      // Copy source to dest to preserve previous strokes
      // NOTE: dirtyRect is in logical coordinates, copyRect will scale them
      const copyW = dr.right - dr.left;
      const copyH = dr.bottom - dr.top;
      if (copyW > 0 && copyH > 0) {
        this.pingPongBuffer.copyRect(encoder, dr.left, dr.top, copyW, copyH);
      }

      let debugStart = 0;
      if (!this.debugFirstPrimaryDispatch) {
        this.debugFirstPrimaryDispatch = true;
        debugStart = performance.now();
        console.log('[GPUStrokeAccumulator] Primary texture compute first dispatch start');
      }

      // Single dispatch for all dabs
      const success = this.computeTextureBrushPipeline.dispatch(
        encoder,
        this.pingPongBuffer.source,
        this.pingPongBuffer.dest,
        currentTexture,
        dabs,
        this.patternCache.getTexture(),
        this.currentPatternSettings
      );

      if (debugStart > 0) {
        console.log(
          `[GPUStrokeAccumulator] Primary texture compute first dispatch end: ${(performance.now() - debugStart).toFixed(2)}ms`
        );
      }

      if (success) {
        // Swap so next flushBatch reads from the updated texture
        this.pingPongBuffer.swap();

        if (!deferPost) {
          // Apply wet edge post-processing if enabled
          // IMPORTANT: Wet edge reads from raw buffer (source) and writes to display buffer
          // It does NOT modify the raw buffer to avoid idempotency issues (Alpha = f(f(Alpha)))
          if (this.wetEdgeEnabled && this.wetEdgeStrength > 0.01) {
            const wetDebug = this.beginWetEdgeDebug('primary-texture');
            this.wetEdgePipeline.dispatch(
              encoder,
              this.pingPongBuffer.source, // Raw buffer (input, read-only)
              this.pingPongBuffer.display, // Display buffer (output)
              this.dirtyRect,
              0.0, // Texture brushes: always treat as soft to enable full wet edge effect
              this.wetEdgeStrength,
              this.currentRenderScale
            );
            this.endWetEdgeDebug('primary-texture', wetDebug.start, wetDebug.label);
            // Note: No swap here - display buffer is separate from ping-pong
          }
        } else {
          this.dualPostPending = true;
        }

        void this.profiler.resolveTimestamps(encoder);
        this.device.queue.submit([encoder.finish()]);

        const cpuTime = this.cpuTimer.stop();
        this.profiler.recordFrame({
          dabCount: dabs.length,
          cpuTimeMs: cpuTime,
        });

        if (!deferPost) {
          this.previewNeedsUpdate = true;
          if (!this.previewUpdatePending) {
            void this.updatePreview();
          }
        }
        return true;
      }

      // Compute shader failed, fall through to render pipeline
      console.warn(
        '[GPUStrokeAccumulator] Texture compute shader failed, falling back to render pipeline'
      );
      if (this.dualBrushEnabled || this.dualMaskActive) {
        this.requestCpuFallback('GPU compute unavailable for dual brush (texture)');
        return false;
      }
    }

    if (!this.useTextureComputeShader && (this.dualBrushEnabled || this.dualMaskActive)) {
      this.requestCpuFallback('GPU compute disabled for dual brush (texture)');
      return false;
    }

    // Fallback: per-dab render pipeline
    this.flushTextureBatchLegacy(dabs, gpuBatchBuffer, bbox, encoder, currentTexture);
    return true;
  }

  /**
   * Legacy per-dab render pipeline for texture brush (fallback when compute shader unavailable)
   */
  private flushTextureBatchLegacy(
    dabs: TextureDabInstanceData[],
    gpuBatchBuffer: GPUBuffer,
    bbox: { x: number; y: number; width: number; height: number },
    encoder: GPUCommandEncoder,
    currentTexture: import('./resources/TextureAtlas').GPUBrushTexture
  ): void {
    // Setup scissor
    const scissor = this.computeScissorRect(bbox);

    // Render loop
    let prevDabRect: { x: number; y: number; w: number; h: number } | null = null;

    for (let i = 0; i < dabs.length; i++) {
      const dab = dabs[i]!;
      const dabRect = this.computeTextureDabBounds(dab);

      // Partial Copy Logic: Sync Dest with Source
      if (i === 0) {
        const dr = this.dirtyRect;
        const scale = this.currentRenderScale;
        const copyX = Math.floor(dr.left * scale);
        const copyY = Math.floor(dr.top * scale);
        const copyW = Math.ceil((dr.right - dr.left) * scale);
        const copyH = Math.ceil((dr.bottom - dr.top) * scale);
        if (copyW > 0 && copyH > 0) {
          this.pingPongBuffer.copyRect(encoder, copyX, copyY, copyW, copyH);
        }
      } else if (prevDabRect) {
        this.pingPongBuffer.copyRect(
          encoder,
          prevDabRect.x,
          prevDabRect.y,
          prevDabRect.w,
          prevDabRect.h
        );
      }

      // Render Pass
      const pass = encoder.beginRenderPass({
        label: `Texture Dab Pass ${i}`,
        colorAttachments: [
          {
            view: this.pingPongBuffer.dest.createView(),
            loadOp: 'load',
            storeOp: 'store',
          },
        ],
        timestampWrites: i === 0 ? this.profiler.getTimestampWrites() : undefined,
      });

      if (scissor) {
        pass.setScissorRect(scissor.x, scissor.y, scissor.w, scissor.h);
      }

      pass.setPipeline(this.textureBrushPipeline.renderPipeline);
      pass.setBindGroup(
        0,
        this.textureBrushPipeline.createBindGroup(this.pingPongBuffer.source, currentTexture)
      );

      const offset = i * TEXTURE_DAB_INSTANCE_SIZE;
      pass.setVertexBuffer(0, gpuBatchBuffer, offset, TEXTURE_DAB_INSTANCE_SIZE);
      pass.draw(6, 1);
      pass.end();

      this.pingPongBuffer.swap();
      prevDabRect = dabRect;
    }

    void this.profiler.resolveTimestamps(encoder);
    this.device.queue.submit([encoder.finish()]);

    const cpuTime = this.cpuTimer.stop();
    this.profiler.recordFrame({
      dabCount: dabs.length,
      cpuTimeMs: cpuTime,
    });

    this.previewNeedsUpdate = true;
    if (!this.previewUpdatePending) {
      void this.updatePreview();
    }
  }

  private flushSecondaryBatches(): boolean {
    let didFlush = false;

    if (this.secondaryInstanceBuffer.count > 0) {
      if (!this.useComputeShader) {
        this.requestCpuFallback('GPU compute disabled for dual brush (secondary)');
        this.secondaryInstanceBuffer.clear();
        return false;
      }

      const dabs = this.secondaryInstanceBuffer.getDabsData();
      this.secondaryInstanceBuffer.clear();

      const encoder = this.device.createCommandEncoder({
        label: 'Dual Mask Batch Encoder',
      });

      // Preserve previous mask data
      this.dualMaskBuffer.copySourceToDest(encoder);

      let debugStart = 0;
      if (!this.debugFirstSecondaryDispatch) {
        this.debugFirstSecondaryDispatch = true;
        debugStart = performance.now();
        console.log('[GPUStrokeAccumulator] Secondary dual mask first dispatch start');
      }

      const success = this.computeDualMaskPipeline.dispatch(
        encoder,
        this.dualMaskBuffer.source,
        this.dualMaskBuffer.dest,
        dabs
      );

      if (debugStart > 0) {
        console.log(
          `[GPUStrokeAccumulator] Secondary dual mask first dispatch end: ${(performance.now() - debugStart).toFixed(2)}ms`
        );
      }

      if (!success) {
        this.requestCpuFallback('GPU dual mask compute failed');
        return false;
      }

      this.dualMaskBuffer.swap();
      this.device.queue.submit([encoder.finish()]);
      didFlush = true;
    }

    if (this.secondaryTextureInstanceBuffer.count > 0) {
      if (!this.useTextureComputeShader) {
        this.requestCpuFallback('GPU compute disabled for dual brush (secondary texture)');
        this.secondaryTextureInstanceBuffer.clear();
        return false;
      }

      const currentTexture = this.dualTextureAtlas.getCurrentTexture();
      if (!currentTexture) {
        console.warn('[GPUStrokeAccumulator] No texture available for dual brush');
        this.secondaryTextureInstanceBuffer.clear();
        return didFlush;
      }

      const dabs = this.secondaryTextureInstanceBuffer.getDabsData();
      this.secondaryTextureInstanceBuffer.clear();

      const encoder = this.device.createCommandEncoder({
        label: 'Dual Texture Mask Batch Encoder',
      });

      this.dualMaskBuffer.copySourceToDest(encoder);

      let debugStart = 0;
      if (!this.debugFirstSecondaryDispatch) {
        this.debugFirstSecondaryDispatch = true;
        debugStart = performance.now();
        console.log('[GPUStrokeAccumulator] Secondary dual texture mask first dispatch start');
      }

      const success = this.computeDualTextureMaskPipeline.dispatch(
        encoder,
        this.dualMaskBuffer.source,
        this.dualMaskBuffer.dest,
        currentTexture.texture,
        dabs
      );

      if (debugStart > 0) {
        console.log(
          `[GPUStrokeAccumulator] Secondary dual texture mask first dispatch end: ${(performance.now() - debugStart).toFixed(2)}ms`
        );
      }

      if (!success) {
        this.requestCpuFallback('GPU dual texture mask compute failed');
        return false;
      }

      this.dualMaskBuffer.swap();
      this.device.queue.submit([encoder.finish()]);
      didFlush = true;
    }

    return didFlush;
  }

  private applyDualBlend(): void {
    if (!this.dualBrushMode || !this.dualMaskActive) {
      return;
    }

    const rect = this.getCombinedDirtyRect();
    if (!this.hasDirtyRect(rect)) {
      return;
    }

    let debugStart = 0;
    if (!this.debugFirstDualBlend) {
      this.debugFirstDualBlend = true;
      debugStart = performance.now();
      console.log('[GPUStrokeAccumulator] Dual blend first dispatch start');
    }

    const encoder = this.device.createCommandEncoder({
      label: 'Dual Blend Encoder',
    });

    this.computeDualBlendPipeline.dispatch(
      encoder,
      this.pingPongBuffer.source,
      this.dualMaskBuffer.source,
      this.dualBlendTexture,
      rect,
      this.mapDualBlendMode(this.dualBrushMode),
      this.currentRenderScale
    );

    if (debugStart > 0) {
      console.log(
        `[GPUStrokeAccumulator] Dual blend first dispatch end: ${(performance.now() - debugStart).toFixed(2)}ms`
      );
    }

    if (this.wetEdgeEnabled && this.wetEdgeStrength > 0.01) {
      const wetDebug = this.beginWetEdgeDebug('dual');
      const hardness = this.strokeMode === 'texture' ? 0.0 : this.wetEdgeHardness;
      this.wetEdgePipeline.dispatch(
        encoder,
        this.dualBlendTexture,
        this.pingPongBuffer.display,
        rect,
        hardness,
        this.wetEdgeStrength,
        this.currentRenderScale
      );
      this.endWetEdgeDebug('dual', wetDebug.start, wetDebug.label);
    }

    this.device.queue.submit([encoder.finish()]);

    this.previewNeedsUpdate = true;
    if (!this.previewUpdatePending) {
      void this.updatePreview();
    }
  }

  private mapDualBlendMode(mode: DualBlendMode): number {
    switch (mode) {
      case 'multiply':
        return 0;
      case 'darken':
        return 1;
      case 'overlay':
        return 2;
      case 'colorDodge':
        return 3;
      case 'colorBurn':
        return 4;
      case 'linearBurn':
        return 5;
      case 'hardMix':
        return 6;
      case 'linearHeight':
        return 7;
      default:
        return 0;
    }
  }

  private requestCpuFallback(reason: string): void {
    if (this.fallbackRequest) return;
    this.fallbackRequest = reason;
  }

  /**
   * Calculate bounding box for a texture dab
   */
  private computeTextureDabBounds(dab: TextureDabInstanceData): {
    x: number;
    y: number;
    w: number;
    h: number;
  } {
    const margin = 2;
    const halfSize = dab.size / 2 + margin;
    return {
      x: Math.floor(dab.x - halfSize),
      y: Math.floor(dab.y - halfSize),
      w: Math.ceil(halfSize * 2),
      h: Math.ceil(halfSize * 2),
    };
  }

  /**
   * Calculate scissor rect for the batch (in texture coordinates)
   */
  private computeScissorRect(bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): { x: number; y: number; w: number; h: number } | null {
    if (bbox.width <= 0 || bbox.height <= 0) return null;

    // bbox is already in texture coordinates (scaled by renderScale in stampDab)
    const texW = this.pingPongBuffer.textureWidth;
    const texH = this.pingPongBuffer.textureHeight;

    const x = Math.max(0, Math.floor(bbox.x));
    const y = Math.max(0, Math.floor(bbox.y));
    const w = Math.min(texW - x, Math.ceil(bbox.width));
    const h = Math.min(texH - y, Math.ceil(bbox.height));

    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }

  /**
   * Calculate bounding box for a single dab (including AA margin)
   */
  private computeDabBounds(dab: DabInstanceData): { x: number; y: number; w: number; h: number } {
    const margin = 2;
    const dabRadius = calculateEffectiveRadius(dab.size, dab.hardness) + margin;
    return {
      x: Math.floor(dab.x - dabRadius),
      y: Math.floor(dab.y - dabRadius),
      w: Math.ceil(dabRadius * 2),
      h: Math.ceil(dabRadius * 2),
    };
  }

  /**
   * Async update preview canvas from GPU texture
   * Uses Promise storage and buffer state guard to prevent race conditions
   * Optimization 5: Mark retry when buffer busy instead of silent skip
   * Optimization 8: Handle buffer deadlock defense
   */
  private async updatePreview(): Promise<void> {
    // Optimization 1: If already running, return existing promise (most efficient wait)
    if (this.currentPreviewPromise) {
      return this.currentPreviewPromise;
    }

    if (!this.previewReadbackBuffer) {
      return;
    }

    // Optimization 8: If buffer is mapped but no promise (shouldn't happen), try to unmap
    if (this.previewReadbackBuffer.mapState === 'mapped') {
      try {
        this.previewReadbackBuffer.unmap();
      } catch {
        // Ignore unmap errors
      }
    }

    // Optimization 5: If buffer is pending, mark retry instead of silent skip
    if (this.previewReadbackBuffer.mapState !== 'unmapped') {
      console.warn('[GPUStrokeAccumulator] Buffer is not unmapped, will retry');
      this.previewNeedsUpdate = true; // Ensure next call will retry
      return;
    }

    this.previewNeedsUpdate = false;

    // Store the promise for concurrent access
    let debugLabel: string | null = null;
    if (this.debugNextPreviewReadback) {
      debugLabel = this.debugNextPreviewLabel ?? 'next';
      this.debugNextPreviewReadback = false;
      this.debugNextPreviewLabel = null;
    } else if (!this.debugFirstPreviewReadback) {
      this.debugFirstPreviewReadback = true;
      debugLabel = 'first';
    }

    const debugStart = debugLabel ? performance.now() : 0;
    if (debugLabel) {
      const presentable =
        this.wetEdgeEnabled && this.wetEdgeStrength > 0.01
          ? 'wetedge'
          : this.dualMaskActive
            ? 'dual'
            : 'raw';
      console.log(
        `[GPUStrokeAccumulator] Preview readback ${debugLabel} start (presentable=${presentable})`
      );
    }

    this.currentPreviewPromise = (async () => {
      let mapStart = 0;
      let mapEnd = 0;
      let cpuEnd = 0;
      let putEnd = 0;
      try {
        // Copy current texture to preview readback buffer
        const encoder = this.device.createCommandEncoder();
        const texW = this.pingPongBuffer.textureWidth;
        const texH = this.pingPongBuffer.textureHeight;
        // Use getPresentableTexture() to get the correct texture (with or without wet edge)
        encoder.copyTextureToBuffer(
          { texture: this.getPresentableTexture() },
          { buffer: this.previewReadbackBuffer!, bytesPerRow: this.readbackBytesPerRow },
          [texW, texH]
        );
        this.device.queue.submit([encoder.finish()]);

        // Wait for GPU and map buffer
        if (debugLabel) {
          mapStart = performance.now();
        }
        await this.previewReadbackBuffer!.mapAsync(GPUMapMode.READ);
        if (debugLabel) {
          mapEnd = performance.now();
        }
        const gpuData = new Float32Array(this.previewReadbackBuffer!.getMappedRange());

        // Get dirty rect bounds (in logical/canvas coordinates) - use integers
        const combinedRect = this.getCombinedDirtyRect();
        const rect = {
          left: Math.floor(Math.max(0, combinedRect.left)),
          top: Math.floor(Math.max(0, combinedRect.top)),
          right: Math.ceil(Math.min(this.width, combinedRect.right)),
          bottom: Math.ceil(Math.min(this.height, combinedRect.bottom)),
        };

        const rectWidth = rect.right - rect.left;
        const rectHeight = rect.bottom - rect.top;
        const scale = this.currentRenderScale;

        if (rectWidth > 0 && rectHeight > 0) {
          // Create ImageData for the dirty region (full resolution preview)
          const imageData = this.previewCtx.createImageData(rectWidth, rectHeight);
          const floatsPerRow = this.readbackBytesPerRow / 4;

          // Get selection mask for real-time clipping during preview
          const selectionState = useSelectionStore.getState();
          const selectionMask = selectionState.hasSelection ? selectionState.selectionMask : null;

          // Sample from scaled texture with bilinear-ish nearest neighbor
          for (let py = 0; py < rectHeight; py++) {
            for (let px = 0; px < rectWidth; px++) {
              // Global canvas coordinates for this pixel
              const globalX = rect.left + px;
              const globalY = rect.top + py;

              // Get selection mask alpha for anti-aliased blending
              let maskBlend = 1.0;
              if (selectionMask) {
                if (
                  globalX >= 0 &&
                  globalX < selectionMask.width &&
                  globalY >= 0 &&
                  globalY < selectionMask.height
                ) {
                  const maskIdx = (globalY * selectionMask.width + globalX) * 4 + 3;
                  const maskAlpha = selectionMask.data[maskIdx] ?? 0;
                  if (maskAlpha === 0) continue; // Skip fully outside pixels
                  maskBlend = maskAlpha / 255; // Use as blend factor for AA
                } else {
                  continue; // Skip pixels outside mask bounds
                }
              }

              // Map preview pixel to texture pixel (nearest neighbor)
              const texX = Math.floor(globalX * scale);
              const texY = Math.floor(globalY * scale);
              const srcIdx = texY * floatsPerRow + texX * 4;
              const dstIdx = (py * rectWidth + px) * 4;

              // Convert float (0-1) to uint8 (0-255), applying mask blend for AA
              imageData.data[dstIdx] = Math.round((gpuData[srcIdx] ?? 0) * 255);
              imageData.data[dstIdx + 1] = Math.round((gpuData[srcIdx + 1] ?? 0) * 255);
              imageData.data[dstIdx + 2] = Math.round((gpuData[srcIdx + 2] ?? 0) * 255);
              imageData.data[dstIdx + 3] = Math.round((gpuData[srcIdx + 3] ?? 0) * 255 * maskBlend);
            }
          }

          if (debugLabel) {
            cpuEnd = performance.now();
          }

          this.previewCtx.putImageData(imageData, rect.left, rect.top);
          if (debugLabel) {
            putEnd = performance.now();
          }
        } else if (debugLabel) {
          cpuEnd = mapEnd;
          putEnd = mapEnd;
        }

        this.previewReadbackBuffer!.unmap();
      } catch (e) {
        console.error('[GPUStrokeAccumulator] Preview update failed:', e);
      } finally {
        if (debugStart > 0) {
          const total = performance.now() - debugStart;
          const mapMs = mapEnd > mapStart ? mapEnd - mapStart : 0;
          const cpuMs = cpuEnd > mapEnd ? cpuEnd - mapEnd : 0;
          const putMs = putEnd > cpuEnd ? putEnd - cpuEnd : 0;
          const label = debugLabel ?? 'debug';
          console.log(
            `[GPUStrokeAccumulator] Preview readback ${label} end: total=${total.toFixed(2)}ms map=${mapMs.toFixed(2)}ms cpu=${cpuMs.toFixed(2)}ms put=${putMs.toFixed(2)}ms`
          );
        }
        this.currentPreviewPromise = null;
        this.previewUpdatePending = false;
        // If more updates were requested while we were updating, do another round
        if (this.previewNeedsUpdate) {
          void this.updatePreview();
        }
      }
    })();

    await this.currentPreviewPromise;
  }

  /**
   * End stroke and composite to layer (legacy API for backward compatibility)
   * Uses previewCanvas as source to ensure WYSIWYG (preview = composite)
   * @returns The dirty rectangle that was modified
   */
  async endStroke(layerCtx: CanvasRenderingContext2D, opacity: number): Promise<Rect> {
    await this.prepareEndStroke();
    return this.compositeToLayer(layerCtx, opacity);
  }

  /**
   * Prepare for end stroke - flush remaining dabs and wait for GPU/preview ready
   * This is the async part that can be awaited before the sync composite
   * Optimization 2: Split async preparation from sync composite for atomic transaction
   * Optimization 6: Always execute updatePreview to ensure data completeness
   */
  async prepareEndStroke(): Promise<void> {
    if (!this.active) {
      return;
    }

    if (this.fallbackRequest) {
      return;
    }

    // Optimization 3: Context Lost defense
    if (this.deviceLost) {
      console.warn('[GPUStrokeAccumulator] GPU device lost during prepareEndStroke');
      return;
    }

    // Flush any remaining dabs (including dual brush if active)
    this.flush();

    // Wait for GPU to complete all submitted work
    await this.device.queue.onSubmittedWorkDone();

    // Wait for any in-progress preview update to complete (using Promise, not polling)
    if (this.currentPreviewPromise) {
      await this.currentPreviewPromise;
    }

    // Optimization 6: Always execute updatePreview to ensure final batch is readback
    // Even if previewNeedsUpdate is false, we need to guarantee data completeness
    await this.updatePreview();
  }

  /**
   * Composite stroke to layer - synchronous operation
   * Must be called after prepareEndStroke() completes
   * Optimization 2: This is the sync part that should be in same JS task as clear()
   * Optimization 4: Removed !this.active check - caller guarantees correctness
   * @returns The dirty rectangle that was modified
   */
  compositeToLayer(layerCtx: CanvasRenderingContext2D, opacity: number): Rect {
    // Optimization 4: No active check here - caller (useBrushRenderer) guarantees
    // this is called immediately after prepareEndStroke() in same sync block.
    // The old check caused stroke loss when user started new stroke during await.

    // Composite from previewCanvas (not GPU texture) to ensure WYSIWYG
    this.compositeFromPreview(layerCtx, opacity);

    this.active = false;

    // Return clamped dirty rect
    return {
      left: Math.max(0, this.dirtyRect.left),
      top: Math.max(0, this.dirtyRect.top),
      right: Math.min(this.width, this.dirtyRect.right),
      bottom: Math.min(this.height, this.dirtyRect.bottom),
    };
  }

  /**
   * Composite from previewCanvas to layer (WYSIWYG approach)
   * Uses the same data that was displayed as preview
   * Applies selection mask clipping if active
   */
  private compositeFromPreview(layerCtx: CanvasRenderingContext2D, opacity: number): void {
    // Use integer coordinates for consistent mask lookup
    const rect = {
      left: Math.floor(Math.max(0, this.dirtyRect.left)),
      top: Math.floor(Math.max(0, this.dirtyRect.top)),
      right: Math.ceil(Math.min(this.width, this.dirtyRect.right)),
      bottom: Math.ceil(Math.min(this.height, this.dirtyRect.bottom)),
    };

    const rectWidth = rect.right - rect.left;
    const rectHeight = rect.bottom - rect.top;

    if (rectWidth <= 0 || rectHeight <= 0) return;

    // Read stroke data from previewCanvas (same as what user saw)
    const strokeData = this.previewCtx.getImageData(rect.left, rect.top, rectWidth, rectHeight);

    // Get layer data for compositing
    const layerData = layerCtx.getImageData(rect.left, rect.top, rectWidth, rectHeight);

    // Get selection mask for clipping
    const selectionState = useSelectionStore.getState();
    const selectionMask = selectionState.hasSelection ? selectionState.selectionMask : null;

    // Composite using Porter-Duff over
    for (let i = 0; i < strokeData.data.length; i += 4) {
      const strokeR = strokeData.data[i]!;
      const strokeG = strokeData.data[i + 1]!;
      const strokeB = strokeData.data[i + 2]!;
      const strokeA = strokeData.data[i + 3]! / 255;

      if (strokeA < 0.001) continue;

      // Selection mask clipping: get mask blend factor for anti-aliased edges
      let maskBlend = 1.0;
      if (selectionMask) {
        const pixelIndex = i / 4;
        const localX = pixelIndex % rectWidth;
        const localY = Math.floor(pixelIndex / rectWidth);
        const globalX = rect.left + localX;
        const globalY = rect.top + localY;

        // Check if pixel is within selection mask
        if (
          globalX >= 0 &&
          globalX < selectionMask.width &&
          globalY >= 0 &&
          globalY < selectionMask.height
        ) {
          const maskIdx = (globalY * selectionMask.width + globalX) * 4 + 3;
          const maskAlpha = selectionMask.data[maskIdx] ?? 0;
          if (maskAlpha === 0) continue; // Skip fully outside pixels
          maskBlend = maskAlpha / 255; // Use as blend factor for AA
        } else {
          continue; // Skip pixels outside mask bounds
        }
      }

      // Apply opacity scaling with mask blend for anti-aliased edges
      const srcAlpha = strokeA * opacity * maskBlend;

      const dstR = layerData.data[i]!;
      const dstG = layerData.data[i + 1]!;
      const dstB = layerData.data[i + 2]!;
      const dstAlpha = layerData.data[i + 3]! / 255;

      // Porter-Duff over
      const outAlpha = srcAlpha + dstAlpha * (1 - srcAlpha);

      if (outAlpha > 0) {
        layerData.data[i] = Math.round(
          (strokeR * srcAlpha + dstR * dstAlpha * (1 - srcAlpha)) / outAlpha
        );
        layerData.data[i + 1] = Math.round(
          (strokeG * srcAlpha + dstG * dstAlpha * (1 - srcAlpha)) / outAlpha
        );
        layerData.data[i + 2] = Math.round(
          (strokeB * srcAlpha + dstB * dstAlpha * (1 - srcAlpha)) / outAlpha
        );
        layerData.data[i + 3] = Math.round(outAlpha * 255);
      }
    }

    // Write back to layer
    layerCtx.putImageData(layerData, rect.left, rect.top);
  }

  /**
   * Get preview canvas for display during stroke
   * Updated asynchronously via updatePreview() after each flushBatch()
   */
  getCanvas(): HTMLCanvasElement {
    return this.previewCanvas;
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
   * Get performance summary
   */
  getPerformanceSummary() {
    return this.profiler.getSummary();
  }

  /**
   * Get the presentable texture for preview/composite.
   * Returns the display texture (with wet edge applied) if wet edge is enabled,
   * otherwise returns the raw accumulator texture.
   */
  public getPresentableTexture(): GPUTexture {
    if (this.wetEdgeEnabled && this.wetEdgeStrength > 0.01) {
      return this.pingPongBuffer.display; // Wet edge applied texture
    }
    if (this.dualMaskActive) {
      return this.dualBlendTexture;
    }
    return this.pingPongBuffer.source; // Raw accumulator texture
  }

  /**
   * Parse hex color to RGB
   */
  private hexToRgb(hex: string): { r: number; g: number; b: number } {
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
   * Release all GPU resources
   */
  destroy(): void {
    this.pingPongBuffer.destroy();
    this.instanceBuffer.destroy();
    this.brushPipeline.destroy();
    this.computeBrushPipeline.destroy();
    this.textureInstanceBuffer.destroy();
    this.textureBrushPipeline.destroy();
    this.computeTextureBrushPipeline.destroy();
    this.textureAtlas.destroy();
    this.secondaryInstanceBuffer.destroy();
    this.secondaryTextureInstanceBuffer.destroy();
    this.dualMaskBuffer.destroy();
    this.dualBlendTexture.destroy();
    this.dualTextureAtlas.destroy();
    this.computeDualMaskPipeline.destroy();
    this.computeDualTextureMaskPipeline.destroy();
    this.computeDualBlendPipeline.destroy();
    this.wetEdgePipeline.destroy();
    this.readbackBuffer?.destroy();
    this.previewReadbackBuffer?.destroy();
    this.profiler.destroy();
  }
  /**
   * Extract GPU-compatible pattern settings from generic settings
   */
  private extractPatternSettings(
    settings?: import('@/components/BrushPanel/types').TextureSettings | null
  ): import('./types').GPUPatternSettings | null {
    // The caller (useBrushRenderer) gates with config.textureEnabled,
    // so we only need to check for valid patternId here.
    if (!settings || !settings.patternId) {
      return null;
    }
    return {
      patternId: settings.patternId,
      scale: settings.scale,
      brightness: settings.brightness,
      contrast: settings.contrast,
      depth: settings.depth, // Note: Pressure control not yet supported on CPU/GPU
      invert: settings.invert,
      mode: settings.mode,
    };
  }

  /**
   * Check if pattern settings have changed
   */
  private hasPatternSettingsChanged(
    newSettings: import('./types').GPUPatternSettings | null
  ): boolean {
    const current = this.currentPatternSettings;

    // Both null
    if (!current && !newSettings) return false;
    // One null
    if (!current || !newSettings) return true;

    // Compare fields
    return (
      current.patternId !== newSettings.patternId ||
      current.scale !== newSettings.scale ||
      current.brightness !== newSettings.brightness ||
      current.contrast !== newSettings.contrast ||
      current.depth !== newSettings.depth ||
      current.invert !== newSettings.invert ||
      current.mode !== newSettings.mode
    );
  }
}
