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
import { calculateEffectiveRadius } from './types';
import { PingPongBuffer } from './resources/PingPongBuffer';
import { InstanceBuffer } from './resources/InstanceBuffer';
import { TextureInstanceBuffer } from './resources/TextureInstanceBuffer';
import { useSelectionStore } from '@/stores/selection';
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
import type { BrushTexture, DualBlendMode, DualBrushSettings } from '@/stores/tool';
import { useSettingsStore, type ColorBlendMode, type GPURenderScaleMode } from '@/stores/settings';
import { patternManager } from '@/utils/patternManager';
import { forEachScatter } from '@/utils/scatterDynamics';
import { getNoisePattern } from '@/utils/noiseTexture';
import { alignTo, computeTextureCopyRectFromLogicalRect } from './utils/textureCopyRect';
import { decideDualStartupPrewarmPolicy } from './utils/startupPrewarmPolicy';

interface DebugRect {
  rect: Rect;
  label: string;
  color: string;
}

interface GpuDiagnosticEvent {
  kind: string;
  atMs: number;
  payload: Record<string, unknown>;
}

interface GpuUncapturedErrorSnapshot {
  atMs: number;
  message: string;
  name: string;
  constructorName: string;
  recentSubmitLabel: string | null;
}

const FLOAT16_TO_FLOAT32_LUT = new Float32Array(65536);
let float16LutReady = false;

function initializeFloat16Lut(): void {
  for (let i = 0; i < 65536; i += 1) {
    const sign = (i & 0x8000) !== 0 ? -1 : 1;
    const exponent = (i >> 10) & 0x1f;
    const mantissa = i & 0x03ff;

    let out = 0;
    if (exponent === 0) {
      out = mantissa === 0 ? 0 : sign * 2 ** -14 * (mantissa / 1024);
    } else if (exponent === 0x1f) {
      out = mantissa === 0 ? sign * Infinity : Number.NaN;
    } else {
      out = sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
    }
    FLOAT16_TO_FLOAT32_LUT[i] = out;
  }
}

function decodeFloat16(value: number): number {
  if (!float16LutReady) {
    initializeFloat16Lut();
    float16LutReady = true;
  }
  return FLOAT16_TO_FLOAT32_LUT[value & 0xffff] ?? 0;
}

export class GPUStrokeAccumulator {
  private device: GPUDevice;
  private pingPongBuffer: PingPongBuffer;
  private instanceBuffer: InstanceBuffer;
  private computeBrushPipeline: ComputeBrushPipeline;
  private profiler: GPUProfiler;

  // Texture brush resources (separate from parametric brush)
  private textureInstanceBuffer: TextureInstanceBuffer;
  private computeTextureBrushPipeline: ComputeTextureBrushPipeline;
  private textureAtlas: TextureAtlas;
  private patternCache: GPUPatternCache;

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
  private dualBrushTextureId: string | null = null;
  private dualStrokePrewarmKey: string | null = null;
  private dualStrokePrewarmPromise: Promise<void> | null = null;

  private fallbackRequest: string | null = null;

  // Current stroke mode: 'parametric' or 'texture'
  private strokeMode: 'parametric' | 'texture' = 'parametric';

  // Track current pattern settings to detect changes and trigger flush
  private currentPatternSettings: import('./types').GPUPatternSettings | null = null;
  private currentNoiseEnabled: boolean = false;
  private noiseTexture: GPUTexture;

  private width: number;
  private height: number;
  private active: boolean = false;
  private dirtyRect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  private lastPrimaryBatchRect: Rect | null = null;
  private lastPrimaryBatchLabel: string | null = null;
  private lastDualBatchRect: Rect | null = null;
  private lastDualBatchLabel: string | null = null;
  private lastPreviewUpdateRect: Rect | null = null;
  private lastPreviewUpdateSource: 'combined-dirty' | 'batch-union' | null = null;
  private lastPreviewUpdateMs: number | null = null;
  private previewUpdateCount: number = 0;
  private previewUpdateSkipCount: number = 0;
  private pendingPreviewRect: Rect | null = null;
  private previewPendingSinceMs: number | null = null;
  private lastPreviewPendingWarnMs: number = 0;

  // Preview canvas for compatibility with existing rendering system
  private previewCanvas: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;

  // Batch timing control
  private dabsSinceLastFlush: number = 0;

  // Auto-flush threshold: Must be <= WGSL MAX_SHARED_DABS (128) to prevent silent truncation.
  // Using 64 as a conservative value to avoid triggering dispatchInBatches which has ping-pong bugs.
  private static readonly MAX_SAFE_BATCH_SIZE = 64;
  private static readonly MAX_SAFE_SECONDARY_BATCH_SIZE = 256;

  // Preview readback buffer (separate to avoid conflicts)
  private previewReadbackBuffer: GPUBuffer | null = null;
  private previewReadbackBufferSizeBytes: number = 0;
  private previewUpdatePending: boolean = false;
  private previewNeedsUpdate: boolean = false; // Flag to ensure final update
  private previewReadbackEnabled: boolean = true;
  private previewReadbackRecreatePending: boolean = false;

  // Promise-based preview update tracking (optimization 1)
  private currentPreviewPromise: Promise<void> | null = null;

  // Device lost state tracking (optimization 3)
  private deviceLost: boolean = false;
  private uncapturedErrorHandler: ((event: Event) => void) | null = null;

  // Cached color blend mode to avoid redundant updates
  private cachedColorBlendMode: ColorBlendMode = 'linear';

  // Cached render scale mode to avoid redundant updates
  private cachedRenderScaleMode: GPURenderScaleMode = 'off';

  // Current actual render scale (computed from mode + brush params)
  private currentRenderScale: number = 1.0;

  // Performance timing
  private cpuTimer: CPUTimer = new CPUTimer();

  // Runtime diagnostics (for postmortem evidence)
  private diagnosticEvents: GpuDiagnosticEvent[] = [];
  private uncapturedErrors: GpuUncapturedErrorSnapshot[] = [];
  private submitHistory: Array<{ label: string; atMs: number }> = [];
  private lastSubmitLabel: string | null = null;
  private lastSubmitAtMs: number | null = null;
  private dualMaskCopyCount: number = 0;
  private dualMaskCopyPixels: number = 0;
  private previewMaxCopyBytes: number = 0;
  private diagDualMaskCopyCount: number = 0;
  private diagDualMaskCopyPixels: number = 0;
  private diagPreviewUpdateCount: number = 0;
  private diagPreviewSkipCount: number = 0;
  private diagPreviewMaxCopyBytes: number = 0;
  private diagnosticsSessionId: number = 0;
  private diagnosticsResetAtMs: number = 0;

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
    this.computeBrushPipeline = new ComputeBrushPipeline(device);
    this.computeBrushPipeline.updateCanvasSize(width, height);
    this.profiler = new GPUProfiler();

    // Initialize texture brush resources
    this.textureInstanceBuffer = new TextureInstanceBuffer(device);
    this.computeTextureBrushPipeline = new ComputeTextureBrushPipeline(device);
    this.computeTextureBrushPipeline.updateCanvasSize(width, height);
    this.textureAtlas = new TextureAtlas(device);
    this.patternCache = new GPUPatternCache(device);
    this.noiseTexture = this.createNoiseTexture();

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

    this.uncapturedErrorHandler = (event: Event) => {
      const gpuEvent = event as GPUUncapturedErrorEvent;
      const errorInfo = this.serializeError(gpuEvent.error);
      const snapshot: GpuUncapturedErrorSnapshot = {
        atMs: this.nowMs(),
        message: errorInfo.message,
        name: errorInfo.name,
        constructorName: errorInfo.constructorName,
        recentSubmitLabel: this.lastSubmitLabel,
      };
      this.uncapturedErrors.push(snapshot);
      if (this.uncapturedErrors.length > 20) {
        this.uncapturedErrors.shift();
      }
      this.pushDiagnosticEvent(
        'uncaptured-error',
        {
          ...snapshot,
          recentSubmits: this.submitHistory.slice(-5),
          previewPendingMs:
            this.previewPendingSinceMs === null ? 0 : this.nowMs() - this.previewPendingSinceMs,
        },
        true
      );
    };
    this.device.addEventListener('uncapturederror', this.uncapturedErrorHandler);
    this.resetDiagnostics();

    this.prewarmPipelines();
    this.initializePresentableTextures();
  }

  private createDualBlendTexture(): GPUTexture {
    return this.device.createTexture({
      label: 'Dual Blend Texture',
      size: [this.pingPongBuffer.textureWidth, this.pingPongBuffer.textureHeight],
      format: this.pingPongBuffer.format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC,
    });
  }

  private clearDualBlendTexture(): void {
    const encoder = this.device.createCommandEncoder({
      label: 'Clear Dual Blend Texture',
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.dualBlendTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private createNoiseTexture(): GPUTexture {
    const noise = getNoisePattern();

    const texture = this.device.createTexture({
      label: 'Noise Pattern Texture',
      size: { width: noise.width, height: noise.height },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.device.queue.writeTexture(
      { texture },
      noise.data as unknown as BufferSource,
      { bytesPerRow: noise.width * 4 },
      { width: noise.width, height: noise.height }
    );

    return texture;
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
        format: this.pingPongBuffer.format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });

      const dummyOutput = this.device.createTexture({
        label: 'Prewarm Output',
        size: [1, 1],
        format: this.pingPongBuffer.format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.COPY_DST,
      });

      const dummyDual = this.device.createTexture({
        label: 'Prewarm Dual',
        size: [1, 1],
        format: this.pingPongBuffer.format,
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

      const dualPrewarm = decideDualStartupPrewarmPolicy({
        width: this.width,
        height: this.height,
        maxBufferSize: this.device.limits.maxBufferSize,
      });
      if (!dualPrewarm.skip) {
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
      }

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
      if (!dualPrewarm.skip) {
        this.prewarmDualMaskCompute();
        this.prewarmDualReadback();
      } else {
        this.pushDiagnosticEvent('startup-dual-prewarm-skipped', {
          width: this.width,
          height: this.height,
          maxBufferSize: this.device.limits.maxBufferSize,
          reasons: dualPrewarm.reasons,
        });
      }
    } catch (error) {
      console.warn('[GPUStrokeAccumulator] Startup init failed:', error);
    }
  }

  private prewarmDualMaskCompute(): void {
    try {
      const texW = this.dualMaskBuffer.textureWidth;
      const texH = this.dualMaskBuffer.textureHeight;
      if (texW <= 0 || texH <= 0) {
        return;
      }

      const dummyDab: DabInstanceData = {
        x: 1,
        y: 1,
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

      const encoder = this.device.createCommandEncoder({
        label: 'Prewarm Dual Mask Encoder',
      });

      // Match the real dual-mask path to warm driver/pipeline on actual-sized textures.
      this.dualMaskBuffer.copySourceToDest(encoder);
      this.computeDualMaskPipeline.dispatch(
        encoder,
        this.dualMaskBuffer.source,
        this.dualMaskBuffer.dest,
        [dummyDab]
      );

      this.device.queue.submit([encoder.finish()]);
    } catch (error) {
      console.warn('[GPUStrokeAccumulator] Dual mask prewarm failed:', error);
    }
  }

  private prewarmDualReadback(): void {
    try {
      const texW = this.pingPongBuffer.textureWidth;
      const texH = this.pingPongBuffer.textureHeight;
      if (texW <= 0 || texH <= 0) {
        return;
      }

      // Only read back a tiny region to warm driver paths without allocating huge buffers.
      const copyWidth = Math.max(1, Math.min(16, texW));
      const copyHeight = Math.max(1, Math.min(1, texH));
      const bytesPerRow = 256; // >= 16px * 8B, and 256-byte aligned
      const size = bytesPerRow * copyHeight;

      const buffer = this.device.createBuffer({
        label: 'Prewarm Dual Readback Buffer',
        size,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });

      const encoder = this.device.createCommandEncoder({
        label: 'Prewarm Dual Readback Encoder',
      });
      encoder.copyTextureToBuffer(
        { texture: this.dualBlendTexture, origin: { x: 0, y: 0 } },
        { buffer, bytesPerRow },
        [copyWidth, copyHeight]
      );

      this.device.queue.submit([encoder.finish()]);

      void (async () => {
        try {
          await buffer.mapAsync(GPUMapMode.READ);
          buffer.unmap();
        } catch (error) {
          console.warn('[GPUStrokeAccumulator] Dual readback prewarm failed:', error);
        } finally {
          buffer.destroy();
        }
      })();
    } catch (error) {
      console.warn('[GPUStrokeAccumulator] Dual readback prewarm failed:', error);
    }
  }

  private createReadbackBuffer(): void {
    // Start with a tiny buffer and grow on demand based on dirty-rect readback size.
    // This avoids allocating huge MAP_READ buffers for large canvases (e.g. 5000x3000).
    const initialSize = 256;
    this.previewReadbackBufferSizeBytes = initialSize;
    this.previewReadbackBuffer = this.device.createBuffer({
      label: 'Preview Readback Buffer',
      size: initialSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }

  private recreateReadbackBuffersNow(): void {
    this.previewReadbackBuffer?.destroy();
    this.previewReadbackBuffer = null;
    this.previewReadbackBufferSizeBytes = 0;
    this.createReadbackBuffer();
  }

  private ensurePreviewReadbackBufferCapacity(minBytes: number): void {
    const required = Math.max(256, alignTo(minBytes, 256));
    if (this.previewReadbackBuffer && required <= this.previewReadbackBufferSizeBytes) {
      return;
    }

    this.previewReadbackBuffer?.destroy();
    this.previewReadbackBuffer = this.device.createBuffer({
      label: 'Preview Readback Buffer',
      size: required,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.previewReadbackBufferSizeBytes = required;
  }

  /** Destroy and recreate readback buffers (after texture resize) */
  private recreateReadbackBuffers(): void {
    if (this.currentPreviewPromise) {
      this.previewReadbackRecreatePending = true;
      return;
    }
    this.previewReadbackRecreatePending = false;
    this.recreateReadbackBuffersNow();
  }

  private flushPendingReadbackBufferRecreate(): void {
    if (!this.previewReadbackRecreatePending || this.currentPreviewPromise) {
      return;
    }
    this.previewReadbackRecreatePending = false;
    this.recreateReadbackBuffersNow();
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
    this.computeBrushPipeline.updateCanvasSize(
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

    // Sync color blend mode from store
    this.syncColorBlendMode();

    // Sync render scale from store
    this.syncRenderScale();

    // Sync wet edge settings from store
    this.syncWetEdgeSettings();

    const toolState = useToolStore.getState();
    const dualBrushEnabled = Boolean(toolState.dualBrushEnabled);

    // Sync noise state from store (used as compute shader uniform)
    this.currentNoiseEnabled = Boolean(toolState.noiseEnabled);

    // Pre-warm display texture if wet edge is enabled
    // This moves the lazy initialization cost from the first flushBatch to beginStroke
    if (this.wetEdgeEnabled) {
      this.pingPongBuffer.ensureDisplayTexture();
    }

    // Clear GPU buffers after all potential texture reallocations (e.g. render-scale changes).
    // This avoids carrying stale texels into wet-edge/dual presentable outputs.
    this.pingPongBuffer.clear(this.device);
    if (dualBrushEnabled) {
      this.dualMaskBuffer.clear(this.device);
      this.clearDualBlendTexture();
    }
  }

  /**
   * Sync wet edge settings from store
   */
  private syncWetEdgeSettings(): void {
    const { wetEdgeEnabled, wetEdge, brushHardness } = useToolStore.getState();
    this.wetEdgeEnabled = wetEdgeEnabled && wetEdge > 0;
    this.wetEdgeStrength = wetEdge;
    // Convert hardness from 0-100 to 0-1 range
    this.wetEdgeHardness = brushHardness / 100;
  }

  private beginWetEdgeDebug(context: string): { start: number; label: string | null } {
    void context;
    return { start: 0, label: null };
  }

  private endWetEdgeDebug(context: string, start: number, label: string | null): void {
    void context;
    void start;
    void label;
  }

  /**
   * Sync color blend mode from store to shader uniform
   */
  private syncColorBlendMode(): void {
    const mode = useSettingsStore.getState().brush.colorBlendMode;
    if (mode !== this.cachedColorBlendMode) {
      this.computeBrushPipeline.updateColorBlendMode(mode);
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
      this.computeBrushPipeline.updateCanvasSize(
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
    this.lastPrimaryBatchRect = null;
    this.lastPrimaryBatchLabel = null;
    this.lastDualBatchRect = null;
    this.lastDualBatchLabel = null;
    this.lastPreviewUpdateRect = null;
    this.lastPreviewUpdateSource = null;
    this.lastPreviewUpdateMs = null;
    this.previewUpdateCount = 0;
    this.previewUpdateSkipCount = 0;
    this.pendingPreviewRect = null;
    this.previewPendingSinceMs = null;
    this.lastPreviewPendingWarnMs = 0;
    this.dualDirtyRect = {
      left: this.width,
      top: this.height,
      right: 0,
      bottom: 0,
    };
    this.previewCtx.clearRect(0, 0, this.width, this.height);
    this.dabsSinceLastFlush = 0;
    this.currentPatternSettings = null;
    this.currentNoiseEnabled = false;
    this.patternCache.update(null);
    this.dualBrushEnabled = false;
    this.dualMaskActive = false;
    this.dualBrushMode = null;
    this.dualPostPending = false;
    this.fallbackRequest = null;
    this.dualMaskCopyCount = 0;
    this.dualMaskCopyPixels = 0;
    this.previewMaxCopyBytes = 0;
    this.dualMaskBuffer.clear(this.device);
  }

  /**
   * Check if stroke is active
   */
  isActive(): boolean {
    return this.active;
  }

  setDualBrushState(
    enabled: boolean,
    mode?: DualBlendMode | null,
    texture?: BrushTexture | null
  ): void {
    this.dualBrushEnabled = enabled;
    if (enabled && texture) {
      const textureId = texture.id;
      if (this.dualBrushTextureId !== textureId) {
        this.dualBrushTextureId = textureId;
        this.prewarmDualBrushTexture(texture);
      }
    } else if (!enabled) {
      this.dualBrushTextureId = null;
    }
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

  public prewarmDualBrushTexture(texture: BrushTexture): void {
    if (this.dualTextureAtlas.setTextureSync(texture)) {
      return;
    }
    void this.dualTextureAtlas.setTexture(texture);
  }

  private async prewarmDualBrushTextureAsync(texture: BrushTexture): Promise<void> {
    if (this.dualTextureAtlas.setTextureSync(texture)) {
      await this.device.queue.onSubmittedWorkDone();
      return;
    }
    await this.dualTextureAtlas.setTexture(texture);
    await this.device.queue.onSubmittedWorkDone();
  }

  public async prewarmDualStroke(dualBrush?: DualBrushSettings | null): Promise<void> {
    if (!dualBrush) {
      return;
    }

    const key = dualBrush.texture?.id ?? 'parametric';
    if (this.dualStrokePrewarmKey === key) {
      return;
    }

    if (this.dualStrokePrewarmPromise) {
      await this.dualStrokePrewarmPromise;
      if (this.dualStrokePrewarmKey === key) {
        return;
      }
    }

    this.dualStrokePrewarmPromise = (async () => {
      if (dualBrush.texture) {
        await this.prewarmDualBrushTextureAsync(dualBrush.texture);
      }

      if (this.active) {
        return;
      }

      const prewarmBrush: DualBrushSettings = {
        ...dualBrush,
        scatter: 0,
        bothAxes: false,
        count: 1,
      };

      this.beginStroke();
      this.stampSecondaryDab(1, 1, Math.max(1, prewarmBrush.size), prewarmBrush, 0);
      this.flush();
      await this.device.queue.onSubmittedWorkDone();
      if (this.currentPreviewPromise) {
        await this.currentPreviewPromise;
      }
      this.clear();

      this.dualStrokePrewarmKey = key;
    })().finally(() => {
      this.dualStrokePrewarmPromise = null;
    });

    await this.dualStrokePrewarmPromise;
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

    const scatterInput = {
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
    };

    const scale = this.currentRenderScale;
    const useTexture = Boolean(dualBrush.texture);
    let dualEffectiveRadius = effectiveSize / 2;
    if (useTexture && dualBrush.texture) {
      dualEffectiveRadius = this.computeTextureEffectiveRadius(
        effectiveSize,
        roundness,
        dualBrush.texture.width,
        dualBrush.texture.height
      );
    } else {
      const radius = effectiveSize / 2;
      const hardness = isSquashedRoundness ? 0.98 : 1.0;
      dualEffectiveRadius = calculateEffectiveRadius(radius, hardness);
    }

    if (useTexture && dualBrush.texture) {
      if (!this.dualTextureAtlas.setTextureSync(dualBrush.texture)) {
        void this.dualTextureAtlas.setTexture(dualBrush.texture);
        return;
      }
    }

    let aborted = false;
    forEachScatter(scatterInput, scatterSettings, (pos) => {
      if (aborted || this.fallbackRequest) {
        return;
      }

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

        if (
          this.secondaryTextureInstanceBuffer.count >=
          GPUStrokeAccumulator.MAX_SAFE_SECONDARY_BATCH_SIZE
        ) {
          const didFlush = this.flushSecondaryBatches();
          if (didFlush) {
            this.dualPostPending = true;
          }
          if (this.fallbackRequest) {
            aborted = true;
            return;
          }
        }
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

        if (
          this.secondaryInstanceBuffer.count >= GPUStrokeAccumulator.MAX_SAFE_SECONDARY_BATCH_SIZE
        ) {
          const didFlush = this.flushSecondaryBatches();
          if (didFlush) {
            this.dualPostPending = true;
          }
          if (this.fallbackRequest) {
            aborted = true;
            return;
          }
        }
      }

      this.expandDualDirtyRect(pos.x, pos.y, dualEffectiveRadius);
    });
  }

  stampDab(params: GPUDabParams): void {
    if (!this.active) return;

    const rgb = this.hexToRgb(params.color);
    const scale = this.currentRenderScale;
    const nextNoiseEnabled = Boolean(params.noiseEnabled);

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
      if (this.dabsSinceLastFlush > 0 && nextNoiseEnabled !== this.currentNoiseEnabled) {
        this.flushTextureBatch(this.dualMaskActive);
        this.flushBatch(this.dualMaskActive);
        this.dabsSinceLastFlush = 0; // Reset counter after flush
      }
      this.currentNoiseEnabled = nextNoiseEnabled;

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
      const effectiveRadius = this.computeTextureEffectiveRadius(
        params.size,
        params.roundness ?? 1.0,
        params.texture.width,
        params.texture.height
      );
      this.expandDirtyRectTexture(params.x, params.y, effectiveRadius);
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
    if (this.dabsSinceLastFlush > 0 && nextNoiseEnabled !== this.currentNoiseEnabled) {
      this.flushTextureBatch(this.dualMaskActive); // Flush texture batch too to be safe (shared state)
      this.flushBatch(this.dualMaskActive);
      this.dabsSinceLastFlush = 0;
    }
    this.currentNoiseEnabled = nextNoiseEnabled;

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
   * Expand dirty rect for texture brush.
   * IMPORTANT: Must match computeTextureBrush.wgsl calculate_effective_radius (diagonal of half dims).
   */
  private expandDirtyRectTexture(x: number, y: number, effectiveRadius: number): void {
    const margin = 2;
    this.dirtyRect.left = Math.min(this.dirtyRect.left, Math.floor(x - effectiveRadius - margin));
    this.dirtyRect.top = Math.min(this.dirtyRect.top, Math.floor(y - effectiveRadius - margin));
    this.dirtyRect.right = Math.max(this.dirtyRect.right, Math.ceil(x + effectiveRadius + margin));
    this.dirtyRect.bottom = Math.max(
      this.dirtyRect.bottom,
      Math.ceil(y + effectiveRadius + margin)
    );
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

  private shouldUseBatchUnionRectForPreview(): boolean {
    if (typeof window === 'undefined') return false;
    const flag = (window as unknown as { __gpuBrushUseBatchUnionRect?: boolean })
      .__gpuBrushUseBatchUnionRect;
    if (typeof flag === 'boolean') {
      return flag;
    }
    return true;
  }

  private shouldLogUploadDebug(): boolean {
    if (typeof window === 'undefined') return false;
    return Boolean(
      (window as unknown as { __gpuBrushUploadDebug?: boolean }).__gpuBrushUploadDebug
    );
  }

  private getPreviewUpdateRect(): { rect: Rect; source: 'combined-dirty' | 'batch-union' } {
    const combined = this.getCombinedDirtyRect();
    if (!this.shouldUseBatchUnionRectForPreview()) {
      return { rect: combined, source: 'combined-dirty' };
    }

    const pending = this.consumePendingPreviewRect();
    if (pending && this.hasDirtyRect(pending)) {
      return { rect: pending, source: 'batch-union' };
    }

    return { rect: combined, source: 'combined-dirty' };
  }

  private nowMs(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  private shouldLogDiagnostics(): boolean {
    if (typeof window === 'undefined') return false;
    return Boolean((window as unknown as { __gpuBrushDiag?: boolean }).__gpuBrushDiag);
  }

  private getDiagnosticCopyBytesThreshold(): number {
    if (typeof window === 'undefined') {
      return 64 * 1024 * 1024;
    }
    const value = (window as unknown as { __gpuBrushDiagCopyBytesThreshold?: number })
      .__gpuBrushDiagCopyBytesThreshold;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
    return 64 * 1024 * 1024;
  }

  private getDiagnosticPendingThresholdMs(): number {
    if (typeof window === 'undefined') {
      return 300;
    }
    const value = (window as unknown as { __gpuBrushDiagPendingMsThreshold?: number })
      .__gpuBrushDiagPendingMsThreshold;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
    return 300;
  }

  private rectArea(rect: Rect | null): number {
    if (!rect) return 0;
    return Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
  }

  private serializeError(error: unknown): {
    name: string;
    message: string;
    constructorName: string;
  } {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        constructorName: error.constructor?.name ?? 'Error',
      };
    }
    if (typeof error === 'object' && error !== null) {
      const maybeObj = error as {
        name?: unknown;
        message?: unknown;
        constructor?: { name?: string };
      };
      return {
        name: typeof maybeObj.name === 'string' ? maybeObj.name : 'UnknownError',
        message: typeof maybeObj.message === 'string' ? maybeObj.message : String(error),
        constructorName: maybeObj.constructor?.name ?? 'Object',
      };
    }
    return {
      name: 'UnknownError',
      message: String(error),
      constructorName: typeof error,
    };
  }

  private pushDiagnosticEvent(
    kind: string,
    payload: Record<string, unknown>,
    forceLog: boolean = false
  ): void {
    const event: GpuDiagnosticEvent = { kind, atMs: this.nowMs(), payload };
    this.diagnosticEvents.push(event);
    if (this.diagnosticEvents.length > 40) {
      this.diagnosticEvents.shift();
    }

    if (forceLog || this.shouldLogDiagnostics()) {
      const logFn = forceLog ? console.error : console.warn;
      logFn(`[GPUStrokeAccumulator][Diag] ${kind}`, payload);
    }
  }

  private recordSubmit(label: string): void {
    const atMs = this.nowMs();
    this.lastSubmitLabel = label;
    this.lastSubmitAtMs = atMs;
    this.submitHistory.push({ label, atMs });
    if (this.submitHistory.length > 20) {
      this.submitHistory.shift();
    }
  }

  private submitEncoder(encoder: GPUCommandEncoder, label: string): void {
    const commandBuffer = encoder.finish();
    this.recordSubmit(label);
    this.device.queue.submit([commandBuffer]);
  }

  private addPendingPreviewRect(rect: Rect | null): void {
    if (!rect || !this.hasDirtyRect(rect)) return;
    if (!this.pendingPreviewRect) {
      this.pendingPreviewRect = { ...rect };
      return;
    }
    this.pendingPreviewRect = {
      left: Math.min(this.pendingPreviewRect.left, rect.left),
      top: Math.min(this.pendingPreviewRect.top, rect.top),
      right: Math.max(this.pendingPreviewRect.right, rect.right),
      bottom: Math.max(this.pendingPreviewRect.bottom, rect.bottom),
    };
  }

  private consumePendingPreviewRect(): Rect | null {
    if (!this.pendingPreviewRect) return null;
    const rect = { ...this.pendingPreviewRect };
    this.pendingPreviewRect = null;
    return rect;
  }

  private requestPreviewUpdate(rect: Rect | null): void {
    if (!this.previewReadbackEnabled) {
      return;
    }
    this.addPendingPreviewRect(rect);
    this.previewNeedsUpdate = true;
    if (this.previewUpdatePending && this.previewPendingSinceMs !== null) {
      const pendingMs = this.nowMs() - this.previewPendingSinceMs;
      const thresholdMs = this.getDiagnosticPendingThresholdMs();
      if (pendingMs >= thresholdMs && pendingMs - this.lastPreviewPendingWarnMs >= thresholdMs) {
        this.lastPreviewPendingWarnMs = pendingMs;
        this.pushDiagnosticEvent('preview-pending-long', {
          pendingMs,
          mapState: this.previewReadbackBuffer?.mapState ?? 'unknown',
          pendingRectArea: this.rectArea(this.pendingPreviewRect),
          previewNeedsUpdate: this.previewNeedsUpdate,
          previewUpdatePending: this.previewUpdatePending,
        });
      }
    }
    if (!this.previewUpdatePending) {
      void this.updatePreview();
    }
  }

  private rectFromBbox(
    bbox: { x: number; y: number; width: number; height: number },
    scale: number
  ): Rect {
    const invScale = scale > 0 ? 1 / scale : 1;
    return {
      left: bbox.x * invScale,
      top: bbox.y * invScale,
      right: (bbox.x + bbox.width) * invScale,
      bottom: (bbox.y + bbox.height) * invScale,
    };
  }

  private computeDabsBoundingBox(
    dabs: DabInstanceData[],
    canvasWidth: number,
    canvasHeight: number
  ): { x: number; y: number; width: number; height: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const dab of dabs) {
      const effectiveRadius = calculateEffectiveRadius(dab.size, dab.hardness);
      minX = Math.min(minX, dab.x - effectiveRadius);
      minY = Math.min(minY, dab.y - effectiveRadius);
      maxX = Math.max(maxX, dab.x + effectiveRadius);
      maxY = Math.max(maxY, dab.y + effectiveRadius);
    }

    const margin = 2;
    const x = Math.max(0, Math.floor(minX) - margin);
    const y = Math.max(0, Math.floor(minY) - margin);
    const right = Math.min(canvasWidth, Math.ceil(maxX) + margin);
    const bottom = Math.min(canvasHeight, Math.ceil(maxY) + margin);

    return {
      x,
      y,
      width: Math.max(0, right - x),
      height: Math.max(0, bottom - y),
    };
  }

  private computeTextureDabsBoundingBox(
    dabs: TextureDabInstanceData[],
    canvasWidth: number,
    canvasHeight: number
  ): { x: number; y: number; width: number; height: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const dab of dabs) {
      const texAspect = dab.texWidth / dab.texHeight;
      let halfWidth: number;
      let halfHeight: number;

      if (texAspect >= 1.0) {
        halfWidth = dab.size / 2;
        halfHeight = halfWidth / texAspect;
      } else {
        halfHeight = dab.size / 2;
        halfWidth = halfHeight * texAspect;
      }

      halfHeight = halfHeight * dab.roundness;

      const effectiveRadius = Math.sqrt(halfWidth * halfWidth + halfHeight * halfHeight);
      minX = Math.min(minX, dab.x - effectiveRadius);
      minY = Math.min(minY, dab.y - effectiveRadius);
      maxX = Math.max(maxX, dab.x + effectiveRadius);
      maxY = Math.max(maxY, dab.y + effectiveRadius);
    }

    const margin = 2;
    const x = Math.max(0, Math.floor(minX) - margin);
    const y = Math.max(0, Math.floor(minY) - margin);
    const right = Math.min(canvasWidth, Math.ceil(maxX) + margin);
    const bottom = Math.min(canvasHeight, Math.ceil(maxY) + margin);

    return {
      x,
      y,
      width: Math.max(0, right - x),
      height: Math.max(0, bottom - y),
    };
  }

  private computeTextureEffectiveRadius(
    diameter: number,
    roundness: number,
    texWidth: number,
    texHeight: number
  ): number {
    const safeDiameter = Math.max(1, diameter);
    const safeRoundness = Math.max(0.01, Math.min(1, roundness));
    const texAspect = texHeight > 0 ? texWidth / texHeight : 1.0;

    let halfWidth: number;
    let halfHeight: number;

    if (texAspect >= 1.0) {
      halfWidth = safeDiameter / 2;
      halfHeight = halfWidth / texAspect;
    } else {
      halfHeight = safeDiameter / 2;
      halfWidth = halfHeight * texAspect;
    }

    halfHeight = halfHeight * safeRoundness;
    return Math.sqrt(halfWidth * halfWidth + halfHeight * halfHeight);
  }

  /**
   * Force flush pending dabs to GPU (used for benchmarking)
   */
  flush(): void {
    if (this.deviceLost && this.dualBrushEnabled) {
      this.requestCpuFallback('GPU device lost');
      return;
    }

    const deferPost = this.dualMaskActive;

    const primaryDidFlush =
      this.strokeMode === 'texture'
        ? this.flushTextureBatch(deferPost)
        : this.flushBatch(deferPost);

    if (this.fallbackRequest) {
      return;
    }

    const secondaryDidFlush = this.flushSecondaryBatches();

    if (this.fallbackRequest) {
      return;
    }

    if (this.dualMaskActive && (primaryDidFlush || secondaryDidFlush || this.dualPostPending)) {
      this.applyDualBlend();
      this.dualPostPending = false;
    }
  }

  /**
   * Flush pending dabs to GPU using Compute Shader (optimized path)
   * Compute 失败时直接请求 CPU fallback。
   */
  private flushBatch(deferPost: boolean = false): boolean {
    if (this.instanceBuffer.count === 0) {
      return false;
    }

    this.cpuTimer.start();

    // 1. Get data and upload to GPU
    const dabs = this.instanceBuffer.getDabsData();
    const bbox = this.instanceBuffer.getBoundingBox();
    this.lastPrimaryBatchRect = this.rectFromBbox(bbox, this.currentRenderScale);
    this.lastPrimaryBatchLabel = 'primary-batch';

    // Flush uploads to GPU and resets the pending/bbox counters
    this.instanceBuffer.flush();

    const encoder = this.device.createCommandEncoder({
      label: 'Brush Batch Encoder',
    });

    // Compute shader: batch all dabs in single dispatch
    // IMPORTANT: Copy source -> dest for the accumulated dirty region before dispatch.
    // This preserves results from previous flushes without paying full-canvas bandwidth.
    const dr = this.dirtyRect;
    const pad = 4;
    const copyLeft = Math.floor(Math.max(0, dr.left - pad));
    const copyTop = Math.floor(Math.max(0, dr.top - pad));
    const copyRight = Math.ceil(Math.min(this.width, dr.right + pad));
    const copyBottom = Math.ceil(Math.min(this.height, dr.bottom + pad));
    const copyW = copyRight - copyLeft;
    const copyH = copyBottom - copyTop;
    if (copyW > 0 && copyH > 0) {
      this.pingPongBuffer.copyRect(encoder, copyLeft, copyTop, copyW, copyH);
    }

    // Single dispatch for all dabs
    const success = this.computeBrushPipeline.dispatch(
      encoder,
      this.pingPongBuffer.source,
      this.pingPongBuffer.dest,
      dabs,
      this.patternCache.getTexture(),
      this.currentPatternSettings,
      this.noiseTexture,
      this.currentNoiseEnabled,
      1.0
    );

    if (!success) {
      console.warn('[GPUStrokeAccumulator] Compute shader failed, requesting CPU fallback');
      this.requestCpuFallback('GPU compute unavailable (primary)');
      return false;
    }

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
    this.submitEncoder(encoder, 'Brush Batch Encoder');

    const cpuTime = this.cpuTimer.stop();
    this.profiler.recordFrame({
      dabCount: dabs.length,
      cpuTimeMs: cpuTime,
    });

    if (!deferPost) {
      this.requestPreviewUpdate(this.lastPrimaryBatchRect);
    } else {
      this.addPendingPreviewRect(this.lastPrimaryBatchRect);
    }
    return true;
  }

  /**
   * Flush pending texture dabs to GPU using Compute Shader (optimized path)
   * Compute 失败时直接请求 CPU fallback。
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
    const textureBbox = this.computeTextureDabsBoundingBox(
      dabs,
      this.pingPongBuffer.textureWidth,
      this.pingPongBuffer.textureHeight
    );
    this.lastPrimaryBatchRect = this.rectFromBbox(textureBbox, this.currentRenderScale);
    this.lastPrimaryBatchLabel = 'primary-texture-batch';
    this.textureInstanceBuffer.flush();

    const encoder = this.device.createCommandEncoder({
      label: 'Texture Brush Batch Encoder',
    });

    const dr = this.dirtyRect;

    // Copy source to dest to preserve previous strokes
    // NOTE: dirtyRect is in logical coordinates, copyRect will scale them
    const copyW = dr.right - dr.left;
    const copyH = dr.bottom - dr.top;
    if (copyW > 0 && copyH > 0) {
      this.pingPongBuffer.copyRect(encoder, dr.left, dr.top, copyW, copyH);
    }

    // Single dispatch for all dabs
    const success = this.computeTextureBrushPipeline.dispatch(
      encoder,
      this.pingPongBuffer.source,
      this.pingPongBuffer.dest,
      currentTexture,
      dabs,
      this.patternCache.getTexture(),
      this.currentPatternSettings,
      this.noiseTexture,
      this.currentNoiseEnabled,
      1.0
    );

    if (!success) {
      console.warn('[GPUStrokeAccumulator] Texture compute shader failed, requesting CPU fallback');
      this.requestCpuFallback('GPU compute unavailable (texture)');
      return false;
    }

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
    this.submitEncoder(encoder, 'Texture Brush Batch Encoder');

    const cpuTime = this.cpuTimer.stop();
    this.profiler.recordFrame({
      dabCount: dabs.length,
      cpuTimeMs: cpuTime,
    });

    if (!deferPost) {
      this.requestPreviewUpdate(this.lastPrimaryBatchRect);
    } else {
      this.addPendingPreviewRect(this.lastPrimaryBatchRect);
    }
    return true;
  }

  private flushSecondaryBatches(): boolean {
    let didFlush = false;
    const maxDabsPerDispatch = 128;

    if (this.secondaryInstanceBuffer.count > 0) {
      const allDabs = this.secondaryInstanceBuffer.getDabsData();
      const dualBbox = this.computeDabsBoundingBox(
        allDabs,
        this.dualMaskBuffer.textureWidth,
        this.dualMaskBuffer.textureHeight
      );
      const dispatchCount = Math.ceil(allDabs.length / maxDabsPerDispatch);
      this.dualMaskCopyCount += dispatchCount;
      this.dualMaskCopyPixels +=
        dispatchCount * this.dualMaskBuffer.textureWidth * this.dualMaskBuffer.textureHeight;
      this.diagDualMaskCopyCount += dispatchCount;
      this.diagDualMaskCopyPixels +=
        dispatchCount * this.dualMaskBuffer.textureWidth * this.dualMaskBuffer.textureHeight;
      this.lastDualBatchRect = this.rectFromBbox(dualBbox, this.currentRenderScale);
      this.lastDualBatchLabel = 'dual-batch';
      this.addPendingPreviewRect(this.lastDualBatchRect);
      this.secondaryInstanceBuffer.clear();

      this.pushDiagnosticEvent('dual-secondary-flush', {
        kind: 'parametric',
        dabs: allDabs.length,
        dispatchCount,
        bbox: dualBbox,
        textureWidth: this.dualMaskBuffer.textureWidth,
        textureHeight: this.dualMaskBuffer.textureHeight,
        cumulativeCopyCount: this.dualMaskCopyCount,
      });

      if (this.shouldLogUploadDebug()) {
        const estimatedUploadBytes = allDabs.length * 48;
        if (estimatedUploadBytes > 64 * 1024 * 1024 || allDabs.length > 10_000) {
          console.warn('[GPUStrokeAccumulator] Dual secondary upload stats', {
            dabs: allDabs.length,
            estimatedUploadBytes,
            bbox: dualBbox,
          });
        }
      }

      for (let start = 0; start < allDabs.length; start += maxDabsPerDispatch) {
        const dabs = allDabs.slice(start, start + maxDabsPerDispatch);

        const encoder = this.device.createCommandEncoder({
          label: 'Dual Mask Batch Encoder',
        });

        // Preserve previous mask data
        this.dualMaskBuffer.copySourceToDest(encoder);

        const success = this.computeDualMaskPipeline.dispatch(
          encoder,
          this.dualMaskBuffer.source,
          this.dualMaskBuffer.dest,
          dabs
        );

        if (!success) {
          this.requestCpuFallback('GPU dual mask compute failed');
          return false;
        }

        this.dualMaskBuffer.swap();
        this.submitEncoder(encoder, 'Dual Mask Batch Encoder');
        didFlush = true;
      }
    }

    if (this.secondaryTextureInstanceBuffer.count > 0) {
      const currentTexture = this.dualTextureAtlas.getCurrentTexture();
      if (!currentTexture) {
        console.warn('[GPUStrokeAccumulator] No texture available for dual brush');
        this.secondaryTextureInstanceBuffer.clear();
        return didFlush;
      }

      const allDabs = this.secondaryTextureInstanceBuffer.getDabsData();
      const dualTextureBbox = this.computeTextureDabsBoundingBox(
        allDabs,
        this.dualMaskBuffer.textureWidth,
        this.dualMaskBuffer.textureHeight
      );
      const dispatchCount = Math.ceil(allDabs.length / maxDabsPerDispatch);
      this.dualMaskCopyCount += dispatchCount;
      this.dualMaskCopyPixels +=
        dispatchCount * this.dualMaskBuffer.textureWidth * this.dualMaskBuffer.textureHeight;
      this.diagDualMaskCopyCount += dispatchCount;
      this.diagDualMaskCopyPixels +=
        dispatchCount * this.dualMaskBuffer.textureWidth * this.dualMaskBuffer.textureHeight;
      this.lastDualBatchRect = this.rectFromBbox(dualTextureBbox, this.currentRenderScale);
      this.lastDualBatchLabel = 'dual-texture-batch';
      this.addPendingPreviewRect(this.lastDualBatchRect);
      this.secondaryTextureInstanceBuffer.clear();

      this.pushDiagnosticEvent('dual-secondary-flush', {
        kind: 'texture',
        dabs: allDabs.length,
        dispatchCount,
        bbox: dualTextureBbox,
        textureWidth: this.dualMaskBuffer.textureWidth,
        textureHeight: this.dualMaskBuffer.textureHeight,
        cumulativeCopyCount: this.dualMaskCopyCount,
      });

      if (this.shouldLogUploadDebug()) {
        const estimatedUploadBytes = allDabs.length * 48;
        if (estimatedUploadBytes > 64 * 1024 * 1024 || allDabs.length > 10_000) {
          console.warn('[GPUStrokeAccumulator] Dual texture secondary upload stats', {
            dabs: allDabs.length,
            estimatedUploadBytes,
            bbox: dualTextureBbox,
          });
        }
      }

      for (let start = 0; start < allDabs.length; start += maxDabsPerDispatch) {
        const dabs = allDabs.slice(start, start + maxDabsPerDispatch);

        const encoder = this.device.createCommandEncoder({
          label: 'Dual Texture Mask Batch Encoder',
        });

        this.dualMaskBuffer.copySourceToDest(encoder);

        const success = this.computeDualTextureMaskPipeline.dispatch(
          encoder,
          this.dualMaskBuffer.source,
          this.dualMaskBuffer.dest,
          currentTexture.texture,
          dabs
        );

        if (!success) {
          this.requestCpuFallback('GPU dual texture mask compute failed');
          return false;
        }

        this.dualMaskBuffer.swap();
        this.submitEncoder(encoder, 'Dual Texture Mask Batch Encoder');
        didFlush = true;
      }
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

    const encoder = this.device.createCommandEncoder({
      label: 'Dual Blend Encoder',
    });

    this.pushDiagnosticEvent('dual-blend-dispatch', {
      mode: this.dualBrushMode,
      rectWidth: Math.max(0, rect.right - rect.left),
      rectHeight: Math.max(0, rect.bottom - rect.top),
      renderScale: this.currentRenderScale,
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

    this.submitEncoder(encoder, 'Dual Blend Encoder');

    this.requestPreviewUpdate(null);
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
   * Async update preview canvas from GPU texture
   * Uses Promise storage and buffer state guard to prevent race conditions
   * Optimization 5: Mark retry when buffer busy instead of silent skip
   * Optimization 8: Handle buffer deadlock defense
   */
  private async updatePreview(): Promise<void> {
    if (!this.previewReadbackEnabled) {
      this.previewNeedsUpdate = false;
      this.previewUpdatePending = false;
      return;
    }
    // Optimization 1: If already running, return existing promise (most efficient wait)
    if (this.currentPreviewPromise) {
      return this.currentPreviewPromise;
    }

    this.flushPendingReadbackBufferRecreate();

    if (!this.previewReadbackBuffer) {
      return;
    }

    if (!this.previewNeedsUpdate && !this.pendingPreviewRect) {
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
      const pendingMs =
        this.previewPendingSinceMs === null ? 0 : this.nowMs() - this.previewPendingSinceMs;
      this.pushDiagnosticEvent('preview-buffer-busy', {
        mapState: this.previewReadbackBuffer.mapState,
        pendingMs,
        pendingRectArea: this.rectArea(this.pendingPreviewRect),
      });
      this.previewNeedsUpdate = true; // Ensure next call will retry
      this.previewUpdateSkipCount++;
      this.diagPreviewSkipCount++;
      return;
    }

    this.previewUpdatePending = true;
    this.previewNeedsUpdate = false;
    this.previewPendingSinceMs = this.nowMs();

    // Store the promise for concurrent access

    this.currentPreviewPromise = (async () => {
      const updateStart = this.nowMs();
      let previewDiagContext: Record<string, unknown> = {};
      try {
        // Get dirty rect bounds (in logical/canvas coordinates) - use integers
        const preferred = this.getPreviewUpdateRect();
        const rect = {
          left: Math.floor(Math.max(0, preferred.rect.left)),
          top: Math.floor(Math.max(0, preferred.rect.top)),
          right: Math.ceil(Math.min(this.width, preferred.rect.right)),
          bottom: Math.ceil(Math.min(this.height, preferred.rect.bottom)),
        };

        const rectWidth = rect.right - rect.left;
        const rectHeight = rect.bottom - rect.top;
        const scale = this.currentRenderScale;

        if (rectWidth > 0 && rectHeight > 0) {
          const texW = this.pingPongBuffer.textureWidth;
          const texH = this.pingPongBuffer.textureHeight;
          const copyRect = computeTextureCopyRectFromLogicalRect(rect, scale, texW, texH, 1);
          if (copyRect.width <= 0 || copyRect.height <= 0) {
            return;
          }

          // rgba16float = 8 bytes/pixel. bytesPerRow must be 256-byte aligned.
          const bytesPerRow = alignTo(copyRect.width * 8, 256);
          const copyBytes = bytesPerRow * copyRect.height;
          this.previewMaxCopyBytes = Math.max(this.previewMaxCopyBytes, copyBytes);
          this.diagPreviewMaxCopyBytes = Math.max(this.diagPreviewMaxCopyBytes, copyBytes);
          const maxBufferSize = this.device.limits.maxBufferSize;
          const copyRatio = maxBufferSize > 0 ? copyBytes / maxBufferSize : 0;
          previewDiagContext = {
            source: preferred.source,
            rectWidth,
            rectHeight,
            copyOriginX: copyRect.originX,
            copyOriginY: copyRect.originY,
            copyWidth: copyRect.width,
            copyHeight: copyRect.height,
            bytesPerRow,
            copyBytes,
            maxBufferSize,
            copyRatio,
            renderScale: scale,
          };
          if (
            copyBytes >= this.getDiagnosticCopyBytesThreshold() ||
            copyRatio >= 0.8 ||
            rectWidth * rectHeight >= 2_000_000
          ) {
            this.pushDiagnosticEvent('preview-copy-large', previewDiagContext);
          }
          this.ensurePreviewReadbackBufferCapacity(copyBytes);
          const readbackBuffer = this.previewReadbackBuffer;
          if (!readbackBuffer) {
            return;
          }

          // Copy just the region we need from the presentable texture (raw / wet-edge / dual blend).
          const encoder = this.device.createCommandEncoder();
          encoder.copyTextureToBuffer(
            {
              texture: this.getPresentableTexture(),
              origin: { x: copyRect.originX, y: copyRect.originY },
            },
            { buffer: readbackBuffer, bytesPerRow },
            [copyRect.width, copyRect.height]
          );
          this.submitEncoder(encoder, 'Preview Readback Encoder');

          let mapped = false;
          const mapStart = this.nowMs();
          try {
            await readbackBuffer.mapAsync(GPUMapMode.READ, 0, copyBytes);
            mapped = true;
            const gpuData = new Uint16Array(readbackBuffer.getMappedRange(0, copyBytes));
            const componentsPerRow = bytesPerRow / 2;

            // Create ImageData for the dirty region (full resolution preview)
            const imageData = this.previewCtx.createImageData(rectWidth, rectHeight);

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
                const texX = Math.floor(globalX * scale) - copyRect.originX;
                const texY = Math.floor(globalY * scale) - copyRect.originY;
                if (texX < 0 || texY < 0 || texX >= copyRect.width || texY >= copyRect.height) {
                  continue;
                }

                const srcIdx = texY * componentsPerRow + texX * 4;
                const dstIdx = (py * rectWidth + px) * 4;

                const srcR = decodeFloat16(gpuData[srcIdx] ?? 0);
                const srcG = decodeFloat16(gpuData[srcIdx + 1] ?? 0);
                const srcB = decodeFloat16(gpuData[srcIdx + 2] ?? 0);
                const srcA = decodeFloat16(gpuData[srcIdx + 3] ?? 0);

                // Convert float (0-1) to uint8 (0-255), applying mask blend for AA
                imageData.data[dstIdx] = Math.round(srcR * 255);
                imageData.data[dstIdx + 1] = Math.round(srcG * 255);
                imageData.data[dstIdx + 2] = Math.round(srcB * 255);
                imageData.data[dstIdx + 3] = Math.round(srcA * 255 * maskBlend);
              }
            }

            this.previewCtx.putImageData(imageData, rect.left, rect.top);
            this.lastPreviewUpdateRect = rect;
            this.lastPreviewUpdateSource = preferred.source;
            this.previewUpdateCount += 1;
            this.diagPreviewUpdateCount += 1;
            this.lastPreviewUpdateMs = this.nowMs() - updateStart;
            const mapMs = this.nowMs() - mapStart;
            if (
              this.lastPreviewUpdateMs >= this.getDiagnosticPendingThresholdMs() ||
              copyBytes >= this.getDiagnosticCopyBytesThreshold()
            ) {
              this.pushDiagnosticEvent('preview-update-timing', {
                ...previewDiagContext,
                mapMs,
                totalMs: this.lastPreviewUpdateMs,
                pendingRectArea: this.rectArea(this.pendingPreviewRect),
              });
            }
          } finally {
            if (mapped) {
              try {
                readbackBuffer.unmap();
              } catch {
                // Ignore unmap errors
              }
            }
          }
        }
      } catch (e) {
        this.previewNeedsUpdate = true;
        this.pushDiagnosticEvent(
          'preview-update-failed',
          {
            ...previewDiagContext,
            mapState: this.previewReadbackBuffer?.mapState ?? 'unknown',
            pendingMs:
              this.previewPendingSinceMs === null ? 0 : this.nowMs() - this.previewPendingSinceMs,
            error: this.serializeError(e),
          },
          true
        );
        console.error('[GPUStrokeAccumulator] Preview update failed:', e);
      } finally {
        this.currentPreviewPromise = null;
        this.previewUpdatePending = false;
        this.previewPendingSinceMs = null;
        this.lastPreviewPendingWarnMs = 0;
        this.flushPendingReadbackBufferRecreate();
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
    if (this.previewReadbackEnabled) {
      await this.updatePreview();
    }
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

    // Get selection mask for clipping (selection path remains pixel-accurate)
    const selectionState = useSelectionStore.getState();
    const selectionMask = selectionState.hasSelection ? selectionState.selectionMask : null;

    // Fast path: no selection => let the browser composite
    if (!selectionMask) {
      const clampedOpacity = Math.max(0, Math.min(1, opacity));
      if (clampedOpacity <= 0) return;

      layerCtx.save();
      layerCtx.globalCompositeOperation = 'source-over';
      layerCtx.globalAlpha = clampedOpacity;
      layerCtx.drawImage(
        this.previewCanvas,
        rect.left,
        rect.top,
        rectWidth,
        rectHeight,
        rect.left,
        rect.top,
        rectWidth,
        rectHeight
      );
      layerCtx.restore();
      return;
    }

    // Read stroke data from previewCanvas (same as what user saw)
    const strokeData = this.previewCtx.getImageData(rect.left, rect.top, rectWidth, rectHeight);

    // Get layer data for compositing
    const layerData = layerCtx.getImageData(rect.left, rect.top, rectWidth, rectHeight);

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

  setPreviewReadbackEnabled(enabled: boolean): void {
    this.previewReadbackEnabled = enabled;
    if (!enabled) {
      this.previewNeedsUpdate = false;
      this.previewUpdatePending = false;
    }
  }

  getScratchTexture(): GPUTexture {
    return this.getPresentableTexture();
  }

  getRenderScale(): number {
    return this.currentRenderScale;
  }

  /**
   * Get the dirty rectangle
   */
  getDirtyRect(): Rect {
    return { ...this.dirtyRect };
  }

  getDebugRects(): DebugRect[] {
    const rects: DebugRect[] = [];

    const combined = this.getCombinedDirtyRect();
    if (this.hasDirtyRect(combined)) {
      rects.push({ rect: combined, label: 'combined-dirty', color: '#34c759' });
    }

    if (this.lastPreviewUpdateRect) {
      const parts: string[] = ['preview-update'];
      if (this.lastPreviewUpdateSource) {
        parts.push(`(${this.lastPreviewUpdateSource})`);
      }
      if (this.previewUpdateCount > 0) {
        parts.push(`#${this.previewUpdateCount}`);
      }
      if (this.lastPreviewUpdateMs !== null) {
        parts.push(`${Math.round(this.lastPreviewUpdateMs)}ms`);
      }
      if (this.previewUpdateSkipCount > 0) {
        parts.push(`skip:${this.previewUpdateSkipCount}`);
      }
      rects.push({
        rect: this.lastPreviewUpdateRect,
        label: parts.join(' '),
        color: '#ffd60a',
      });
    }

    if (this.lastPrimaryBatchRect) {
      rects.push({
        rect: this.lastPrimaryBatchRect,
        label: this.lastPrimaryBatchLabel ?? 'primary-batch',
        color: '#ff3b30',
      });
    }

    if (this.lastDualBatchRect) {
      rects.push({
        rect: this.lastDualBatchRect,
        label: this.lastDualBatchLabel ?? 'dual-batch',
        color: '#0a84ff',
      });
    }

    return rects;
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

  resetDiagnostics(): void {
    this.diagnosticsSessionId += 1;
    this.diagnosticsResetAtMs = this.nowMs();
    this.uncapturedErrors = [];
    this.diagnosticEvents = [];
    this.submitHistory = [];
    this.lastSubmitLabel = null;
    this.lastSubmitAtMs = null;
    this.previewUpdateCount = 0;
    this.previewUpdateSkipCount = 0;
    this.previewMaxCopyBytes = 0;
    this.diagDualMaskCopyCount = 0;
    this.diagDualMaskCopyPixels = 0;
    this.diagPreviewUpdateCount = 0;
    this.diagPreviewSkipCount = 0;
    this.diagPreviewMaxCopyBytes = 0;
    this.dualMaskCopyCount = 0;
    this.dualMaskCopyPixels = 0;
    this.lastPrimaryBatchLabel = null;
    this.lastDualBatchLabel = null;
  }

  getDiagnosticSnapshot(): Record<string, unknown> {
    return {
      diagnosticsSessionId: this.diagnosticsSessionId,
      resetAtMs: this.diagnosticsResetAtMs,
      canvas: {
        width: this.width,
        height: this.height,
        renderScale: this.currentRenderScale,
        previewReadbackEnabled: this.previewReadbackEnabled,
      },
      preview: {
        strokeUpdateCount: this.previewUpdateCount,
        strokeSkipCount: this.previewUpdateSkipCount,
        totalUpdateCount: this.diagPreviewUpdateCount,
        totalSkipCount: this.diagPreviewSkipCount,
        lastSource: this.lastPreviewUpdateSource,
        lastMs: this.lastPreviewUpdateMs,
        strokeMaxCopyBytes: this.previewMaxCopyBytes,
        totalMaxCopyBytes: this.diagPreviewMaxCopyBytes,
        pending: this.previewUpdatePending,
        pendingMs:
          this.previewPendingSinceMs === null ? 0 : this.nowMs() - this.previewPendingSinceMs,
      },
      dual: {
        strokeMaskCopyCount: this.dualMaskCopyCount,
        strokeMaskCopyPixels: this.dualMaskCopyPixels,
        totalMaskCopyCount: this.diagDualMaskCopyCount,
        totalMaskCopyPixels: this.diagDualMaskCopyPixels,
        lastPrimaryBatchLabel: this.lastPrimaryBatchLabel,
        lastDualBatchLabel: this.lastDualBatchLabel,
      },
      submit: {
        lastLabel: this.lastSubmitLabel,
        lastAtMs: this.lastSubmitAtMs,
        recent: this.submitHistory.slice(-8),
      },
      uncapturedErrors: this.uncapturedErrors.slice(-8),
      events: this.diagnosticEvents.slice(-20),
      fallbackRequest: this.fallbackRequest,
      deviceLost: this.deviceLost,
    };
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
    if (this.uncapturedErrorHandler) {
      this.device.removeEventListener('uncapturederror', this.uncapturedErrorHandler);
      this.uncapturedErrorHandler = null;
    }
    this.pingPongBuffer.destroy();
    this.instanceBuffer.destroy();
    this.computeBrushPipeline.destroy();
    this.textureInstanceBuffer.destroy();
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
    this.noiseTexture.destroy();
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
