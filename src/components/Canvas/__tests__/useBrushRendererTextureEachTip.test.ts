import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBrushRenderer, type BrushRenderConfig } from '../useBrushRenderer';
import { StrokeAccumulator } from '@/utils/strokeBuffer';
import { DEFAULT_TEXTURE_SETTINGS } from '@/components/BrushPanel/types';
import { DEFAULT_SCATTER_SETTINGS } from '@/stores/tool';

function createBaseConfig(overrides: Partial<BrushRenderConfig> = {}): BrushRenderConfig {
  return {
    size: 18,
    flow: 1,
    opacity: 1,
    hardness: 100,
    maskType: 'gaussian',
    spacing: 0.08,
    roundness: 100,
    angle: 0,
    color: '#000000',
    backgroundColor: '#ffffff',
    pressureSizeEnabled: false,
    pressureFlowEnabled: false,
    pressureOpacityEnabled: false,
    pressureCurve: 'linear',
    texture: null,
    shapeDynamicsEnabled: false,
    scatterEnabled: false,
    colorDynamicsEnabled: false,
    wetEdgeEnabled: false,
    wetEdge: 0,
    buildupEnabled: false,
    transferEnabled: false,
    textureEnabled: true,
    textureSettings: {
      ...DEFAULT_TEXTURE_SETTINGS,
      patternId: '__test_pattern__',
      textureEachTip: true,
      depth: 80,
      depthControl: 0,
      minimumDepth: 60,
      depthJitter: 50,
    },
    noiseEnabled: false,
    dualBrushEnabled: false,
    strokeCompositeMode: 'paint',
    ...overrides,
  };
}

describe('useBrushRenderer texture each tip depth dynamics', () => {
  let getContextSpy: ReturnType<typeof vi.spyOn>;
  let stampSpy: ReturnType<typeof vi.spyOn>;
  let restoreRandom: (() => void) | null = null;

  beforeEach(() => {
    const mockCtx = {
      createImageData: (width: number, height: number) => new ImageData(width, height),
      clearRect: vi.fn(),
    };

    // @ts-expect-error - Mocking getContext for test environment
    getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return mockCtx as any;
    });

    stampSpy = vi.spyOn(StrokeAccumulator.prototype, 'stampDab') as ReturnType<typeof vi.spyOn>;
    stampSpy.mockImplementation(() => {});
  });

  afterEach(() => {
    restoreRandom?.();
    restoreRandom = null;
    stampSpy.mockRestore();
    getContextSpy.mockRestore();
  });

  it('recomputes jittered depth per final stamp when depthJitter > 0', async () => {
    const randomSeq = [0, 1, 0, 1, 0.25, 0.75];
    let randomIndex = 0;
    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      const value = randomSeq[randomIndex % randomSeq.length]!;
      randomIndex += 1;
      return value;
    });
    restoreRandom = () => randomSpy.mockRestore();

    const config = createBaseConfig();

    const { result } = renderHook(() =>
      useBrushRenderer({ width: 160, height: 120, renderMode: 'cpu' })
    );

    await act(async () => {
      await result.current.beginStroke(100, 0);
    });

    act(() => {
      result.current.processPoint(20, 40, 1.0, config);
      result.current.processPoint(50, 40, 1.0, config);
      result.current.processPoint(80, 40, 1.0, config);
    });

    const sampledDepths = stampSpy.mock.calls
      .map((call) => {
        const dab = call[0] as { textureSettings?: { depth?: number } } | undefined;
        return dab?.textureSettings?.depth;
      })
      .filter((depth): depth is number => Number.isFinite(depth));

    expect(sampledDepths.length).toBeGreaterThan(1);
    expect(new Set(sampledDepths).size).toBeGreaterThan(1);
    expect(sampledDepths).toContain(40);
    expect(sampledDepths).toContain(100);
  });

  it('does not share one depth value across scattered stamps (count > 1)', async () => {
    let tick = 0;
    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      const value = (tick % 10) / 9;
      tick += 1;
      return value;
    });
    restoreRandom = () => randomSpy.mockRestore();

    const config = createBaseConfig({
      scatterEnabled: true,
      scatter: {
        ...DEFAULT_SCATTER_SETTINGS,
        scatter: 0,
        count: 3,
        countJitter: 0,
      },
    });

    const { result } = renderHook(() =>
      useBrushRenderer({ width: 160, height: 120, renderMode: 'cpu' })
    );

    await act(async () => {
      await result.current.beginStroke(100, 0);
    });

    act(() => {
      result.current.processPoint(24, 36, 1.0, config);
      result.current.processPoint(52, 36, 1.0, config);
    });

    const sampledDepths = stampSpy.mock.calls
      .map((call) => {
        const dab = call[0] as { textureSettings?: { depth?: number } } | undefined;
        return dab?.textureSettings?.depth;
      })
      .filter((depth): depth is number => Number.isFinite(depth));

    expect(sampledDepths.length).toBeGreaterThanOrEqual(3);
    expect(new Set(sampledDepths.slice(0, 3)).size).toBeGreaterThan(1);
  });
});
