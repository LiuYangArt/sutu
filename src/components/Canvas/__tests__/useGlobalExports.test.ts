import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGlobalExports } from '../useGlobalExports';
import { useDocumentStore } from '@/stores/document';
import { useViewportStore } from '@/stores/viewport';
import { useToolStore } from '@/stores/tool';

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
  delete win.__gpuM0Baseline;
  delete win.__gpuFormatCompare;
  delete win.__gpuTileSizeCompare;
  delete win.__gpuBrushDiagnostics;
  delete win.__gpuBrushDiagnosticsReset;
  delete win.__gpuBrushCommitMetrics;
  delete win.__gpuBrushCommitMetricsReset;
  delete win.__gpuBrushCommitReadbackMode;
  delete win.__gpuBrushCommitReadbackModeSet;
  delete win.__gpuBrushNoReadbackPilot;
  delete win.__gpuBrushNoReadbackPilotSet;
  delete win.__strokeCaptureStart;
  delete win.__strokeCaptureStop;
  delete win.__strokeCaptureLast;
  delete win.__strokeCaptureReplay;
  delete win.__strokeCaptureDownload;
  delete win.__strokeCaptureSaveFixed;
  delete win.__strokeCaptureLoadFixed;
}

describe('useGlobalExports', () => {
  beforeEach(() => {
    cleanupGlobals();

    // Reset document store to keep tests isolated, then set deterministic dimensions for thumbnails.
    useDocumentStore.getState().reset();
    useDocumentStore.setState({ width: 100, height: 80 });
    useViewportStore.getState().resetZoom();
    useToolStore.setState({
      currentTool: 'eraser',
      brushSize: 20,
      brushFlow: 1,
      brushOpacity: 1,
      brushHardness: 100,
      brushSpacing: 0.25,
      pressureCurve: 'linear',
      pressureSizeEnabled: false,
      pressureFlowEnabled: false,
      pressureOpacityEnabled: true,
    });

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
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    cleanupGlobals();
    window.localStorage.clear();
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
    const capture = {
      version: 1 as const,
      createdAt: new Date().toISOString(),
      metadata: {
        canvasWidth: 100,
        canvasHeight: 80,
        viewportScale: 1,
        tool: {},
      },
      samples: [],
    };
    const startStrokeCapture = vi.fn(() => true);
    const stopStrokeCapture = vi.fn(() => capture);
    const getLastStrokeCapture = vi.fn(() => capture);
    const replayStrokeCapture = vi.fn(async () => ({ events: 0, durationMs: 0 }));
    const downloadStrokeCapture = vi.fn(() => true);
    const getGpuDiagnosticsSnapshot = vi.fn(() => ({ ok: true }));
    const resetGpuDiagnostics = vi.fn();
    const getGpuBrushCommitMetricsSnapshot = vi.fn(() => ({
      attemptCount: 1,
      committedCount: 1,
      avgPrepareMs: 0,
      avgCommitMs: 0,
      avgReadbackMs: 0,
      avgTotalMs: 0,
      maxTotalMs: 0,
      totalDirtyTiles: 0,
      avgDirtyTiles: 0,
      maxDirtyTiles: 0,
      lastCommitAtMs: 1,
      readbackMode: 'enabled' as const,
      readbackBypassedCount: 0,
    }));
    const resetGpuBrushCommitMetrics = vi.fn(() => true);
    const getGpuBrushCommitReadbackMode = vi.fn(() => 'enabled' as const);
    const setGpuBrushCommitReadbackMode = vi.fn(() => true);
    const getGpuBrushNoReadbackPilot = vi.fn(() => false);
    const setGpuBrushNoReadbackPilot = vi.fn(() => true);

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
        getGpuDiagnosticsSnapshot,
        resetGpuDiagnostics,
        getGpuBrushCommitMetricsSnapshot,
        resetGpuBrushCommitMetrics,
        getGpuBrushCommitReadbackMode,
        setGpuBrushCommitReadbackMode,
        getGpuBrushNoReadbackPilot,
        setGpuBrushNoReadbackPilot,
        startStrokeCapture,
        stopStrokeCapture,
        getLastStrokeCapture,
        replayStrokeCapture,
        downloadStrokeCapture,
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
    expect(typeof win.__gpuBrushDiagnostics).toBe('function');
    expect(typeof win.__gpuBrushDiagnosticsReset).toBe('function');
    expect(typeof win.__gpuBrushCommitMetrics).toBe('function');
    expect(typeof win.__gpuBrushCommitMetricsReset).toBe('function');
    expect(typeof win.__gpuBrushCommitReadbackMode).toBe('function');
    expect(typeof win.__gpuBrushCommitReadbackModeSet).toBe('function');
    expect(typeof win.__gpuBrushNoReadbackPilot).toBe('function');
    expect(typeof win.__gpuBrushNoReadbackPilotSet).toBe('function');
    expect(typeof win.__strokeCaptureStart).toBe('function');
    expect(typeof win.__strokeCaptureStop).toBe('function');
    expect(typeof win.__strokeCaptureLast).toBe('function');
    expect(typeof win.__strokeCaptureReplay).toBe('function');
    expect(typeof win.__strokeCaptureDownload).toBe('function');
    expect(typeof win.__strokeCaptureSaveFixed).toBe('function');
    expect(typeof win.__strokeCaptureLoadFixed).toBe('function');

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
      win.__strokeCaptureStart();
      win.__strokeCaptureStop();
      win.__strokeCaptureLast();
      win.__strokeCaptureDownload('case.json');
      win.__gpuBrushDiagnostics();
      win.__gpuBrushDiagnosticsReset();
      win.__gpuBrushCommitMetrics();
      win.__gpuBrushCommitMetricsReset();
      win.__gpuBrushCommitReadbackMode();
      win.__gpuBrushCommitReadbackModeSet('disabled');
      win.__gpuBrushNoReadbackPilot();
      win.__gpuBrushNoReadbackPilotSet(true);
    });
    await win.__strokeCaptureReplay(capture);
    const fixedSave = await win.__strokeCaptureSaveFixed(capture);
    const fixedLoad = await win.__strokeCaptureLoadFixed();

    expect(fillActiveLayer).toHaveBeenCalledWith('#ffffff');
    expect(handleClearSelection).toHaveBeenCalledTimes(1);
    expect(handleUndo).toHaveBeenCalledTimes(1);
    expect(handleRedo).toHaveBeenCalledTimes(1);
    expect(handleClearLayer).toHaveBeenCalledTimes(1);
    expect(handleDuplicateLayer).toHaveBeenCalledWith('from', 'to');
    expect(handleRemoveLayer).toHaveBeenCalledWith('id');
    expect(handleResizeCanvas).toHaveBeenCalledTimes(1);
    expect(startStrokeCapture).toHaveBeenCalledTimes(1);
    expect(stopStrokeCapture).toHaveBeenCalledTimes(1);
    expect(getLastStrokeCapture).toHaveBeenCalledTimes(3);
    expect(replayStrokeCapture).toHaveBeenCalledTimes(1);
    expect(downloadStrokeCapture).toHaveBeenCalledWith('case.json', undefined);
    expect(getGpuDiagnosticsSnapshot).toHaveBeenCalledTimes(1);
    expect(resetGpuDiagnostics).toHaveBeenCalledTimes(1);
    expect(getGpuBrushCommitMetricsSnapshot).toHaveBeenCalledTimes(1);
    expect(resetGpuBrushCommitMetrics).toHaveBeenCalledTimes(1);
    expect(getGpuBrushCommitReadbackMode).toHaveBeenCalledTimes(1);
    expect(setGpuBrushCommitReadbackMode).toHaveBeenCalledWith('disabled');
    expect(getGpuBrushNoReadbackPilot).toHaveBeenCalledTimes(1);
    expect(setGpuBrushNoReadbackPilot).toHaveBeenCalledWith(true);
    expect(fixedSave.ok).toBe(true);
    expect(fixedSave.name).toBe('debug-stroke-capture.json');
    expect(fixedSave.source).toBe('localstorage');
    expect(fixedLoad?.name).toBe('debug-stroke-capture.json');
    expect(fixedLoad?.source).toBe('localstorage');
    expect(fixedLoad?.capture).toEqual(capture);

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
    expect(win.__gpuBrushDiagnostics).toBeUndefined();
    expect(win.__gpuBrushDiagnosticsReset).toBeUndefined();
    expect(win.__gpuBrushCommitMetrics).toBeUndefined();
    expect(win.__gpuBrushCommitMetricsReset).toBeUndefined();
    expect(win.__gpuBrushCommitReadbackMode).toBeUndefined();
    expect(win.__gpuBrushCommitReadbackModeSet).toBeUndefined();
    expect(win.__gpuBrushNoReadbackPilot).toBeUndefined();
    expect(win.__gpuBrushNoReadbackPilotSet).toBeUndefined();
    expect(win.__strokeCaptureStart).toBeUndefined();
    expect(win.__strokeCaptureStop).toBeUndefined();
    expect(win.__strokeCaptureLast).toBeUndefined();
    expect(win.__strokeCaptureReplay).toBeUndefined();
    expect(win.__strokeCaptureDownload).toBeUndefined();
    expect(win.__strokeCaptureSaveFixed).toBeUndefined();
    expect(win.__strokeCaptureLoadFixed).toBeUndefined();
  });

  it('updates layer thumbnail after __loadLayerImages draws pixels (legacy base64 path)', async () => {
    // Seed document store with a layer so updateLayerThumbnail can apply.
    useDocumentStore.setState({
      layers: [
        {
          id: 'layerA',
          name: 'Layer A',
          type: 'raster',
          visible: true,
          locked: false,
          opacity: 100,
          blendMode: 'normal',
        },
      ],
      activeLayerId: 'layerA',
    });

    const OriginalImage = globalThis.Image;
    class TestImage {
      crossOrigin: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    (globalThis as any).Image = TestImage as any;

    try {
      const canvasA = document.createElement('canvas');

      const layerRenderer = {
        getLayer: (id: string) => {
          if (id === 'layerA') return { canvas: canvasA, ctx: canvasA.getContext('2d') };
          return null;
        },
        composite: () => canvasA,
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

      renderHook(() =>
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
      expect(typeof win.__loadLayerImages).toBe('function');

      await act(async () => {
        await win.__loadLayerImages([
          { id: 'layerA', imageData: 'data:image/png;base64,stub', offsetX: 0, offsetY: 0 },
        ]);
      });

      const layer = useDocumentStore.getState().layers.find((l) => l.id === 'layerA');
      expect(layer?.thumbnail).toMatch(/^data:image\/png;base64,/);
      expect(compositeAndRender).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as any).Image = OriginalImage as any;
    }
  });

  it('applies replay metadata context automatically before replay', async () => {
    const layerRendererRef = { current: null } as any;
    const replayCapture = {
      version: 1 as const,
      createdAt: new Date().toISOString(),
      metadata: {
        canvasWidth: 640,
        canvasHeight: 480,
        viewportScale: 0.75,
        viewportOffsetX: 20,
        viewportOffsetY: 30,
        tool: {
          currentTool: 'brush',
          brushColor: '#123456',
          brushSize: 77,
          brushFlow: 0.6,
          brushOpacity: 0.7,
          brushHardness: 55,
          brushSpacing: 0.4,
          pressureCurve: 'hard',
          pressureSizeEnabled: true,
          pressureFlowEnabled: true,
          pressureOpacityEnabled: false,
        },
      },
      samples: [],
    };

    const replayStrokeCapture = vi.fn(async () => ({ events: 0, durationMs: 0 }));
    const getLastStrokeCapture = vi.fn(() => replayCapture);
    const handleResizeCanvas = vi.fn();

    renderHook(() =>
      useGlobalExports({
        layerRendererRef,
        compositeAndRender: vi.fn(),
        fillActiveLayer: vi.fn(),
        handleClearSelection: vi.fn(),
        handleUndo: vi.fn(),
        handleRedo: vi.fn(),
        handleClearLayer: vi.fn(),
        handleDuplicateLayer: vi.fn(),
        handleRemoveLayer: vi.fn(),
        handleResizeCanvas,
        replayStrokeCapture,
        getLastStrokeCapture,
      })
    );

    const win = window as any;
    await win.__strokeCaptureReplay(replayCapture);

    expect(handleResizeCanvas).toHaveBeenCalledWith({
      width: 640,
      height: 480,
      anchor: 'top-left',
      scaleContent: false,
      extensionColor: 'transparent',
      resampleMode: 'nearest',
    });

    const viewport = useViewportStore.getState();
    expect(viewport.scale).toBeCloseTo(0.75);
    expect(viewport.offsetX).toBeCloseTo(20);
    expect(viewport.offsetY).toBeCloseTo(30);

    const tool = useToolStore.getState();
    expect(tool.currentTool).toBe('brush');
    expect(tool.brushColor).toBe('#123456');
    expect(tool.brushSize).toBe(77);
    expect(tool.brushFlow).toBeCloseTo(0.6);
    expect(tool.brushOpacity).toBeCloseTo(0.7);
    expect(tool.brushHardness).toBe(55);
    expect(tool.brushSpacing).toBeCloseTo(0.4);
    expect(tool.pressureCurve).toBe('hard');
    expect(tool.pressureSizeEnabled).toBe(true);
    expect(tool.pressureFlowEnabled).toBe(true);
    expect(tool.pressureOpacityEnabled).toBe(false);

    expect(replayStrokeCapture).toHaveBeenCalledWith(replayCapture, undefined);
    expect(
      (window.requestAnimationFrame as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    ).toBeGreaterThanOrEqual(3);
  });
});
