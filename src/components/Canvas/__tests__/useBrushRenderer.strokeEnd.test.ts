import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { BrushStamper } from '@/utils/strokeBuffer';
import { useBrushRenderer, type BrushRenderConfig } from '../useBrushRenderer';

const gpuState = vi.hoisted(() => ({
  instances: [] as Array<{ stampDabCalls: unknown[] }>,
}));

vi.mock('@/gpu', () => {
  class MockGPUContext {
    static instance = new MockGPUContext();
    device: GPUDevice | null = {} as GPUDevice;

    static getInstance(): MockGPUContext {
      return MockGPUContext.instance;
    }

    async initialize(): Promise<boolean> {
      return true;
    }
  }

  class MockGPUStrokeAccumulator {
    readonly stampDabCalls: unknown[] = [];
    private active = false;
    private readonly canvas: HTMLCanvasElement;

    constructor() {
      this.canvas = document.createElement('canvas');
      gpuState.instances.push(this);
    }

    async prewarmDualStroke(): Promise<void> {}
    prewarmDualBrushTexture(): void {}
    resize(): void {}
    beginStroke(): void {
      this.active = true;
    }
    setDualBrushState(): void {}
    stampSecondaryDab(): void {}
    stampDab(params: unknown): void {
      this.stampDabCalls.push(params);
    }
    flush(): void {}
    consumeFallbackRequest(): string | null {
      return null;
    }
    async prepareEndStroke(): Promise<void> {}
    compositeToLayer(): void {}
    clear(): void {
      this.active = false;
    }
    getCanvas(): HTMLCanvasElement {
      return this.canvas;
    }
    isActive(): boolean {
      return this.active;
    }
    getDebugRects(): null {
      return null;
    }
    setPreviewReadbackEnabled(): void {}
    getScratchTexture(): GPUTexture {
      return {} as GPUTexture;
    }
    getRenderScale(): number {
      return 1;
    }
    getDirtyRect(): { left: number; top: number; right: number; bottom: number } {
      return { left: 0, top: 0, right: 32, bottom: 32 };
    }
    getDiagnosticSnapshot(): null {
      return null;
    }
    resetDiagnostics(): void {}
    abortStroke(): void {}
    destroy(): void {}
  }

  return {
    GPUContext: MockGPUContext,
    GPUStrokeAccumulator: MockGPUStrokeAccumulator,
    shouldUseGPU: () => true,
    reportGPUFallback: vi.fn(),
  };
});

function createConfig(): BrushRenderConfig {
  return {
    size: 24,
    flow: 1,
    opacity: 1,
    hardness: 100,
    maskType: 'gaussian',
    spacing: 0.08,
    roundness: 100,
    angle: 0,
    color: '#000000',
    backgroundColor: '#ffffff',
    pressureSizeEnabled: true,
    pressureFlowEnabled: true,
    pressureOpacityEnabled: true,
    maxBrushSpeedPxPerMs: 30,
    brushSpeedSmoothingSamples: 3,
    lowPressureAdaptiveSmoothingEnabled: true,
    tailTaperEnabled: true,
    pressureCurve: 'linear',
    texture: null,
    shapeDynamicsEnabled: false,
    scatterEnabled: false,
    colorDynamicsEnabled: false,
    wetEdgeEnabled: false,
    wetEdge: 0,
    buildupEnabled: false,
    transferEnabled: false,
    textureEnabled: false,
    noiseEnabled: false,
    dualBrushEnabled: false,
    strokeCompositeMode: 'paint',
  };
}

describe('useBrushRenderer stroke finalize path', () => {
  beforeEach(() => {
    gpuState.instances.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    gpuState.instances.length = 0;
  });

  it('injects tail dabs from prepareStrokeEndGpu and keeps per-stroke finalize idempotent', async () => {
    const finishSpy = vi.spyOn(BrushStamper.prototype, 'finishStroke');
    const config = createConfig();

    const { result } = renderHook(() =>
      useBrushRenderer({
        width: 256,
        height: 256,
        renderMode: 'gpu',
      })
    );

    await waitFor(() => {
      expect(result.current.backend).toBe('gpu');
    });

    await act(async () => {
      await result.current.beginStroke(100, 0);
    });

    act(() => {
      for (let i = 0; i < 10; i += 1) {
        result.current.processPoint(i * 6, 0, 0.42, config, i, undefined, {
          timestampMs: i * 4,
        });
      }
    });

    const gpu = gpuState.instances[0];
    if (!gpu) {
      throw new Error('expected gpu instance to exist');
    }
    const dabCountBeforePrepare = gpu.stampDabCalls.length;

    await act(async () => {
      await result.current.prepareStrokeEndGpu();
    });

    const dabCountAfterPrepare = gpu.stampDabCalls.length;
    const finishCallsAfterPrepare = finishSpy.mock.calls.length;
    expect(finishCallsAfterPrepare).toBeGreaterThanOrEqual(2);
    expect(dabCountAfterPrepare).toBeGreaterThan(dabCountBeforePrepare);

    await act(async () => {
      await result.current.prepareStrokeEndGpu();
    });

    expect(gpu.stampDabCalls.length).toBe(dabCountAfterPrepare);
    expect(finishSpy.mock.calls.length).toBe(finishCallsAfterPrepare);

    await act(async () => {
      await result.current.endStroke({} as CanvasRenderingContext2D);
    });

    expect(gpu.stampDabCalls.length).toBe(dabCountAfterPrepare);
    expect(finishSpy.mock.calls.length).toBe(finishCallsAfterPrepare);
  });
});
