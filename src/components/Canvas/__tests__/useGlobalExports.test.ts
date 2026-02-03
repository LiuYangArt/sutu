import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGlobalExports } from '../useGlobalExports';

function cleanupGlobals(): void {
  const win = window as any;
  delete win.__canvasFillLayer;
  delete win.__canvasClearSelection;
  delete win.__getLayerImageData;
  delete win.__getFlattenedImage;
  delete win.__getThumbnail;
  delete win.__loadLayerImages;
  delete win.__canvasUndo;
  delete win.__canvasRedo;
  delete win.__canvasClearLayer;
  delete win.__canvasDuplicateLayer;
  delete win.__canvasRemoveLayer;
  delete win.__canvasResize;
}

describe('useGlobalExports', () => {
  beforeEach(() => {
    cleanupGlobals();

    // JSDOM does not implement Canvas APIs. Stub minimal surface to avoid Not Implemented errors.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      return {
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        drawImage: vi.fn(),
        putImageData: vi.fn(),
        getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) })),
        save: vi.fn(),
        restore: vi.fn(),
      } as any;
    });
    const proto = HTMLCanvasElement.prototype as any;
    if (typeof proto.toDataURL === 'function') {
      vi.spyOn(proto, 'toDataURL').mockImplementation(() => 'data:image/png;base64,stub');
    } else {
      // Define a stub if missing (some JSDOM builds).
      Object.defineProperty(proto, 'toDataURL', {
        value: () => 'data:image/png;base64,stub',
        configurable: true,
        writable: true,
      });
    }
  });

  afterEach(() => {
    cleanupGlobals();
    vi.restoreAllMocks();
  });

  it('registers window.__* functions and cleans them up on unmount', async () => {
    const canvasA = document.createElement('canvas');
    const canvasB = document.createElement('canvas');

    const layerRenderer = {
      getLayer: (id: string) => {
        if (id === 'layerA') return { canvas: canvasA, ctx: canvasA.getContext('2d') };
        return null;
      },
      composite: () => canvasB,
    } as any;

    const layerRendererRef = { current: layerRenderer } as any;

    const compositeAndRender = vi.fn();
    const fillActiveLayer = vi.fn();
    const handleClearSelection = vi.fn();
    const handleUndo = vi.fn();
    const handleRedo = vi.fn();
    const handleClearLayer = vi.fn();
    const handleDuplicateLayer = vi.fn();
    const handleRemoveLayer = vi.fn();
    const handleResizeCanvas = vi.fn();

    const { unmount } = renderHook(() =>
      useGlobalExports({
        layerRendererRef,
        compositeAndRender,
        fillActiveLayer,
        handleClearSelection,
        handleUndo,
        handleRedo,
        handleClearLayer,
        handleDuplicateLayer,
        handleRemoveLayer,
        handleResizeCanvas,
      })
    );

    const win = window as any;

    expect(typeof win.__canvasFillLayer).toBe('function');
    expect(typeof win.__canvasClearSelection).toBe('function');
    expect(typeof win.__canvasUndo).toBe('function');
    expect(typeof win.__canvasRedo).toBe('function');
    expect(typeof win.__canvasClearLayer).toBe('function');
    expect(typeof win.__canvasDuplicateLayer).toBe('function');
    expect(typeof win.__canvasRemoveLayer).toBe('function');
    expect(typeof win.__canvasResize).toBe('function');
    expect(typeof win.__getLayerImageData).toBe('function');
    expect(typeof win.__getFlattenedImage).toBe('function');
    expect(typeof win.__getThumbnail).toBe('function');

    act(() => {
      win.__canvasFillLayer('#ffffff');
      win.__canvasClearSelection();
      win.__canvasUndo();
      win.__canvasRedo();
      win.__canvasClearLayer();
      win.__canvasDuplicateLayer('from', 'to');
      win.__canvasRemoveLayer('id');
      win.__canvasResize({
        width: 100,
        height: 80,
        anchor: 'center',
        scaleContent: false,
        extensionColor: 'transparent',
        resampleMode: 'nearest',
      });
    });

    expect(fillActiveLayer).toHaveBeenCalledWith('#ffffff');
    expect(handleClearSelection).toHaveBeenCalledTimes(1);
    expect(handleUndo).toHaveBeenCalledTimes(1);
    expect(handleRedo).toHaveBeenCalledTimes(1);
    expect(handleClearLayer).toHaveBeenCalledTimes(1);
    expect(handleDuplicateLayer).toHaveBeenCalledWith('from', 'to');
    expect(handleRemoveLayer).toHaveBeenCalledWith('id');
    expect(handleResizeCanvas).toHaveBeenCalledTimes(1);

    await expect(win.__getLayerImageData('layerA')).resolves.toMatch(/^data:/);
    await expect(win.__getFlattenedImage()).resolves.toMatch(/^data:/);
    // __getThumbnail may return undefined when canvas context is unavailable; we only assert no throw.
    const thumb = await win.__getThumbnail();
    expect(thumb === undefined || (typeof thumb === 'string' && thumb.startsWith('data:'))).toBe(
      true
    );

    unmount();

    expect(win.__canvasFillLayer).toBeUndefined();
    expect(win.__canvasClearSelection).toBeUndefined();
    expect(win.__getLayerImageData).toBeUndefined();
    expect(win.__getFlattenedImage).toBeUndefined();
    expect(win.__getThumbnail).toBeUndefined();
    expect(win.__loadLayerImages).toBeUndefined();
    expect(win.__canvasUndo).toBeUndefined();
    expect(win.__canvasRedo).toBeUndefined();
    expect(win.__canvasClearLayer).toBeUndefined();
    expect(win.__canvasDuplicateLayer).toBeUndefined();
    expect(win.__canvasRemoveLayer).toBeUndefined();
    expect(win.__canvasResize).toBeUndefined();
  });
});
