import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import * as shapeDynamicsModule from '@/utils/shapeDynamics';
import type { DynamicsInput } from '@/utils/shapeDynamics';
import { useBrushRenderer, type BrushRenderConfig } from '../useBrushRenderer';

const gpuState = vi.hoisted(() => ({
  instances: [] as Array<{ stampDabCalls: unknown[]; stampSecondaryDabCalls: unknown[] }>,
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
    readonly stampSecondaryDabCalls: unknown[] = [];
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
    stampSecondaryDab(...args: unknown[]): void {
      this.stampSecondaryDabCalls.push(args);
    }
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

  it('does not inject trajectory-smoothing finalize dabs in prepareStrokeEndGpu and keeps finalize idempotent', async () => {
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
    expect(dabCountAfterPrepare).toBe(dabCountBeforePrepare + 1);
    const finalizeCalls = gpu.stampDabCalls.slice(dabCountBeforePrepare) as Array<{
      x?: number;
      y?: number;
      pressure?: number;
    }>;
    expect(finalizeCalls.length).toBe(1);

    await act(async () => {
      await result.current.prepareStrokeEndGpu();
    });

    expect(gpu.stampDabCalls.length).toBe(dabCountAfterPrepare);

    await act(async () => {
      await result.current.endStroke({} as CanvasRenderingContext2D);
    });

    expect(gpu.stampDabCalls.length).toBe(dabCountAfterPrepare);
  });

  it('emits secondary finalize dabs once in dual brush mode and keeps finalize idempotent', async () => {
    const config = createConfig();
    config.dualBrushEnabled = true;
    config.dualBrush = {
      enabled: true,
      brushId: 'dual-a',
      brushIndex: 0,
      brushName: 'Dual A',
      mode: 'multiply',
      flip: false,
      size: 12,
      sizeRatio: 0.5,
      spacing: 0.3,
      roundness: 100,
      scatter: 0,
      bothAxes: false,
      count: 1,
    };

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
      for (let i = 0; i < 8; i += 1) {
        result.current.processPoint(i * 5, 0, 0.5, config, i, undefined, {
          timestampMs: i * 4,
        });
      }
    });

    const gpu = gpuState.instances[0];
    if (!gpu) {
      throw new Error('expected gpu instance to exist');
    }
    const secondaryCountBeforePrepare = gpu.stampSecondaryDabCalls.length;

    await act(async () => {
      await result.current.prepareStrokeEndGpu();
    });

    const secondaryCountAfterPrepare = gpu.stampSecondaryDabCalls.length;
    expect(secondaryCountAfterPrepare).toBeGreaterThan(secondaryCountBeforePrepare);

    await act(async () => {
      await result.current.prepareStrokeEndGpu();
    });
    expect(gpu.stampSecondaryDabCalls.length).toBe(secondaryCountAfterPrepare);

    await act(async () => {
      await result.current.endStroke({} as CanvasRenderingContext2D);
    });
    expect(gpu.stampSecondaryDabCalls.length).toBe(secondaryCountAfterPrepare);
  });

  it('emits secondary finalize dabs once in texture dual brush mode', async () => {
    const config = createConfig();
    config.dualBrushEnabled = true;
    config.dualBrush = {
      enabled: true,
      brushId: 'dual-texture',
      brushIndex: 1,
      brushName: 'Dual Texture',
      mode: 'overlay',
      flip: false,
      size: 14,
      sizeRatio: 0.58,
      spacing: 0.25,
      roundness: 90,
      scatter: 0,
      bothAxes: false,
      count: 1,
      texture: {
        id: 'dual-texture-id',
        data: 'data:image/png;base64,AA==',
        width: 8,
        height: 8,
      },
    };

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
      for (let i = 0; i < 8; i += 1) {
        result.current.processPoint(i * 5, 0, 0.5, config, i, undefined, {
          timestampMs: i * 4,
        });
      }
    });

    const gpu = gpuState.instances[0];
    if (!gpu) {
      throw new Error('expected gpu instance to exist');
    }
    const secondaryCountBeforePrepare = gpu.stampSecondaryDabCalls.length;

    await act(async () => {
      await result.current.prepareStrokeEndGpu();
    });

    const secondaryCountAfterPrepare = gpu.stampSecondaryDabCalls.length;
    expect(secondaryCountAfterPrepare).toBeGreaterThan(secondaryCountBeforePrepare);

    await act(async () => {
      await result.current.prepareStrokeEndGpu();
    });
    expect(gpu.stampSecondaryDabCalls.length).toBe(secondaryCountAfterPrepare);
  });

  it('feeds non-constant fadeProgress on main chain and does not inject finalize smoothing calls', async () => {
    const config = createConfig();
    config.pressureSizeEnabled = false;
    config.shapeDynamicsEnabled = true;
    const shapeSpy = vi.spyOn(shapeDynamicsModule, 'computeDabShape');
    config.shapeDynamics = {
      sizeJitter: 0,
      sizeControl: 'fade',
      minimumDiameter: 0,
      angleJitter: 0,
      angleControl: 'off',
      roundnessJitter: 0,
      roundnessControl: 'off',
      minimumRoundness: 25,
      flipXJitter: false,
      flipYJitter: false,
    };

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
      for (let i = 0; i < 9; i += 1) {
        result.current.processPoint(i * 6, 0, 0.4, config, i, undefined, {
          timestampMs: i * 4,
        });
      }
    });

    const gpu = gpuState.instances[0];
    if (!gpu) {
      throw new Error('expected gpu instance to exist');
    }
    const beforeTailCount = gpu.stampDabCalls.length;
    const beforeFinalizeShapeCallCount = shapeSpy.mock.calls.length;

    await act(async () => {
      await result.current.prepareStrokeEndGpu();
    });

    const finalizeCalls = gpu.stampDabCalls.slice(beforeTailCount) as Array<{ size?: number }>;
    expect(finalizeCalls.length).toBe(1);

    const calls = shapeSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);

    const dynamicsInputs = calls.map((call) => call[4] as DynamicsInput);
    expect(dynamicsInputs.length).toBeGreaterThan(4);

    const fadeValues = dynamicsInputs.map((input) => input.fadeProgress);
    const minFade = Math.min(...fadeValues);
    const maxFade = Math.max(...fadeValues);
    expect(maxFade - minFade).toBeGreaterThan(0.05);

    const finalizeDynamics = calls
      .slice(beforeFinalizeShapeCallCount)
      .map((call) => call[4] as DynamicsInput);
    expect(finalizeDynamics.length).toBe(1);
  });

  it('forces size pressure override from toolbar even when Shape Dynamics size control is non-pressure', async () => {
    const shapeDynamics = {
      sizeJitter: 0,
      sizeControl: 'penTilt' as const,
      minimumDiameter: 0,
      angleJitter: 0,
      angleControl: 'off' as const,
      roundnessJitter: 0,
      roundnessControl: 'off' as const,
      minimumRoundness: 25,
      flipXJitter: false,
      flipYJitter: false,
    };

    async function collectMainDabStats(pressureSizeEnabled: boolean): Promise<{
      maxSize: number;
      maxOpacity: number;
    }> {
      const config = createConfig();
      config.pressureSizeEnabled = pressureSizeEnabled;
      config.pressureFlowEnabled = false;
      config.pressureOpacityEnabled = false;
      config.shapeDynamicsEnabled = true;
      config.shapeDynamics = shapeDynamics;

      const { result, unmount } = renderHook(() =>
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
          result.current.processPoint(
            i * 6,
            0,
            0.4,
            config,
            i,
            { tiltX: 0, tiltY: 0, rotation: 0 },
            { timestampMs: i * 4 }
          );
        }
      });

      const gpu = gpuState.instances[gpuState.instances.length - 1];
      if (!gpu) {
        throw new Error('expected gpu instance to exist');
      }

      const mainCalls = gpu.stampDabCalls as Array<{ size?: number; dabOpacity?: number }>;
      const sizes = mainCalls
        .map((call) => call.size)
        .filter((size): size is number => typeof size === 'number' && Number.isFinite(size));
      const opacities = mainCalls
        .map((call) => call.dabOpacity)
        .filter(
          (dabOpacity): dabOpacity is number =>
            typeof dabOpacity === 'number' && Number.isFinite(dabOpacity)
        );

      unmount();

      return {
        maxSize: sizes.length > 0 ? Math.max(...sizes) : 0,
        maxOpacity: opacities.length > 0 ? Math.max(...opacities) : 0,
      };
    }

    const withoutOverride = await collectMainDabStats(false);
    const withOverride = await collectMainDabStats(true);

    expect(withoutOverride.maxOpacity).toBeLessThan(0.05);
    expect(withoutOverride.maxSize).toBeLessThanOrEqual(1.01);

    expect(withOverride.maxSize).toBeGreaterThan(4);
    expect(withOverride.maxOpacity).toBeGreaterThan(0.1);
  });
});
