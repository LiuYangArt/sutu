import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useGradientTool } from '../useGradientTool';
import type { Layer } from '@/stores/document';
import { useToolStore } from '@/stores/tool';
import { useGradientStore } from '@/stores/gradient';
import { useSelectionStore } from '@/stores/selection';
import type { LayerRenderer } from '@/utils/layerRenderer';

type GradientPreviewPayload = {
  previewLayerCanvas?: HTMLCanvasElement | null;
  guide?: { start: { x: number; y: number }; end: { x: number; y: number }; showAnchor: boolean };
};

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

function createMockLayerRenderer(): LayerRenderer {
  return {
    getLayerImageData: vi.fn(() => new ImageData(new Uint8ClampedArray(16), 2, 2)),
  } as unknown as LayerRenderer;
}

function getFirstPreviewPayload(
  renderPreview: ReturnType<typeof vi.fn>
): GradientPreviewPayload | undefined {
  return renderPreview.mock.calls[0]?.[0] as GradientPreviewPayload | undefined;
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

  it('renders guide-only preview on pointer down before drag', () => {
    const layer = createLayer('layer_anchor');
    const renderer = createMockLayerRenderer();
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
      result.current.handleGradientPointerDown(1, 1, {
        button: 0,
        shiftKey: false,
      } as PointerEvent);
      flushNextFrame();
    });

    expect(renderPreview).toHaveBeenCalledTimes(1);
    const payload = getFirstPreviewPayload(renderPreview);
    expect(payload?.previewLayerCanvas).toBeUndefined();
    expect(payload?.guide?.showAnchor).toBe(true);
    expect(payload?.guide?.start).toEqual({ x: 1, y: 1 });
    expect(payload?.guide?.end).toEqual({ x: 1, y: 1 });
  });

  it('handles drag session and commits on pointer up', async () => {
    const layer = createLayer('layer_a');
    const renderer = createMockLayerRenderer();

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
    const previewPayload = getFirstPreviewPayload(renderPreview);
    expect(previewPayload?.previewLayerCanvas).toBeInstanceOf(HTMLCanvasElement);
    expect(previewPayload?.guide?.showAnchor).toBe(true);
    expect(previewPayload?.guide?.start).toEqual({ x: 0, y: 0 });
    expect(previewPayload?.guide?.end).toEqual({ x: 2, y: 0 });

    await act(async () => {
      result.current.handleGradientPointerUp(2, 0, { shiftKey: false } as PointerEvent);
    });

    expect(applyGradientToActiveLayer).toHaveBeenCalledTimes(1);
    expect(clearPreview).toHaveBeenCalled();
  });

  it('applies shift 45-degree constraint for end point', async () => {
    const layer = createLayer('layer_shift');
    const renderer = createMockLayerRenderer();

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
    const renderer = createMockLayerRenderer();

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

  it('falls back to guide-only preview when selection mask is pending', () => {
    useSelectionStore.setState({
      hasSelection: true,
      selectionMask: null,
      selectionMaskPending: true,
    });

    const layer = createLayer('layer_selection_pending');
    const renderer = createMockLayerRenderer();
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
      result.current.handleGradientPointerMove(2, 1, { shiftKey: false } as PointerEvent);
      flushNextFrame();
    });

    expect(renderPreview).toHaveBeenCalledTimes(1);
    const payload = getFirstPreviewPayload(renderPreview);
    expect(payload?.previewLayerCanvas).toBeUndefined();
    expect(payload?.guide?.start).toEqual({ x: 0, y: 0 });
    expect(payload?.guide?.end).toEqual({ x: 2, y: 1 });
  });

  it('throttles preview rendering with requestAnimationFrame', () => {
    const layer = createLayer('layer_throttle');
    const renderer = createMockLayerRenderer();

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
