import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useGradientTool } from '../useGradientTool';
import type { Layer } from '@/stores/document';
import { useToolStore } from '@/stores/tool';
import { useGradientStore } from '@/stores/gradient';
import { useSelectionStore } from '@/stores/selection';
import type { LayerRenderer } from '@/utils/layerRenderer';

function createLayer(id: string): Layer {
  return {
    id,
    name: id,
    type: 'raster',
    visible: true,
    locked: false,
    opacity: 100,
    blendMode: 'normal',
  };
}

describe('useGradientTool', () => {
  const rafQueue: FrameRequestCallback[] = [];

  beforeEach(() => {
    useToolStore.setState({ currentTool: 'gradient' });
    useGradientStore.setState((state) => ({
      settings: {
        ...state.settings,
        shape: 'linear',
        blendMode: 'normal',
        opacity: 1,
        reverse: false,
        dither: false,
        transparency: true,
      },
    }));
    useSelectionStore.getState().deselectAll();

    vi.spyOn(HTMLCanvasElement.prototype as any, 'getContext').mockImplementation(function () {
      return {
        putImageData: vi.fn(),
        clearRect: vi.fn(),
        drawImage: vi.fn(),
      } as unknown as CanvasRenderingContext2D;
    });

    rafQueue.length = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function flushNextFrame(): void {
    const cb = rafQueue.shift();
    if (!cb) return;
    cb(16);
  }

  it('handles drag session and commits on pointer up', async () => {
    const layer = createLayer('layer_a');
    const renderer = {
      getLayerImageData: vi.fn(() => new ImageData(new Uint8ClampedArray(16), 2, 2)),
    } as unknown as LayerRenderer;

    const applyGradientToActiveLayer = vi.fn(async (_params: unknown) => true);
    const renderPreview = vi.fn();
    const clearPreview = vi.fn();

    const { result } = renderHook(() =>
      useGradientTool({
        currentTool: 'gradient',
        activeLayerId: layer.id,
        layers: [layer],
        width: 2,
        height: 2,
        layerRendererRef: { current: renderer },
        applyGradientToActiveLayer,
        renderPreview,
        clearPreview,
      })
    );

    act(() => {
      result.current.handleGradientPointerDown(0, 0, {
        button: 0,
        shiftKey: false,
      } as PointerEvent);
    });

    expect(rafQueue.length).toBe(1);

    act(() => {
      result.current.handleGradientPointerMove(2, 0, { shiftKey: false } as PointerEvent);
    });

    act(() => {
      flushNextFrame();
    });

    expect(renderPreview).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.handleGradientPointerUp(2, 0, { shiftKey: false } as PointerEvent);
    });

    expect(applyGradientToActiveLayer).toHaveBeenCalledTimes(1);
    expect(clearPreview).toHaveBeenCalled();
  });

  it('applies shift 45-degree constraint for end point', async () => {
    const layer = createLayer('layer_shift');
    const renderer = {
      getLayerImageData: vi.fn(() => new ImageData(new Uint8ClampedArray(16), 2, 2)),
    } as unknown as LayerRenderer;

    const applyGradientToActiveLayer = vi.fn(async (_params: unknown) => true);

    const { result } = renderHook(() =>
      useGradientTool({
        currentTool: 'gradient',
        activeLayerId: layer.id,
        layers: [layer],
        width: 2,
        height: 2,
        layerRendererRef: { current: renderer },
        applyGradientToActiveLayer,
        renderPreview: vi.fn(),
        clearPreview: vi.fn(),
      })
    );

    act(() => {
      result.current.handleGradientPointerDown(0, 0, {
        button: 0,
        shiftKey: false,
      } as PointerEvent);
      result.current.handleGradientPointerMove(10, 3, { shiftKey: true } as PointerEvent);
      flushNextFrame();
    });

    await act(async () => {
      result.current.handleGradientPointerUp(10, 3, { shiftKey: true } as PointerEvent);
    });

    const payload = applyGradientToActiveLayer.mock.calls[0]?.[0] as
      | { end: { x: number; y: number } }
      | undefined;
    expect(payload).toBeDefined();
    expect(Math.abs(payload!.end.y)).toBeLessThan(0.0001);
  });

  it('does not commit for zero-length drag', async () => {
    const layer = createLayer('layer_zero');
    const renderer = {
      getLayerImageData: vi.fn(() => new ImageData(new Uint8ClampedArray(16), 2, 2)),
    } as unknown as LayerRenderer;

    const applyGradientToActiveLayer = vi.fn(async (_params: unknown) => true);

    const { result } = renderHook(() =>
      useGradientTool({
        currentTool: 'gradient',
        activeLayerId: layer.id,
        layers: [layer],
        width: 2,
        height: 2,
        layerRendererRef: { current: renderer },
        applyGradientToActiveLayer,
        renderPreview: vi.fn(),
        clearPreview: vi.fn(),
      })
    );

    await act(async () => {
      result.current.handleGradientPointerDown(1, 1, {
        button: 0,
        shiftKey: false,
      } as PointerEvent);
      result.current.handleGradientPointerUp(1, 1, { shiftKey: false } as PointerEvent);
    });

    expect(applyGradientToActiveLayer).not.toHaveBeenCalled();
  });

  it('throttles preview rendering with requestAnimationFrame', () => {
    const layer = createLayer('layer_throttle');
    const renderer = {
      getLayerImageData: vi.fn(() => new ImageData(new Uint8ClampedArray(16), 2, 2)),
    } as unknown as LayerRenderer;

    const renderPreview = vi.fn();

    const { result } = renderHook(() =>
      useGradientTool({
        currentTool: 'gradient',
        activeLayerId: layer.id,
        layers: [layer],
        width: 2,
        height: 2,
        layerRendererRef: { current: renderer },
        applyGradientToActiveLayer: vi.fn(async (_params: unknown) => true),
        renderPreview,
        clearPreview: vi.fn(),
      })
    );

    act(() => {
      result.current.handleGradientPointerDown(0, 0, {
        button: 0,
        shiftKey: false,
      } as PointerEvent);
      result.current.handleGradientPointerMove(1, 0, { shiftKey: false } as PointerEvent);
      result.current.handleGradientPointerMove(2, 0, { shiftKey: false } as PointerEvent);
    });

    expect(rafQueue.length).toBe(1);

    act(() => {
      flushNextFrame();
    });

    expect(renderPreview).toHaveBeenCalledTimes(1);
  });
});
