import { useEffect, type RefObject } from 'react';
import { useDocumentStore, type ResizeCanvasOptions } from '@/stores/document';
import { LayerRenderer } from '@/utils/layerRenderer';
import { decompressLz4PrependSize } from '@/utils/lz4';
import { renderLayerThumbnail } from '@/utils/layerThumbnail';
import { GPUContext, runM0Baseline } from '@/gpu';

interface UseGlobalExportsParams {
  layerRendererRef: RefObject<LayerRenderer | null>;
  compositeAndRender: () => void;
  fillActiveLayer: (color: string) => void;
  handleClearSelection: () => void;
  handleUndo: () => void;
  handleRedo: () => void;
  handleClearLayer: () => void;
  handleDuplicateLayer: (from: string, to: string) => void;
  handleRemoveLayer: (id: string) => void;
  handleResizeCanvas: (options: ResizeCanvasOptions) => void;
}

export function useGlobalExports({
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
}: UseGlobalExportsParams): void {
  useEffect(() => {
    const win = window as Window & {
      __canvasFillLayer?: (color: string) => void;
      __canvasClearSelection?: () => void;
      __getLayerImageData?: (layerId: string) => Promise<string | undefined>;
      __getFlattenedImage?: () => Promise<string | undefined>;
      __getThumbnail?: () => Promise<string | undefined>;
      __loadLayerImages?: (
        layersData: Array<{ id: string; imageData?: string; offsetX?: number; offsetY?: number }>,
        benchmarkSessionId?: string
      ) => Promise<void>;
      __canvasUndo?: () => void;
      __canvasRedo?: () => void;
      __canvasClearLayer?: () => void;
      __canvasDuplicateLayer?: (from: string, to: string) => void;
      __canvasRemoveLayer?: (id: string) => void;
      __canvasResize?: (options: ResizeCanvasOptions) => void;
      __gpuM0Baseline?: () => Promise<void>;
    };

    win.__canvasFillLayer = fillActiveLayer;
    win.__canvasClearSelection = handleClearSelection;
    win.__canvasUndo = handleUndo;
    win.__canvasRedo = handleRedo;
    win.__canvasClearLayer = handleClearLayer;
    win.__canvasDuplicateLayer = handleDuplicateLayer;
    win.__canvasRemoveLayer = handleRemoveLayer;
    win.__canvasResize = handleResizeCanvas;
    win.__gpuM0Baseline = async () => {
      const device = GPUContext.getInstance().device;
      if (!device) {
        console.warn('[M0Baseline] GPU device not available');
        return;
      }
      const result = await runM0Baseline(device);
      // eslint-disable-next-line no-console
      console.log('[M0Baseline] result', result);
    };

    // Get single layer image data as Base64 PNG data URL
    win.__getLayerImageData = async (layerId: string): Promise<string | undefined> => {
      if (!layerRendererRef.current) return undefined;
      const layer = layerRendererRef.current.getLayer(layerId);
      if (!layer) return undefined;

      // Export canvas as PNG data URL
      return layer.canvas.toDataURL('image/png');
    };

    // Get flattened (composited) image
    win.__getFlattenedImage = async (): Promise<string | undefined> => {
      if (!layerRendererRef.current) return undefined;
      const compositeCanvas = layerRendererRef.current.composite();
      return compositeCanvas.toDataURL('image/png');
    };

    // Get thumbnail (256x256)
    win.__getThumbnail = async (): Promise<string | undefined> => {
      if (!layerRendererRef.current) return undefined;
      const compositeCanvas = layerRendererRef.current.composite();

      // Create thumbnail canvas
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 256;
      thumbCanvas.height = 256;
      const ctx = thumbCanvas.getContext('2d');
      if (!ctx) return undefined;

      // Scale to fit 256x256 maintaining aspect ratio
      const scale = Math.min(256 / compositeCanvas.width, 256 / compositeCanvas.height);
      const w = compositeCanvas.width * scale;
      const h = compositeCanvas.height * scale;
      const x = (256 - w) / 2;
      const y = (256 - h) / 2;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 256, 256);
      ctx.drawImage(compositeCanvas, x, y, w, h);

      return thumbCanvas.toDataURL('image/png');
    };

    // Load layer images when opening a file
    // Uses project:// custom protocol for zero-copy binary transfer
    // Supports both encoded images (PNG/WebP) and raw RGBA data (with optional LZ4 compression)
    win.__loadLayerImages = async (
      layersData: Array<{ id: string; imageData?: string; offsetX?: number; offsetY?: number }>,
      benchmarkSessionId?: string
    ): Promise<void> => {
      if (!layerRendererRef.current) return;

      const docState = useDocumentStore.getState();
      const docWidth = docState.width;
      const docHeight = docState.height;
      const updateLayerThumbnail = docState.updateLayerThumbnail;

      function updateThumbnailForLayer(layerId: string, layerCanvas: HTMLCanvasElement): void {
        const thumb = renderLayerThumbnail(layerCanvas, docWidth, docHeight);
        if (thumb) updateLayerThumbnail(layerId, thumb);
      }

      let fetchTotal = 0;
      let decompressTotal = 0;
      let renderTotal = 0;

      for (const layerData of layersData) {
        const layer = layerRendererRef.current.getLayer(layerData.id);
        if (!layer) continue;

        // Get offset for layer positioning
        const offsetX = layerData.offsetX ?? 0;
        const offsetY = layerData.offsetY ?? 0;

        // Determine image source: project:// protocol or legacy base64
        if (layerData.imageData) {
          // Legacy: base64 data provided (for backward compatibility)
          const imgSrc = layerData.imageData.startsWith('data:')
            ? layerData.imageData
            : `data:image/png;base64,${layerData.imageData}`;

          const img = new Image();
          img.crossOrigin = 'anonymous';
          await new Promise<void>((resolve) => {
            img.onload = () => {
              layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
              layer.ctx.drawImage(img, offsetX, offsetY);
              updateThumbnailForLayer(layerData.id, layer.canvas);
              resolve();
            };
            img.onerror = () => resolve();
            img.src = imgSrc;
          });
        } else {
          // New: use project:// custom protocol
          const url = `http://project.localhost/layer/${layerData.id}`;
          try {
            const fetchStart = performance.now();
            const response = await fetch(url);
            const buffer = await response.arrayBuffer();
            fetchTotal += performance.now() - fetchStart;

            const contentType = response.headers.get('Content-Type') || '';
            const imgWidth = parseInt(response.headers.get('X-Image-Width') || '0');
            const imgHeight = parseInt(response.headers.get('X-Image-Height') || '0');

            if (contentType === 'image/x-rgba-lz4') {
              // LZ4-compressed RGBA data - decompress first
              const decompressStart = performance.now();
              const decompressed = decompressLz4PrependSize(new Uint8Array(buffer));
              decompressTotal += performance.now() - decompressStart;

              if (imgWidth > 0 && imgHeight > 0) {
                const renderStart = performance.now();
                const imageData = new ImageData(
                  new Uint8ClampedArray(decompressed),
                  imgWidth,
                  imgHeight
                );
                layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
                layer.ctx.putImageData(imageData, offsetX, offsetY);
                updateThumbnailForLayer(layerData.id, layer.canvas);
                renderTotal += performance.now() - renderStart;
              }
            } else if (contentType === 'image/x-rgba') {
              // Raw RGBA data (uncompressed) - use ImageData for fast rendering
              if (imgWidth > 0 && imgHeight > 0) {
                const renderStart = performance.now();
                const imageData = new ImageData(new Uint8ClampedArray(buffer), imgWidth, imgHeight);
                layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
                layer.ctx.putImageData(imageData, offsetX, offsetY);
                updateThumbnailForLayer(layerData.id, layer.canvas);
                renderTotal += performance.now() - renderStart;
              }
            } else {
              // Encoded image (PNG/WebP) - use Image element
              const renderStart = performance.now();
              // Create blob from already-fetched buffer (response body was consumed by arrayBuffer())
              const blob = new Blob([buffer], { type: contentType });
              const bitmap = await createImageBitmap(blob);
              layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
              layer.ctx.drawImage(bitmap, offsetX, offsetY);
              updateThumbnailForLayer(layerData.id, layer.canvas);
              renderTotal += performance.now() - renderStart;
            }
          } catch (e) {
            console.warn(`Failed to load layer image: ${layerData.id}`, e);
          }
        }
      }

      // Report benchmark phases to backend if session ID is provided
      if (benchmarkSessionId) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('report_benchmark', {
          sessionId: benchmarkSessionId,
          phase: 'fetch',
          durationMs: fetchTotal,
        });
        await invoke('report_benchmark', {
          sessionId: benchmarkSessionId,
          phase: 'decompress',
          durationMs: decompressTotal,
        });
        await invoke('report_benchmark', {
          sessionId: benchmarkSessionId,
          phase: 'render',
          durationMs: renderTotal,
        });
        // Signal completion to trigger final report
        const report = await invoke<string | null>('report_benchmark', {
          sessionId: benchmarkSessionId,
          phase: 'complete',
          durationMs: 0,
        });
        // Output benchmark report to browser console
        if (report) {
          // console.log(report);
        }
      }

      // Trigger re-render
      compositeAndRender();
    };

    return () => {
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
    };
  }, [
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
  ]);
}
