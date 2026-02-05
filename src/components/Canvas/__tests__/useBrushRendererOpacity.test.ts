import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBrushRenderer, type BrushRenderConfig } from '../useBrushRenderer';
import { StrokeAccumulator } from '@/utils/strokeBuffer';

describe('useBrushRenderer opacity pipeline', () => {
  let getContextSpy: ReturnType<typeof vi.spyOn>;
  let stampSpy: ReturnType<typeof vi.spyOn>;
  let endStrokeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const mockCtx = {
      createImageData: (width: number, height: number) => new ImageData(width, height),
      clearRect: vi.fn(),
    };

    // @ts-expect-error - Mocking getContext for testing
    getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return mockCtx as any;
    });

    stampSpy = vi.spyOn(StrokeAccumulator.prototype, 'stampDab') as ReturnType<typeof vi.spyOn>;
    stampSpy.mockImplementation(() => {});
    endStrokeSpy = vi.spyOn(StrokeAccumulator.prototype, 'endStroke') as ReturnType<
      typeof vi.spyOn
    >;
    endStrokeSpy.mockImplementation(() => ({ left: 0, top: 0, right: 0, bottom: 0 }));
  });

  afterEach(() => {
    getContextSpy.mockRestore();
    stampSpy.mockRestore();
    endStrokeSpy.mockRestore();
  });

  it('applies stroke opacity at composite stage (not baked into dabs)', async () => {
    const config: BrushRenderConfig = {
      size: 100,
      flow: 1,
      opacity: 0.5,
      hardness: 100,
      maskType: 'gaussian',
      spacing: 0.25,
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
      textureEnabled: false,
      noiseEnabled: false,
      dualBrushEnabled: false,
    };

    const { result } = renderHook(() =>
      useBrushRenderer({ width: 128, height: 128, renderMode: 'cpu' })
    );

    await act(async () => {
      await result.current.beginStroke(100, 0);
    });

    act(() => {
      result.current.processPoint(64, 64, 1.0, config);
      // Second point: move enough to emit at least one dab (BrushStamper MIN_MOVEMENT_DISTANCE gate)
      result.current.processPoint(68, 64, 1.0, config);
    });

    // Preview should be composited with stroke-level opacity.
    expect(result.current.getPreviewOpacity()).toBeCloseTo(0.5, 5);

    // Dabs should NOT bake in base opacity; they should use a per-dab multiplier (defaults to 1).
    expect(stampSpy).toHaveBeenCalled();
    const firstDab = stampSpy.mock.calls[0]?.[0] as { dabOpacity?: number } | undefined;
    expect(firstDab?.dabOpacity ?? 1.0).toBeCloseTo(1.0, 5);

    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await result.current.endStroke({} as any);
    });

    // Final composite must use the same stroke-level opacity.
    expect(endStrokeSpy).toHaveBeenCalled();
    const compositeOpacity = endStrokeSpy.mock.calls[0]?.[1] as number | undefined;
    expect(compositeOpacity).toBeCloseTo(0.5, 5);
  });
});
