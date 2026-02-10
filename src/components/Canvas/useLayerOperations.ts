import { useCallback, useRef, type RefObject } from 'react';
import { useSelectionStore } from '@/stores/selection';
import type { SelectionPoint, SelectionSnapshot } from '@/stores/selection';
import { useDocumentStore, type Layer, type ResizeCanvasOptions } from '@/stores/document';
import {
  createHistoryEntryId,
  type LayerPropsChange,
  type PushStrokeParams,
  type StrokeSnapshotMode,
  useHistoryStore,
} from '@/stores/history';
import { LayerRenderer } from '@/utils/layerRenderer';
import { renderLayerThumbnail } from '@/utils/layerThumbnail';
import {
  isZeroLengthGradient,
  renderGradientToImageData,
  type GradientPoint,
  type GradientRenderConfig,
} from '@/utils/gradientRenderer';
import { useToastStore } from '@/stores/toast';

interface UseLayerOperationsParams {
  layerRendererRef: RefObject<LayerRenderer | null>;
  activeLayerId: string | null;
  layers: Layer[];
  width: number;
  height: number;
  compositeAndRender: (options?: { forceCpu?: boolean }) => void;
  markLayerDirty: (layerIds?: string | string[]) => void;
  syncGpuLayerForHistory?: (layerId: string) => Promise<boolean>;
  gpuHistoryEnabled?: boolean;
  beginGpuStrokeHistory?: (
    layerId: string
  ) => { entryId: string; snapshotMode: StrokeSnapshotMode } | null;
  applyGpuStrokeHistory?: (
    entryId: string,
    direction: 'undo' | 'redo',
    layerId: string
  ) => Promise<boolean>;
  onBeforeCanvasMutation?: () => void;
}

interface LayerSelectionStateSnapshot {
  activeLayerId: string | null;
  selectedLayerIds: string[];
  layerSelectionAnchorId: string | null;
}

interface RemovedLayerSnapshot {
  layerId: string;
  layerMeta: Layer;
  layerIndex: number;
  imageData: ImageData;
}

type PendingStrokeHistory =
  | {
      layerId: string;
      entryId: string;
      snapshotMode: 'cpu';
      beforeImage: ImageData;
    }
  | {
      layerId: string;
      entryId: string;
      snapshotMode: 'gpu';
    };

interface SaveStrokeHistoryOptions {
  selectionBefore?: SelectionSnapshot;
  selectionAfter?: SelectionSnapshot;
}

export interface ApplyGradientToActiveLayerParams extends GradientRenderConfig {
  start: GradientPoint;
  end: GradientPoint;
}

interface ImportAnchorPoint {
  x: number;
  y: number;
}

interface ImportImageOptions {
  anchorPoint?: ImportAnchorPoint | null;
}

interface PasteImageOptions extends ImportImageOptions {
  clipboardData?: DataTransfer | null;
  allowSystemClipboardRead?: boolean;
}

interface DecodedImageSource {
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup: () => void;
}

function createCanvasContext2D(
  width: number,
  height: number
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return { canvas, ctx };
}

function toPushStrokeParams(pending: PendingStrokeHistory): PushStrokeParams {
  if (pending.snapshotMode === 'gpu') {
    return {
      layerId: pending.layerId,
      entryId: pending.entryId,
      snapshotMode: 'gpu',
    };
  }
  return {
    layerId: pending.layerId,
    entryId: pending.entryId,
    snapshotMode: 'cpu',
    beforeImage: pending.beforeImage,
  };
}

function cloneLayerSelectionState(
  selection: LayerSelectionStateSnapshot
): LayerSelectionStateSnapshot {
  return {
    activeLayerId: selection.activeLayerId,
    selectedLayerIds: [...selection.selectedLayerIds],
    layerSelectionAnchorId: selection.layerSelectionAnchorId,
  };
}

function getDocumentLayerSelectionSnapshot(): LayerSelectionStateSnapshot {
  const docState = useDocumentStore.getState();
  return {
    activeLayerId: docState.activeLayerId,
    selectedLayerIds: [...docState.selectedLayerIds],
    layerSelectionAnchorId: docState.layerSelectionAnchorId,
  };
}

/**
 * Helper to fill a layer using a selection mask (anti-aliased)
 */
function fillWithMask(
  ctx: CanvasRenderingContext2D,
  mask: ImageData,
  color: string,
  width: number,
  height: number
): void {
  const maskLayer = createCanvasContext2D(width, height);
  if (!maskLayer) return;

  // Put the mask data
  maskLayer.ctx.putImageData(mask, 0, 0);

  // Composite fill color IN the mask
  // Source (color) IN Destination (mask) -> Result keeps color where mask is opaque
  maskLayer.ctx.globalCompositeOperation = 'source-in';
  maskLayer.ctx.fillStyle = color;
  maskLayer.ctx.fillRect(0, 0, width, height);

  // Draw the result onto the active layer
  ctx.drawImage(maskLayer.canvas, 0, 0);
}

function pathToMask(paths: SelectionPoint[][], width: number, height: number): ImageData | null {
  if (paths.length === 0) return null;

  const maskLayer = createCanvasContext2D(width, height);
  if (!maskLayer) return null;
  const { ctx } = maskLayer;

  ctx.fillStyle = 'white';
  ctx.beginPath();

  let hasContour = false;
  for (const contour of paths) {
    if (contour.length < 3) continue;
    const first = contour[0];
    if (!first) continue;

    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < contour.length; i += 1) {
      const point = contour[i];
      if (!point) continue;
      ctx.lineTo(point.x, point.y);
    }
    ctx.closePath();
    hasContour = true;
  }

  if (!hasContour) return null;

  ctx.fill('evenodd');
  return ctx.getImageData(0, 0, width, height);
}

function getDuplicateSelectionMask(
  selectionOnly: boolean | undefined,
  width: number,
  height: number
): ImageData | null {
  if (!selectionOnly) return null;

  const selectionState = useSelectionStore.getState();
  if (!selectionState.hasSelection) return null;
  return selectionState.selectionMask ?? pathToMask(selectionState.selectionPath, width, height);
}

function applyLayerDuplicateContent(
  sourceCanvas: HTMLCanvasElement,
  targetCtx: CanvasRenderingContext2D,
  width: number,
  height: number,
  selectionMask: ImageData | null
): void {
  targetCtx.clearRect(0, 0, width, height);

  if (!selectionMask) {
    targetCtx.drawImage(sourceCanvas, 0, 0);
    return;
  }

  const tempLayer = createCanvasContext2D(width, height);
  if (!tempLayer) return;

  tempLayer.ctx.drawImage(sourceCanvas, 0, 0);

  const maskLayer = createCanvasContext2D(width, height);
  if (!maskLayer) return;
  maskLayer.ctx.putImageData(selectionMask, 0, 0);

  tempLayer.ctx.save();
  tempLayer.ctx.globalCompositeOperation = 'destination-in';
  tempLayer.ctx.drawImage(maskLayer.canvas, 0, 0);
  tempLayer.ctx.restore();

  targetCtx.drawImage(tempLayer.canvas, 0, 0);
}

function snapshotLayers(
  renderer: LayerRenderer,
  layers: Array<{ id: string }>
): Array<{ layerId: string; imageData: ImageData }> | null {
  const snapshots: Array<{ layerId: string; imageData: ImageData }> = [];
  for (const layer of layers) {
    const imageData = renderer.getLayerImageData(layer.id);
    if (!imageData) return null;
    snapshots.push({ layerId: layer.id, imageData });
  }
  return snapshots;
}

function clampToCanvasBounds(
  bounds: { x: number; y: number; width: number; height: number },
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number; width: number; height: number } | null {
  const x = Math.max(0, Math.floor(bounds.x));
  const y = Math.max(0, Math.floor(bounds.y));
  const right = Math.min(canvasWidth, Math.ceil(bounds.x + bounds.width));
  const bottom = Math.min(canvasHeight, Math.ceil(bounds.y + bounds.height));
  const width = right - x;
  const height = bottom - y;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function getMaskBounds(
  mask: ImageData
): { x: number; y: number; width: number; height: number } | null {
  const { data, width, height } = mask;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3] ?? 0;
      if (alpha <= 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function getNextPastedLayerName(layers: Layer[]): string {
  let maxIndex = 0;
  for (const layer of layers) {
    const matched = /^Pasted Image (\d+)$/.exec(layer.name);
    if (!matched) continue;
    const value = Number.parseInt(matched[1] ?? '0', 10);
    if (Number.isFinite(value) && value > maxIndex) {
      maxIndex = value;
    }
  }
  return `Pasted Image ${maxIndex + 1}`;
}

function sanitizeLayerName(baseName: string): string {
  const trimmed = baseName.trim();
  return trimmed.length > 0 ? trimmed : 'Layer';
}

function getUniqueLayerName(baseName: string, layers: Layer[]): string {
  const normalizedBase = sanitizeLayerName(baseName);
  const existing = new Set(layers.map((layer) => layer.name));
  if (!existing.has(normalizedBase)) return normalizedBase;

  let nextIndex = 2;
  while (existing.has(`${normalizedBase} ${nextIndex}`)) {
    nextIndex += 1;
  }
  return `${normalizedBase} ${nextIndex}`;
}

function getFileLayerBaseName(fileName: string): string {
  const normalized = fileName.replace(/\.[^/.]+$/, '').trim();
  return normalized.length > 0 ? normalized : 'Image';
}

function isImageFile(file: File): boolean {
  if (file.type.toLowerCase().startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|bmp|gif|tiff?|svg)$/i.test(file.name);
}

function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function getImportedPlacement(
  docWidth: number,
  docHeight: number,
  imageWidth: number,
  imageHeight: number,
  anchorPoint?: ImportAnchorPoint | null
): { x: number; y: number; width: number; height: number } {
  const safeImageWidth = Math.max(1, imageWidth);
  const safeImageHeight = Math.max(1, imageHeight);
  const scale = Math.min(1, docWidth / safeImageWidth, docHeight / safeImageHeight);
  const width = Math.max(1, Math.round(safeImageWidth * scale));
  const height = Math.max(1, Math.round(safeImageHeight * scale));
  const maxX = Math.max(0, docWidth - width);
  const maxY = Math.max(0, docHeight - height);

  let x: number;
  let y: number;
  if (anchorPoint) {
    x = Math.round(anchorPoint.x - width / 2);
    y = Math.round(anchorPoint.y - height / 2);
    x = clampNumber(x, 0, maxX);
    y = clampNumber(y, 0, maxY);
  } else {
    x = Math.round((docWidth - width) / 2);
    y = Math.round((docHeight - height) / 2);
  }

  return { x, y, width, height };
}

function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type);
  });
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function decodeImageBlob(blob: Blob): Promise<DecodedImageSource> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      cleanup: () => bitmap.close(),
    };
  }

  const objectUrl = URL.createObjectURL(blob);
  let revokeOnError = true;
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = objectUrl;
    });
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    revokeOnError = false;
    return {
      source: image,
      width,
      height,
      cleanup: () => URL.revokeObjectURL(objectUrl),
    };
  } finally {
    if (revokeOnError) {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

async function readImageBlobFromClipboard(): Promise<Blob | null> {
  const clipboardApi = (
    navigator as Navigator & {
      clipboard?: {
        read?: () => Promise<Array<{ types: string[]; getType: (type: string) => Promise<Blob> }>>;
      };
    }
  ).clipboard;

  if (!clipboardApi?.read) return null;

  try {
    const items = await clipboardApi.read();
    for (const item of items) {
      for (const type of item.types) {
        if (!type.toLowerCase().startsWith('image/')) continue;
        return item.getType(type);
      }
    }
  } catch {
    return null;
  }

  return null;
}

function readImageBlobFromDataTransfer(dataTransfer?: DataTransfer | null): Blob | null {
  if (!dataTransfer) return null;

  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== 'file' || !item.type.toLowerCase().startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) return file;
  }

  for (const file of Array.from(dataTransfer.files ?? [])) {
    if (isImageFile(file)) return file;
  }

  return null;
}

async function writeImageBlobToClipboard(blob: Blob): Promise<boolean> {
  const clipboardApi = (
    navigator as Navigator & {
      clipboard?: {
        write?: (data: ClipboardItem[]) => Promise<void>;
      };
    }
  ).clipboard;

  if (!clipboardApi?.write || typeof ClipboardItem === 'undefined') {
    return false;
  }

  const mimeType = blob.type && blob.type.length > 0 ? blob.type : 'image/png';
  try {
    await clipboardApi.write([new ClipboardItem({ [mimeType]: blob })]);
    return true;
  } catch {
    return false;
  }
}

export function useLayerOperations({
  layerRendererRef,
  activeLayerId,
  layers,
  width,
  height,
  compositeAndRender,
  markLayerDirty,
  syncGpuLayerForHistory,
  gpuHistoryEnabled = false,
  beginGpuStrokeHistory,
  applyGpuStrokeHistory,
  onBeforeCanvasMutation,
}: UseLayerOperationsParams) {
  const pushToast = useToastStore((s) => s.pushToast);
  const updateLayerThumbnail = useDocumentStore((s) => s.updateLayerThumbnail);
  const setDocumentDirty = useDocumentStore((s) => s.setDirty);
  const {
    pushStroke,
    pushRemoveLayer,
    pushRemoveLayers,
    pushMergeLayers,
    pushLayerProps,
    pushResizeCanvas,
    patchAddLayerImage,
    undo,
    redo,
  } = useHistoryStore();

  // Store beforeImage when stroke starts
  const beforeImageRef = useRef<PendingStrokeHistory | null>(null);
  const copiedImageBlobRef = useRef<Blob | null>(null);

  const pushCpuStrokeHistory = useCallback(
    (layerId: string, beforeImage: ImageData, entryId: string = createHistoryEntryId()) => {
      pushStroke({
        layerId,
        entryId,
        snapshotMode: 'cpu',
        beforeImage,
      });
    },
    [pushStroke]
  );

  // Update layer thumbnail
  const updateThumbnailWithSize = useCallback(
    (layerId: string, docWidth: number, docHeight: number) => {
      if (!layerRendererRef.current) return;
      const layer = layerRendererRef.current.getLayer(layerId);
      if (!layer) return;

      const thumb = renderLayerThumbnail(layer.canvas, docWidth, docHeight);
      if (thumb) updateLayerThumbnail(layerId, thumb);
    },
    [updateLayerThumbnail, layerRendererRef]
  );

  const updateThumbnail = useCallback(
    (layerId: string) => updateThumbnailWithSize(layerId, width, height),
    [width, height, updateThumbnailWithSize]
  );

  // 起笔前保存 beforeImage。
  // no-readback 下必须先同步待刷新的 GPU tiles，否则一次撤销会跨越多笔。
  const captureBeforeImage = useCallback(
    async (preferGpuHistory = true): Promise<void> => {
      const renderer = layerRendererRef.current;
      if (!renderer || !activeLayerId) return;

      const gpuEntry =
        preferGpuHistory && gpuHistoryEnabled && beginGpuStrokeHistory
          ? beginGpuStrokeHistory(activeLayerId)
          : null;
      if (gpuEntry?.snapshotMode === 'gpu') {
        beforeImageRef.current = {
          layerId: activeLayerId,
          entryId: gpuEntry.entryId,
          snapshotMode: 'gpu',
        };
        return;
      }

      await syncGpuLayerForHistory?.(activeLayerId);

      const imageData = renderer.getLayerImageData(activeLayerId);
      if (imageData) {
        beforeImageRef.current = {
          layerId: activeLayerId,
          entryId: gpuEntry?.entryId ?? createHistoryEntryId(),
          snapshotMode: 'cpu',
          beforeImage: imageData,
        };
      }
    },
    [
      activeLayerId,
      beginGpuStrokeHistory,
      gpuHistoryEnabled,
      layerRendererRef,
      syncGpuLayerForHistory,
    ]
  );

  // Push stroke to history using beforeImage
  const saveStrokeToHistory = useCallback(
    (options?: SaveStrokeHistoryOptions) => {
      const pending = beforeImageRef.current;
      if (!pending) return;

      pushStroke({
        ...toPushStrokeParams(pending),
        selectionBefore: options?.selectionBefore,
        selectionAfter: options?.selectionAfter,
      });
      beforeImageRef.current = null;
      setDocumentDirty(true);
    },
    [pushStroke, setDocumentDirty]
  );

  // Resize canvas with history support
  const handleResizeCanvas = useCallback(
    (options: ResizeCanvasOptions) => {
      const renderer = layerRendererRef.current;
      if (!renderer) return;

      const docState = useDocumentStore.getState();
      const beforeWidth = docState.width;
      const beforeHeight = docState.height;

      if (options.width === beforeWidth && options.height === beforeHeight) return;

      const beforeLayers = snapshotLayers(renderer, docState.layers);
      if (!beforeLayers) return;

      onBeforeCanvasMutation?.();
      pushResizeCanvas(beforeWidth, beforeHeight, beforeLayers);
      useSelectionStore.getState().deselectAll();

      renderer.resizeWithOptions(options);
      useDocumentStore.setState({ width: options.width, height: options.height });
      setDocumentDirty(true);

      compositeAndRender();
      markLayerDirty(docState.layers.map((layer) => layer.id));

      for (const layer of docState.layers) {
        updateThumbnailWithSize(layer.id, options.width, options.height);
      }
    },
    [
      compositeAndRender,
      markLayerDirty,
      layerRendererRef,
      pushResizeCanvas,
      updateThumbnailWithSize,
      onBeforeCanvasMutation,
      setDocumentDirty,
    ]
  );

  // Fill active layer with a color (Alt+Backspace shortcut)
  const fillActiveLayer = useCallback(
    (color: string) => {
      if (!activeLayerId) return;
      void (async () => {
        await syncGpuLayerForHistory?.(activeLayerId);

        const renderer = layerRendererRef.current;
        if (!renderer) return;

        // Check if layer is locked
        const layerState = layers.find((l) => l.id === activeLayerId);
        if (!layerState || layerState.locked) return;

        const layer = renderer.getLayer(activeLayerId);
        if (!layer) return;

        onBeforeCanvasMutation?.();

        // Capture before image for undo
        const beforeImage = renderer.getLayerImageData(activeLayerId);
        if (!beforeImage) return;

        // Check for active selection
        const { hasSelection, selectionMask } = useSelectionStore.getState();

        if (hasSelection && selectionMask) {
          fillWithMask(layer.ctx, selectionMask, color, width, height);
        } else if (!hasSelection) {
          // Only fill if NO selection. If hasSelection is true but no mask (shouldn't happen), do nothing safely
          // Fill the entire layer
          layer.ctx.fillStyle = color;
          layer.ctx.fillRect(0, 0, width, height);
        }

        // Save to history
        pushCpuStrokeHistory(activeLayerId, beforeImage);
        setDocumentDirty(true);

        // Update thumbnail and re-render
        markLayerDirty(activeLayerId);
        updateThumbnail(activeLayerId);
        compositeAndRender();
      })();
    },
    [
      activeLayerId,
      layers,
      width,
      height,
      pushCpuStrokeHistory,
      markLayerDirty,
      updateThumbnail,
      compositeAndRender,
      syncGpuLayerForHistory,
      layerRendererRef,
      onBeforeCanvasMutation,
      setDocumentDirty,
    ]
  );

  const applyGradientToActiveLayer = useCallback(
    async (params: ApplyGradientToActiveLayerParams): Promise<boolean> => {
      if (!activeLayerId) return false;
      if (isZeroLengthGradient(params.start, params.end)) return false;

      await syncGpuLayerForHistory?.(activeLayerId);

      const renderer = layerRendererRef.current;
      if (!renderer) return false;

      const layerState = layers.find((layer) => layer.id === activeLayerId);
      if (!layerState || layerState.locked || !layerState.visible) return false;

      const selectionState = useSelectionStore.getState();
      if (selectionState.selectionMaskPending) return false;

      const layer = renderer.getLayer(activeLayerId);
      if (!layer) return false;

      const beforeImage = renderer.getLayerImageData(activeLayerId);
      if (!beforeImage) return false;

      const hasSelection = selectionState.hasSelection;
      const selectionMask = hasSelection ? selectionState.selectionMask : null;
      if (hasSelection && !selectionMask) return false;

      onBeforeCanvasMutation?.();

      const nextImage = renderGradientToImageData({
        ...params,
        width,
        height,
        dstImageData: beforeImage,
        selectionMask,
      });

      renderer.setLayerImageData(activeLayerId, nextImage);

      pushCpuStrokeHistory(activeLayerId, beforeImage);
      setDocumentDirty(true);

      markLayerDirty(activeLayerId);
      updateThumbnail(activeLayerId);
      compositeAndRender();
      return true;
    },
    [
      activeLayerId,
      compositeAndRender,
      height,
      layerRendererRef,
      layers,
      markLayerDirty,
      onBeforeCanvasMutation,
      pushCpuStrokeHistory,
      setDocumentDirty,
      syncGpuLayerForHistory,
      updateThumbnail,
      width,
    ]
  );

  // Clear selection content from active layer
  const handleClearSelection = useCallback(() => {
    if (!activeLayerId) return;
    void (async () => {
      await syncGpuLayerForHistory?.(activeLayerId);

      const renderer = layerRendererRef.current;
      if (!renderer) return;

      // Check if layer is locked
      const layerState = layers.find((l) => l.id === activeLayerId);
      if (!layerState || layerState.locked) return;

      const layer = renderer.getLayer(activeLayerId);
      if (!layer) return;

      onBeforeCanvasMutation?.();

      // Check for active selection
      const { hasSelection, selectionMask } = useSelectionStore.getState();
      if (!hasSelection || !selectionMask) return;

      // Capture before image for undo
      const beforeImage = renderer.getLayerImageData(activeLayerId);
      if (!beforeImage) return;

      // Create temp canvas for the mask
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = width;
      maskCanvas.height = height;
      const maskCtx = maskCanvas.getContext('2d');
      if (!maskCtx) return;

      // Put the mask data
      maskCtx.putImageData(selectionMask, 0, 0);

      // Composite: Destination-Out to erase where mask is defined
      const ctx = layer.ctx;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(maskCanvas, 0, 0);
      ctx.restore();

      // Save to history
      pushCpuStrokeHistory(activeLayerId, beforeImage);
      setDocumentDirty(true);

      // Update thumbnail and re-render
      markLayerDirty(activeLayerId);
      updateThumbnail(activeLayerId);
      compositeAndRender();
    })();
  }, [
    activeLayerId,
    layers,
    width,
    height,
    pushCpuStrokeHistory,
    markLayerDirty,
    updateThumbnail,
    compositeAndRender,
    syncGpuLayerForHistory,
    layerRendererRef,
    onBeforeCanvasMutation,
    setDocumentDirty,
  ]);

  // Handle undo for all operation types
  const handleUndo = useCallback(() => {
    void (async () => {
      let entry = undo();
      while (
        entry &&
        entry.type === 'stroke' &&
        !layers.some((l) => l.id === (entry as { layerId: string }).layerId)
      ) {
        entry = undo();
      }
      if (!entry) return;

      onBeforeCanvasMutation?.();

      if (entry.type === 'selection') {
        entry.after = useSelectionStore.getState().createSnapshot();
        useSelectionStore.getState().applySnapshot(entry.before);
        return;
      }

      const renderer = layerRendererRef.current;
      if (!renderer) return;

      switch (entry.type) {
        case 'stroke': {
          const gpuApplied =
            entry.snapshotMode === 'gpu' &&
            (await applyGpuStrokeHistory?.(entry.entryId, 'undo', entry.layerId));
          if (gpuApplied) {
            if (entry.selectionBefore) {
              entry.selectionAfter = useSelectionStore.getState().createSnapshot();
              useSelectionStore.getState().applySnapshot(entry.selectionBefore);
            }
            compositeAndRender();
            markLayerDirty(entry.layerId);
            updateThumbnail(entry.layerId);
            break;
          }

          await syncGpuLayerForHistory?.(entry.layerId);
          // Save current state (afterImage) for redo before restoring
          const currentImageData = renderer.getLayerImageData(entry.layerId);
          if (currentImageData) {
            entry.afterImage = currentImageData;
          }
          if (!entry.beforeImage) {
            console.warn('[History] Missing CPU beforeImage for undo fallback', {
              layerId: entry.layerId,
              entryId: entry.entryId,
              snapshotMode: entry.snapshotMode,
            });
            break;
          }
          renderer.setLayerImageData(entry.layerId, entry.beforeImage);
          if (entry.selectionBefore) {
            entry.selectionAfter = useSelectionStore.getState().createSnapshot();
            useSelectionStore.getState().applySnapshot(entry.selectionBefore);
          }
          compositeAndRender();
          markLayerDirty(entry.layerId);
          updateThumbnail(entry.layerId);
          break;
        }
        case 'layerProps': {
          const changeMap = new Map(entry.changes.map((change) => [change.layerId, change]));
          useDocumentStore.setState((state) => ({
            layers: state.layers.map((layer) => {
              const change = changeMap.get(layer.id);
              if (!change) return layer;
              return {
                ...layer,
                opacity: change.beforeOpacity,
                blendMode: change.beforeBlendMode,
              };
            }),
            isDirty: true,
          }));
          for (const change of entry.changes) {
            renderer.updateLayer(change.layerId, {
              opacity: change.beforeOpacity,
              blendMode: change.beforeBlendMode,
            });
          }
          compositeAndRender();
          markLayerDirty(entry.changes.map((change) => change.layerId));
          break;
        }
        case 'resizeCanvas': {
          const docState = useDocumentStore.getState();
          const afterWidth = docState.width;
          const afterHeight = docState.height;

          const afterLayers = snapshotLayers(renderer, docState.layers);
          if (!afterLayers) return;

          entry.after = { width: afterWidth, height: afterHeight, layers: afterLayers };

          renderer.resize(entry.beforeWidth, entry.beforeHeight);
          for (const layer of entry.beforeLayers) {
            renderer.setLayerImageData(layer.layerId, layer.imageData);
          }

          useDocumentStore.setState({ width: entry.beforeWidth, height: entry.beforeHeight });
          useSelectionStore.getState().deselectAll();

          compositeAndRender();
          markLayerDirty(docState.layers.map((layer) => layer.id));
          for (const layer of docState.layers) {
            updateThumbnailWithSize(layer.id, entry.beforeWidth, entry.beforeHeight);
          }
          break;
        }
        case 'addLayer': {
          // Undo add = remove the layer
          const { removeLayer } = useDocumentStore.getState();
          renderer.removeLayer(entry.layerId);
          removeLayer(entry.layerId);
          compositeAndRender();
          markLayerDirty(entry.layerId);
          break;
        }
        case 'removeLayer': {
          // Undo remove = restore the layer
          // Insert layer back at original index
          useDocumentStore.setState((state) => {
            const newLayers = [...state.layers];
            newLayers.splice(entry.layerIndex, 0, entry.layerMeta);
            return {
              layers: newLayers,
              activeLayerId: entry.layerId,
              selectedLayerIds: [entry.layerId],
              layerSelectionAnchorId: entry.layerId,
            };
          });
          // Recreate in renderer and restore content
          renderer.createLayer(entry.layerId, {
            visible: entry.layerMeta.visible,
            opacity: entry.layerMeta.opacity,
            blendMode: entry.layerMeta.blendMode,
            isBackground: entry.layerMeta.isBackground,
          });
          renderer.setLayerImageData(entry.layerId, entry.imageData);
          renderer.setLayerOrder(useDocumentStore.getState().layers.map((l) => l.id));
          compositeAndRender();
          markLayerDirty(entry.layerId);
          updateThumbnail(entry.layerId);
          break;
        }
        case 'removeLayers': {
          const restored = [...entry.layers].sort((a, b) => a.layerIndex - b.layerIndex);
          useDocumentStore.setState((state) => {
            const newLayers = [...state.layers];
            for (const layer of restored) {
              newLayers.splice(layer.layerIndex, 0, layer.layerMeta);
            }
            return {
              layers: newLayers,
              activeLayerId: entry.beforeSelection.activeLayerId,
              selectedLayerIds: [...entry.beforeSelection.selectedLayerIds],
              layerSelectionAnchorId: entry.beforeSelection.layerSelectionAnchorId,
            };
          });

          for (const layer of restored) {
            renderer.createLayer(layer.layerId, {
              visible: layer.layerMeta.visible,
              opacity: layer.layerMeta.opacity,
              blendMode: layer.layerMeta.blendMode,
              isBackground: layer.layerMeta.isBackground,
            });
            renderer.setLayerImageData(layer.layerId, layer.imageData);
          }

          renderer.setLayerOrder(useDocumentStore.getState().layers.map((l) => l.id));
          compositeAndRender();
          markLayerDirty(restored.map((layer) => layer.layerId));
          for (const layer of restored) {
            updateThumbnail(layer.layerId);
          }
          break;
        }
        case 'mergeLayers': {
          const restored = [...entry.removedLayers].sort((a, b) => a.layerIndex - b.layerIndex);
          useDocumentStore.setState((state) => {
            const mergedTargetRestored = state.layers.map((layer) =>
              layer.id === entry.targetLayerId ? { ...entry.targetBeforeMeta } : layer
            );
            const newLayers = [...mergedTargetRestored];
            for (const layer of restored) {
              newLayers.splice(layer.layerIndex, 0, layer.layerMeta);
            }
            return {
              layers: newLayers,
              activeLayerId: entry.beforeSelection.activeLayerId,
              selectedLayerIds: [...entry.beforeSelection.selectedLayerIds],
              layerSelectionAnchorId: entry.beforeSelection.layerSelectionAnchorId,
            };
          });

          const targetLayer = renderer.getLayer(entry.targetLayerId);
          if (targetLayer) {
            renderer.updateLayer(entry.targetLayerId, {
              visible: entry.targetBeforeMeta.visible,
              opacity: entry.targetBeforeMeta.opacity,
              blendMode: entry.targetBeforeMeta.blendMode,
              isBackground: entry.targetBeforeMeta.isBackground,
            });
            renderer.setLayerImageData(entry.targetLayerId, entry.targetBeforeImage);
          } else {
            renderer.createLayer(entry.targetLayerId, {
              visible: entry.targetBeforeMeta.visible,
              opacity: entry.targetBeforeMeta.opacity,
              blendMode: entry.targetBeforeMeta.blendMode,
              isBackground: entry.targetBeforeMeta.isBackground,
            });
            renderer.setLayerImageData(entry.targetLayerId, entry.targetBeforeImage);
          }

          for (const layer of restored) {
            renderer.createLayer(layer.layerId, {
              visible: layer.layerMeta.visible,
              opacity: layer.layerMeta.opacity,
              blendMode: layer.layerMeta.blendMode,
              isBackground: layer.layerMeta.isBackground,
            });
            renderer.setLayerImageData(layer.layerId, layer.imageData);
          }

          renderer.setLayerOrder(entry.beforeOrder);
          compositeAndRender();
          markLayerDirty([entry.targetLayerId, ...restored.map((layer) => layer.layerId)]);
          updateThumbnail(entry.targetLayerId);
          for (const layer of restored) {
            updateThumbnail(layer.layerId);
          }
          break;
        }
      }
    })();
  }, [
    undo,
    applyGpuStrokeHistory,
    layers,
    compositeAndRender,
    markLayerDirty,
    syncGpuLayerForHistory,
    updateThumbnail,
    updateThumbnailWithSize,
    layerRendererRef,
    onBeforeCanvasMutation,
  ]);

  // Handle redo for all operation types
  const handleRedo = useCallback(() => {
    void (async () => {
      const entry = redo();
      if (!entry) return;

      onBeforeCanvasMutation?.();

      if (entry.type === 'selection') {
        if (entry.after) {
          useSelectionStore.getState().applySnapshot(entry.after);
        }
        return;
      }

      const renderer = layerRendererRef.current;
      if (!renderer) return;

      switch (entry.type) {
        case 'stroke': {
          const gpuApplied =
            entry.snapshotMode === 'gpu' &&
            (await applyGpuStrokeHistory?.(entry.entryId, 'redo', entry.layerId));
          if (gpuApplied) {
            if (entry.selectionAfter) {
              useSelectionStore.getState().applySnapshot(entry.selectionAfter);
            }
            compositeAndRender();
            markLayerDirty(entry.layerId);
            updateThumbnail(entry.layerId);
            break;
          }

          // Restore afterImage (saved during undo)
          if (entry.afterImage) {
            renderer.setLayerImageData(entry.layerId, entry.afterImage);
          }
          if (entry.selectionAfter) {
            useSelectionStore.getState().applySnapshot(entry.selectionAfter);
          }
          compositeAndRender();
          markLayerDirty(entry.layerId);
          updateThumbnail(entry.layerId);
          break;
        }
        case 'layerProps': {
          const changeMap = new Map(entry.changes.map((change) => [change.layerId, change]));
          useDocumentStore.setState((state) => ({
            layers: state.layers.map((layer) => {
              const change = changeMap.get(layer.id);
              if (!change) return layer;
              return {
                ...layer,
                opacity: change.afterOpacity,
                blendMode: change.afterBlendMode,
              };
            }),
            isDirty: true,
          }));
          for (const change of entry.changes) {
            renderer.updateLayer(change.layerId, {
              opacity: change.afterOpacity,
              blendMode: change.afterBlendMode,
            });
          }
          compositeAndRender();
          markLayerDirty(entry.changes.map((change) => change.layerId));
          break;
        }
        case 'resizeCanvas': {
          if (!entry.after) return;

          renderer.resize(entry.after.width, entry.after.height);
          for (const layer of entry.after.layers) {
            renderer.setLayerImageData(layer.layerId, layer.imageData);
          }

          useDocumentStore.setState({ width: entry.after.width, height: entry.after.height });
          useSelectionStore.getState().deselectAll();

          const docState = useDocumentStore.getState();
          compositeAndRender();
          markLayerDirty(docState.layers.map((layer) => layer.id));
          for (const layer of docState.layers) {
            updateThumbnailWithSize(layer.id, entry.after.width, entry.after.height);
          }
          break;
        }
        case 'addLayer': {
          // Redo add = add the layer back
          useDocumentStore.setState((state) => {
            const newLayers = [...state.layers];
            newLayers.splice(entry.layerIndex, 0, entry.layerMeta);
            return {
              layers: newLayers,
              activeLayerId: entry.layerId,
              selectedLayerIds: [entry.layerId],
              layerSelectionAnchorId: entry.layerId,
            };
          });
          renderer.createLayer(entry.layerId, {
            visible: entry.layerMeta.visible,
            opacity: entry.layerMeta.opacity,
            blendMode: entry.layerMeta.blendMode,
            isBackground: entry.layerMeta.isBackground,
          });
          if (entry.imageData) {
            renderer.setLayerImageData(entry.layerId, entry.imageData);
          }
          renderer.setLayerOrder(useDocumentStore.getState().layers.map((l) => l.id));
          compositeAndRender();
          markLayerDirty(entry.layerId);
          updateThumbnail(entry.layerId);
          break;
        }
        case 'removeLayer': {
          // Redo remove = remove the layer again
          const { removeLayer } = useDocumentStore.getState();
          renderer.removeLayer(entry.layerId);
          removeLayer(entry.layerId);
          compositeAndRender();
          markLayerDirty(entry.layerId);
          break;
        }
        case 'removeLayers': {
          const removeIds = new Set(entry.layers.map((layer) => layer.layerId));
          useDocumentStore.setState((state) => ({
            layers: state.layers.filter((layer) => !removeIds.has(layer.id)),
            activeLayerId: entry.afterSelection.activeLayerId,
            selectedLayerIds: [...entry.afterSelection.selectedLayerIds],
            layerSelectionAnchorId: entry.afterSelection.layerSelectionAnchorId,
          }));
          for (const layer of entry.layers) {
            renderer.removeLayer(layer.layerId);
          }
          renderer.setLayerOrder(useDocumentStore.getState().layers.map((l) => l.id));
          compositeAndRender();
          markLayerDirty(entry.layers.map((layer) => layer.layerId));
          break;
        }
        case 'mergeLayers': {
          const removeIds = new Set(entry.removedLayers.map((layer) => layer.layerId));
          useDocumentStore.setState((state) => {
            const mergedLayers = state.layers
              .filter((layer) => !removeIds.has(layer.id))
              .map((layer) =>
                layer.id === entry.targetLayerId ? { ...entry.targetAfterMeta } : layer
              );
            return {
              layers: mergedLayers,
              activeLayerId: entry.afterSelection.activeLayerId,
              selectedLayerIds: [...entry.afterSelection.selectedLayerIds],
              layerSelectionAnchorId: entry.afterSelection.layerSelectionAnchorId,
            };
          });

          for (const layer of entry.removedLayers) {
            renderer.removeLayer(layer.layerId);
          }
          renderer.updateLayer(entry.targetLayerId, {
            visible: entry.targetAfterMeta.visible,
            opacity: entry.targetAfterMeta.opacity,
            blendMode: entry.targetAfterMeta.blendMode,
            isBackground: entry.targetAfterMeta.isBackground,
          });
          renderer.setLayerImageData(entry.targetLayerId, entry.targetAfterImage);
          renderer.setLayerOrder(entry.afterOrder);
          compositeAndRender();
          markLayerDirty([
            entry.targetLayerId,
            ...entry.removedLayers.map((layer) => layer.layerId),
          ]);
          updateThumbnail(entry.targetLayerId);
          break;
        }
      }
    })();
  }, [
    redo,
    applyGpuStrokeHistory,
    compositeAndRender,
    markLayerDirty,
    updateThumbnail,
    updateThumbnailWithSize,
    layerRendererRef,
    onBeforeCanvasMutation,
  ]);

  // Clear current layer content
  const handleClearLayer = useCallback(() => {
    if (!activeLayerId) return;
    void (async () => {
      const renderer = layerRendererRef.current;
      if (!renderer) return;

      onBeforeCanvasMutation?.();

      // Capture state before clearing for undo
      await captureBeforeImage(false);

      // Clear the layer
      renderer.clearLayer(activeLayerId, useDocumentStore.getState().backgroundFillColor);
      setDocumentDirty(true);
      compositeAndRender();

      // Push to history
      saveStrokeToHistory();
      markLayerDirty(activeLayerId);
      updateThumbnail(activeLayerId);
    })();
  }, [
    activeLayerId,
    captureBeforeImage,
    saveStrokeToHistory,
    compositeAndRender,
    markLayerDirty,
    updateThumbnail,
    layerRendererRef,
    onBeforeCanvasMutation,
    setDocumentDirty,
  ]);

  // Duplicate layer content from source to target
  const handleDuplicateLayer = useCallback(
    (fromId: string, toId: string, options?: { selectionOnly?: boolean }) => {
      onBeforeCanvasMutation?.();

      const tryCopy = (): boolean => {
        const renderer = layerRendererRef.current;
        if (!renderer) return false;

        const sourceLayer = renderer.getLayer(fromId);
        const targetLayer = renderer.getLayer(toId);
        if (!sourceLayer || !targetLayer) return false;

        const selectionMask = getDuplicateSelectionMask(options?.selectionOnly, width, height);

        applyLayerDuplicateContent(
          sourceLayer.canvas,
          targetLayer.ctx,
          width,
          height,
          selectionMask
        );
        setDocumentDirty(true);
        compositeAndRender();
        markLayerDirty(toId);
        updateThumbnail(toId);
        const duplicatedImage = renderer.getLayerImageData(toId);
        if (duplicatedImage) {
          patchAddLayerImage(toId, duplicatedImage);
        }
        return true;
      };

      if (tryCopy()) return;

      // New layer may be created on next render pass; retry once.
      window.requestAnimationFrame(() => {
        void tryCopy();
      });
    },
    [
      compositeAndRender,
      height,
      markLayerDirty,
      updateThumbnail,
      width,
      layerRendererRef,
      onBeforeCanvasMutation,
      patchAddLayerImage,
      setDocumentDirty,
    ]
  );

  const insertImageAsNewLayer = useCallback(
    async (
      source: CanvasImageSource,
      sourceWidth: number,
      sourceHeight: number,
      requestedName: string,
      options?: ImportImageOptions
    ): Promise<string | null> => {
      const docState = useDocumentStore.getState();
      const layerName = getUniqueLayerName(requestedName, docState.layers);

      onBeforeCanvasMutation?.();
      docState.addLayer({ name: layerName, type: 'raster' });

      const newLayerId = useDocumentStore.getState().activeLayerId;
      if (!newLayerId) return null;

      const placement = getImportedPlacement(
        width,
        height,
        sourceWidth,
        sourceHeight,
        options?.anchorPoint ?? null
      );

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const renderer = layerRendererRef.current;
        const targetLayer = renderer?.getLayer(newLayerId);
        if (!renderer || !targetLayer) {
          await nextAnimationFrame();
          continue;
        }

        targetLayer.ctx.clearRect(0, 0, width, height);
        targetLayer.ctx.drawImage(
          source,
          placement.x,
          placement.y,
          placement.width,
          placement.height
        );

        setDocumentDirty(true);
        compositeAndRender();
        markLayerDirty(newLayerId);
        updateThumbnail(newLayerId);

        const imageData = renderer.getLayerImageData(newLayerId);
        if (imageData) {
          patchAddLayerImage(newLayerId, imageData);
        }

        return newLayerId;
      }

      return null;
    },
    [
      compositeAndRender,
      height,
      markLayerDirty,
      onBeforeCanvasMutation,
      patchAddLayerImage,
      setDocumentDirty,
      updateThumbnail,
      width,
      layerRendererRef,
    ]
  );

  const handleCopyActiveLayerImage = useCallback(async (): Promise<void> => {
    const renderer = layerRendererRef.current;
    if (!renderer || !activeLayerId) {
      pushToast('No active layer to copy.', { variant: 'error' });
      return;
    }

    const sourceLayer = renderer.getLayer(activeLayerId);
    if (!sourceLayer) {
      pushToast('No active layer to copy.', { variant: 'error' });
      return;
    }

    let copyCanvas: HTMLCanvasElement | null = null;
    const selectionState = useSelectionStore.getState();
    if (selectionState.hasSelection) {
      if (selectionState.selectionMaskPending) {
        pushToast('Selection is still building. Try again in a moment.', { variant: 'error' });
        return;
      }

      const selectionMask = getDuplicateSelectionMask(true, width, height);
      if (!selectionMask) {
        pushToast('No selected pixels to copy.', { variant: 'error' });
        return;
      }

      const fallbackBounds = getMaskBounds(selectionMask);
      const boundedSelection = clampToCanvasBounds(
        selectionState.bounds ?? fallbackBounds ?? { x: 0, y: 0, width: 0, height: 0 },
        width,
        height
      );
      if (!boundedSelection) {
        pushToast('No selected pixels to copy.', { variant: 'error' });
        return;
      }

      copyCanvas = document.createElement('canvas');
      copyCanvas.width = boundedSelection.width;
      copyCanvas.height = boundedSelection.height;
      const copyCtx = copyCanvas.getContext('2d');
      if (!copyCtx) {
        pushToast('Copy failed: cannot access canvas context.', { variant: 'error' });
        return;
      }

      copyCtx.drawImage(
        sourceLayer.canvas,
        boundedSelection.x,
        boundedSelection.y,
        boundedSelection.width,
        boundedSelection.height,
        0,
        0,
        boundedSelection.width,
        boundedSelection.height
      );

      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = boundedSelection.width;
      maskCanvas.height = boundedSelection.height;
      const maskCtx = maskCanvas.getContext('2d');
      if (!maskCtx) {
        pushToast('Copy failed: cannot access selection mask.', { variant: 'error' });
        return;
      }
      maskCtx.putImageData(selectionMask, -boundedSelection.x, -boundedSelection.y);
      copyCtx.save();
      copyCtx.globalCompositeOperation = 'destination-in';
      copyCtx.drawImage(maskCanvas, 0, 0);
      copyCtx.restore();
    } else {
      copyCanvas = document.createElement('canvas');
      copyCanvas.width = width;
      copyCanvas.height = height;
      const copyCtx = copyCanvas.getContext('2d');
      if (!copyCtx) {
        pushToast('Copy failed: cannot access canvas context.', { variant: 'error' });
        return;
      }
      copyCtx.drawImage(sourceLayer.canvas, 0, 0);
    }

    const blob = await canvasToBlob(copyCanvas, 'image/png');
    if (!blob) {
      pushToast('Copy failed: unable to encode image.', { variant: 'error' });
      return;
    }

    copiedImageBlobRef.current = blob;
    await writeImageBlobToClipboard(blob);
  }, [activeLayerId, height, layerRendererRef, pushToast, width]);

  const handlePasteImageAsNewLayer = useCallback(
    async (options?: PasteImageOptions): Promise<void> => {
      const fromPasteEvent = readImageBlobFromDataTransfer(options?.clipboardData);
      const allowSystemClipboardRead = options?.allowSystemClipboardRead ?? !fromPasteEvent;
      const fromSystemClipboard = allowSystemClipboardRead
        ? await readImageBlobFromClipboard()
        : null;
      const imageBlob = fromPasteEvent ?? fromSystemClipboard ?? copiedImageBlobRef.current;
      if (!imageBlob) {
        pushToast('Clipboard has no image data.', { variant: 'error' });
        return;
      }

      const anchorPoint = options?.anchorPoint ?? null;
      let decoded: DecodedImageSource | null = null;
      try {
        decoded = await decodeImageBlob(imageBlob);
        const layerName = getNextPastedLayerName(useDocumentStore.getState().layers);
        const inserted = await insertImageAsNewLayer(
          decoded.source,
          decoded.width,
          decoded.height,
          layerName,
          { anchorPoint }
        );
        if (!inserted) {
          pushToast('Paste failed: could not create target layer.', { variant: 'error' });
        }
      } catch {
        pushToast('Paste failed: unsupported clipboard image.', { variant: 'error' });
      } finally {
        decoded?.cleanup();
      }
    },
    [insertImageAsNewLayer, pushToast]
  );

  const handleImportImageFiles = useCallback(
    async (files: File[], options?: ImportImageOptions): Promise<void> => {
      if (files.length === 0) return;

      const anchorPoint = options?.anchorPoint ?? null;
      let imported = 0;
      let skipped = 0;

      for (const file of files) {
        if (!isImageFile(file)) {
          skipped += 1;
          continue;
        }

        let decoded: DecodedImageSource | null = null;
        try {
          decoded = await decodeImageBlob(file);
          const layerName = getUniqueLayerName(
            getFileLayerBaseName(file.name),
            useDocumentStore.getState().layers
          );
          const inserted = await insertImageAsNewLayer(
            decoded.source,
            decoded.width,
            decoded.height,
            layerName,
            { anchorPoint }
          );
          if (inserted) {
            imported += 1;
          } else {
            skipped += 1;
          }
        } catch {
          skipped += 1;
        } finally {
          decoded?.cleanup();
        }
      }

      if (imported === 0) {
        pushToast('No image files were imported.', { variant: 'error' });
        return;
      }
      if (skipped > 0) {
        pushToast(`Imported ${imported} image layer(s), skipped ${skipped}.`, { variant: 'info' });
      }
    },
    [insertImageAsNewLayer, pushToast]
  );

  const handleDuplicateActiveLayer = useCallback(() => {
    if (!activeLayerId) return;
    const { duplicateLayer } = useDocumentStore.getState();
    const newLayerId = duplicateLayer(activeLayerId);
    if (!newLayerId) return;

    const { hasSelection } = useSelectionStore.getState();
    handleDuplicateLayer(activeLayerId, newLayerId, { selectionOnly: hasSelection });
  }, [activeLayerId, handleDuplicateLayer]);

  const showProtectedLayerSkipToast = useCallback(
    (lockedSkipped: number, backgroundSkipped: number): void => {
      if (lockedSkipped <= 0 && backgroundSkipped <= 0) return;
      const parts: string[] = [];
      if (lockedSkipped > 0) parts.push(`${lockedSkipped} locked`);
      if (backgroundSkipped > 0) parts.push(`${backgroundSkipped} background`);
      pushToast(`Skipped ${parts.join(' + ')} layer(s).`, { variant: 'info' });
    },
    [pushToast]
  );

  // Remove layer with history support
  const handleRemoveLayer = useCallback(
    (layerId: string) => {
      const renderer = layerRendererRef.current;
      if (!renderer) return;

      const documentLayers = useDocumentStore.getState().layers;

      const layerIndex = documentLayers.findIndex((l) => l.id === layerId);
      if (layerIndex === -1) return;
      const layerState = documentLayers[layerIndex];
      const imageData = renderer.getLayerImageData(layerId);

      if (!layerState || !imageData) return;

      onBeforeCanvasMutation?.();

      // Save to history
      pushRemoveLayer(layerId, layerState, layerIndex, imageData);

      // Remove from renderer and document
      renderer.removeLayer(layerId);
      const { removeLayer } = useDocumentStore.getState();
      removeLayer(layerId);

      compositeAndRender();
      markLayerDirty(layerId);
    },
    [pushRemoveLayer, compositeAndRender, markLayerDirty, layerRendererRef, onBeforeCanvasMutation]
  );

  const handleRemoveLayers = useCallback(
    (
      layerIds: string[],
      options?: {
        allowBackground?: boolean;
      }
    ): number => {
      const renderer = layerRendererRef.current;
      if (!renderer) return 0;

      const allowBackground = options?.allowBackground === true;
      const docState = useDocumentStore.getState();
      const uniqueLayerIds = Array.from(new Set(layerIds));
      const removable: RemovedLayerSnapshot[] = [];
      let lockedSkipped = 0;
      let backgroundSkipped = 0;

      for (const layerId of uniqueLayerIds) {
        const layerIndex = docState.layers.findIndex((layer) => layer.id === layerId);
        if (layerIndex < 0) continue;
        const layerMeta = docState.layers[layerIndex];
        if (!layerMeta) continue;

        if (layerMeta.locked) {
          lockedSkipped += 1;
          continue;
        }
        if (layerMeta.isBackground && !allowBackground) {
          backgroundSkipped += 1;
          continue;
        }

        const imageData = renderer.getLayerImageData(layerId);
        if (!imageData) continue;
        removable.push({ layerId, layerMeta: { ...layerMeta }, layerIndex, imageData });
      }

      if (removable.length === 0) {
        showProtectedLayerSkipToast(lockedSkipped, backgroundSkipped);
        return 0;
      }

      onBeforeCanvasMutation?.();
      const beforeSelection = cloneLayerSelectionState(getDocumentLayerSelectionSnapshot());
      const removableIdSet = new Set(removable.map((item) => item.layerId));

      for (const item of removable) {
        renderer.removeLayer(item.layerId);
      }

      const lowestRemovedIndex = Math.min(...removable.map((item) => item.layerIndex));
      useDocumentStore.setState((state) => {
        const newLayers = state.layers.filter((layer) => !removableIdSet.has(layer.id));
        const fallbackIndex = Math.max(0, Math.min(lowestRemovedIndex, newLayers.length - 1));
        const nextActive =
          state.activeLayerId && !removableIdSet.has(state.activeLayerId)
            ? state.activeLayerId
            : (newLayers[fallbackIndex]?.id ?? null);
        return {
          layers: newLayers,
          activeLayerId: nextActive,
          selectedLayerIds: nextActive ? [nextActive] : [],
          layerSelectionAnchorId: nextActive,
        };
      });

      const afterSelection = cloneLayerSelectionState(getDocumentLayerSelectionSnapshot());
      pushRemoveLayers(removable, beforeSelection, afterSelection);

      setDocumentDirty(true);
      compositeAndRender();
      markLayerDirty(removable.map((item) => item.layerId));
      showProtectedLayerSkipToast(lockedSkipped, backgroundSkipped);

      return removable.length;
    },
    [
      compositeAndRender,
      layerRendererRef,
      markLayerDirty,
      onBeforeCanvasMutation,
      pushRemoveLayers,
      setDocumentDirty,
      showProtectedLayerSkipToast,
    ]
  );

  const handleMergeSelectedLayers = useCallback(
    (
      layerIds: string[],
      options?: {
        allowBackground?: boolean;
      }
    ): number => {
      const renderer = layerRendererRef.current;
      if (!renderer) return 0;

      const allowBackground = options?.allowBackground === true;
      const docState = useDocumentStore.getState();
      const uniqueLayerIds = Array.from(new Set(layerIds));
      const mergeCandidates: Array<{
        id: string;
        index: number;
        meta: Layer;
        imageData: ImageData;
      }> = [];
      let lockedSkipped = 0;
      let backgroundSkipped = 0;

      for (const layerId of uniqueLayerIds) {
        const layerIndex = docState.layers.findIndex((layer) => layer.id === layerId);
        if (layerIndex < 0) continue;
        const layerMeta = docState.layers[layerIndex];
        if (!layerMeta) continue;
        if (layerMeta.locked) {
          lockedSkipped += 1;
          continue;
        }
        if (layerMeta.isBackground && !allowBackground) {
          backgroundSkipped += 1;
          continue;
        }
        const imageData = renderer.getLayerImageData(layerId);
        if (!imageData) continue;
        mergeCandidates.push({
          id: layerId,
          index: layerIndex,
          meta: { ...layerMeta },
          imageData,
        });
      }

      if (mergeCandidates.length < 2) {
        showProtectedLayerSkipToast(lockedSkipped, backgroundSkipped);
        return 0;
      }

      mergeCandidates.sort((a, b) => a.index - b.index);
      const target = mergeCandidates[mergeCandidates.length - 1];
      if (!target) return 0;

      const tempRenderer = new LayerRenderer(width, height);
      const mergeOrder: string[] = [];
      for (const candidate of mergeCandidates) {
        mergeOrder.push(candidate.id);
        tempRenderer.createLayer(candidate.id, {
          visible: true,
          opacity: candidate.meta.opacity,
          blendMode: candidate.meta.blendMode,
          isBackground: false,
        });
        tempRenderer.setLayerImageData(candidate.id, candidate.imageData);
      }
      tempRenderer.setLayerOrder(mergeOrder);
      const mergedCanvas = tempRenderer.composite();

      const targetLayer = renderer.getLayer(target.id);
      if (!targetLayer) return 0;

      const targetBeforeImage = renderer.getLayerImageData(target.id);
      if (!targetBeforeImage) return 0;

      const removedLayers: RemovedLayerSnapshot[] = mergeCandidates
        .slice(0, -1)
        .map((candidate) => ({
          layerId: candidate.id,
          layerMeta: { ...candidate.meta },
          layerIndex: candidate.index,
          imageData: candidate.imageData,
        }));
      const removedIdSet = new Set(removedLayers.map((item) => item.layerId));
      const beforeOrder = docState.layers.map((layer) => layer.id);
      const beforeSelection = cloneLayerSelectionState(getDocumentLayerSelectionSnapshot());

      onBeforeCanvasMutation?.();

      targetLayer.ctx.clearRect(0, 0, width, height);
      targetLayer.ctx.drawImage(mergedCanvas, 0, 0);
      renderer.updateLayer(target.id, { blendMode: 'normal', opacity: 100 });

      for (const removed of removedLayers) {
        renderer.removeLayer(removed.layerId);
      }

      useDocumentStore.setState((state) => {
        const newLayers = state.layers
          .filter((layer) => !removedIdSet.has(layer.id))
          .map((layer) =>
            layer.id === target.id ? { ...layer, blendMode: 'normal', opacity: 100 } : layer
          );
        return {
          layers: newLayers,
          activeLayerId: target.id,
          selectedLayerIds: [target.id],
          layerSelectionAnchorId: target.id,
        };
      });

      const targetAfterMeta = useDocumentStore
        .getState()
        .layers.find((layer) => layer.id === target.id);
      const targetAfterImage = renderer.getLayerImageData(target.id);
      if (!targetAfterMeta || !targetAfterImage) return 0;

      const afterOrder = useDocumentStore.getState().layers.map((layer) => layer.id);
      const afterSelection = cloneLayerSelectionState(getDocumentLayerSelectionSnapshot());
      pushMergeLayers({
        targetLayerId: target.id,
        targetBeforeMeta: target.meta,
        targetAfterMeta: { ...targetAfterMeta },
        targetBeforeImage,
        targetAfterImage,
        removedLayers,
        beforeOrder,
        afterOrder,
        beforeSelection,
        afterSelection,
      });

      renderer.setLayerOrder(afterOrder);
      setDocumentDirty(true);
      compositeAndRender();
      markLayerDirty([target.id, ...removedLayers.map((item) => item.layerId)]);
      updateThumbnail(target.id);
      showProtectedLayerSkipToast(lockedSkipped, backgroundSkipped);

      return mergeCandidates.length;
    },
    [
      compositeAndRender,
      layerRendererRef,
      markLayerDirty,
      onBeforeCanvasMutation,
      pushMergeLayers,
      setDocumentDirty,
      showProtectedLayerSkipToast,
      updateThumbnail,
      width,
      height,
    ]
  );

  const handleMergeAllLayers = useCallback((): number => {
    const docState = useDocumentStore.getState();
    return handleMergeSelectedLayers(
      docState.layers.map((layer) => layer.id),
      { allowBackground: true }
    );
  }, [handleMergeSelectedLayers]);

  const applyLayerProps = useCallback(
    (
      layerIds: string[],
      next: { opacity?: number; blendMode?: Layer['blendMode'] }
    ): LayerPropsChange[] => {
      const uniqueIds = Array.from(new Set(layerIds));
      if (uniqueIds.length === 0) return [];

      const changes: LayerPropsChange[] = [];
      const currentLayers = useDocumentStore.getState().layers;

      for (const layerId of uniqueIds) {
        const layer = currentLayers.find((item) => item.id === layerId);
        if (!layer) continue;
        const nextOpacity =
          next.opacity === undefined ? layer.opacity : clampNumber(next.opacity, 0, 100);
        const nextBlendMode = next.blendMode ?? layer.blendMode;

        if (nextOpacity === layer.opacity && nextBlendMode === layer.blendMode) continue;

        changes.push({
          layerId,
          beforeOpacity: layer.opacity,
          beforeBlendMode: layer.blendMode,
          afterOpacity: nextOpacity,
          afterBlendMode: nextBlendMode,
        });
      }

      if (changes.length === 0) return [];

      onBeforeCanvasMutation?.();

      const changeMap = new Map(changes.map((change) => [change.layerId, change]));
      useDocumentStore.setState((state) => ({
        layers: state.layers.map((layer) => {
          const change = changeMap.get(layer.id);
          if (!change) return layer;
          return {
            ...layer,
            opacity: change.afterOpacity,
            blendMode: change.afterBlendMode,
          };
        }),
        isDirty: true,
      }));

      const renderer = layerRendererRef.current;
      if (renderer) {
        for (const change of changes) {
          renderer.updateLayer(change.layerId, {
            opacity: change.afterOpacity,
            blendMode: change.afterBlendMode,
          });
        }
      }

      pushLayerProps(changes);
      compositeAndRender();
      markLayerDirty(changes.map((change) => change.layerId));
      return changes;
    },
    [compositeAndRender, layerRendererRef, markLayerDirty, onBeforeCanvasMutation, pushLayerProps]
  );

  const handleSetLayerOpacity = useCallback(
    (layerIds: string[], opacity: number): number => {
      return applyLayerProps(layerIds, { opacity }).length;
    },
    [applyLayerProps]
  );

  const handleSetLayerBlendMode = useCallback(
    (layerIds: string[], blendMode: Layer['blendMode']): number => {
      return applyLayerProps(layerIds, { blendMode }).length;
    },
    [applyLayerProps]
  );

  return {
    updateThumbnail,
    captureBeforeImage,
    saveStrokeToHistory,
    fillActiveLayer,
    applyGradientToActiveLayer,
    handleClearSelection,
    handleUndo,
    handleRedo,
    handleClearLayer,
    handleDuplicateLayer,
    handleCopyActiveLayerImage,
    handlePasteImageAsNewLayer,
    handleImportImageFiles,
    handleSetLayerOpacity,
    handleSetLayerBlendMode,
    handleDuplicateActiveLayer,
    handleRemoveLayer,
    handleRemoveLayers,
    handleMergeSelectedLayers,
    handleMergeAllLayers,
    handleResizeCanvas,
  };
}
