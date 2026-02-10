import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { Layer } from '@/stores/document';
import type { ToolType } from '@/stores/tool';
import { useSelectionStore, type SelectionSnapshot } from '@/stores/selection';
import { LayerRenderer } from '@/utils/layerRenderer';

interface SaveMoveHistoryOptions {
  selectionBefore?: SelectionSnapshot;
  selectionAfter?: SelectionSnapshot;
}

interface CanvasRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface MovePreviewPayload {
  layerId: string;
  canvas: HTMLCanvasElement;
  dirtyRect?: CanvasRect | null;
}

interface MoveCompositeRenderOptions {
  clipRect?: CanvasRect | null;
  forceCpu?: boolean;
  movePreview?: MovePreviewPayload | null;
}

interface UseMoveToolParams {
  layerRendererRef: RefObject<LayerRenderer | null>;
  currentTool: ToolType;
  layers: Layer[];
  activeLayerId: string | null;
  width: number;
  height: number;
  setActiveLayer: (id: string) => void;
  syncAllPendingGpuLayersToCpu: () => Promise<number>;
  captureBeforeImage: (preferGpuHistory?: boolean) => Promise<void>;
  saveStrokeToHistory: (options?: SaveMoveHistoryOptions) => void;
  markLayerDirty: (layerIds?: string | string[]) => void;
  compositeAndRender: (options?: MoveCompositeRenderOptions) => void;
  updateThumbnail: (layerId: string) => void;
  getVisibleCanvasRect?: () => CanvasRect | null;
}

interface MoveDownEventLike {
  ctrlKey: boolean;
  pointerId: number;
}

interface MovePointerEventLike {
  pointerId: number;
}

type MoveMode = 'full' | 'selection';

interface SelectionPreviewData {
  bounds: CanvasRect;
  maskCanvas: HTMLCanvasElement;
  floatingCanvas: HTMLCanvasElement;
}

interface MoveSession {
  pointerId: number;
  layerId: string;
  mode: MoveMode;
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  deltaX: number;
  deltaY: number;
  renderedDeltaX: number;
  renderedDeltaY: number;
  moved: boolean;
  cancelled: boolean;
  sourceCanvas: HTMLCanvasElement;
  layerCtx: CanvasRenderingContext2D;
  previewCanvas: HTMLCanvasElement;
  previewCtx: CanvasRenderingContext2D;
  selectionData: SelectionPreviewData | null;
  selectionBefore?: SelectionSnapshot;
  historyPromise: Promise<void>;
}

// Selection mask rasterization uses a small edge expansion (see selection.ts/pathToMask).
// Keep move preview bounds aligned with that expansion to avoid edge clipping during drag.
const SELECTION_MASK_EDGE_PAD_LEFT = 1;
const SELECTION_MASK_EDGE_PAD_TOP = 1;
const SELECTION_MASK_EDGE_PAD_RIGHT = 2;
const SELECTION_MASK_EDGE_PAD_BOTTOM = 2;
const MOVE_PREVIEW_DIRTY_PAD = 4;

function roundDelta(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value);
}

function createCanvasWithContext(
  width: number,
  height: number
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  } catch {
    ctx = null;
  }
  if (!ctx) return null;
  return { canvas, ctx };
}

function normalizeClipRect(
  rect: CanvasRect | null,
  width: number,
  height: number
): CanvasRect | null {
  if (!rect) return null;
  const left = Math.max(0, Math.floor(rect.left));
  const top = Math.max(0, Math.floor(rect.top));
  const right = Math.min(width, Math.ceil(rect.right));
  const bottom = Math.min(height, Math.ceil(rect.bottom));
  if (left >= right || top >= bottom) return null;
  return { left, top, right, bottom };
}

function intersectRect(a: CanvasRect | null, b: CanvasRect | null): CanvasRect | null {
  if (!a || !b) return null;
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (left >= right || top >= bottom) return null;
  return { left, top, right, bottom };
}

function unionRect(a: CanvasRect | null, b: CanvasRect | null): CanvasRect | null {
  if (!a) return b;
  if (!b) return a;
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

function expandRect(
  rect: CanvasRect | null,
  padding: number,
  width: number,
  height: number
): CanvasRect | null {
  if (!rect) return null;
  return normalizeClipRect(
    {
      left: rect.left - padding,
      top: rect.top - padding,
      right: rect.right + padding,
      bottom: rect.bottom + padding,
    },
    width,
    height
  );
}

function shiftRect(rect: CanvasRect, offsetX: number, offsetY: number): CanvasRect {
  return {
    left: rect.left + offsetX,
    top: rect.top + offsetY,
    right: rect.right + offsetX,
    bottom: rect.bottom + offsetY,
  };
}

function clearCanvasWithOptionalClip(args: {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  clipRect: CanvasRect | null;
}): void {
  const { ctx, width, height, clipRect } = args;
  if (!clipRect) {
    ctx.clearRect(0, 0, width, height);
    return;
  }

  const w = clipRect.right - clipRect.left;
  const h = clipRect.bottom - clipRect.top;
  if (w <= 0 || h <= 0) return;
  ctx.clearRect(clipRect.left, clipRect.top, w, h);
}

function copyCanvasContent(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  clipRect: CanvasRect | null
): void {
  if (!clipRect) {
    ctx.clearRect(0, 0, source.width, source.height);
    ctx.drawImage(source, 0, 0);
    return;
  }

  const sw = clipRect.right - clipRect.left;
  const sh = clipRect.bottom - clipRect.top;
  if (sw <= 0 || sh <= 0) return;
  ctx.clearRect(clipRect.left, clipRect.top, sw, sh);
  ctx.drawImage(source, clipRect.left, clipRect.top, sw, sh, clipRect.left, clipRect.top, sw, sh);
}

function drawCanvasAtOffset(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  offsetX: number,
  offsetY: number,
  clipRect: CanvasRect | null
): void {
  if (!clipRect) {
    ctx.drawImage(source, offsetX, offsetY);
    return;
  }

  const sourceLeft = clipRect.left - offsetX;
  const sourceTop = clipRect.top - offsetY;
  const sourceRight = clipRect.right - offsetX;
  const sourceBottom = clipRect.bottom - offsetY;

  const sx = Math.max(0, sourceLeft);
  const sy = Math.max(0, sourceTop);
  const ex = Math.min(source.width, sourceRight);
  const ey = Math.min(source.height, sourceBottom);
  const sw = ex - sx;
  const sh = ey - sy;
  if (sw <= 0 || sh <= 0) return;

  const dx = sx + offsetX;
  const dy = sy + offsetY;
  ctx.drawImage(source, sx, sy, sw, sh, dx, dy, sw, sh);
}

function calculateBounds(
  paths: Array<Array<{ x: number; y: number }>>
): SelectionSnapshot['bounds'] {
  if (paths.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hasPoint = false;

  for (const contour of paths) {
    for (const point of contour) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
      hasPoint = true;
    }
  }

  if (!hasPoint) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function buildSelectionPreviewData(args: {
  sourceCanvas: HTMLCanvasElement;
  selectionMask: ImageData;
  bounds: SelectionSnapshot['bounds'];
  width: number;
  height: number;
}): SelectionPreviewData | null {
  const { sourceCanvas, selectionMask, bounds, width, height } = args;
  const fallbackBounds: CanvasRect = { left: 0, top: 0, right: width, bottom: height };
  const targetBounds = bounds
    ? normalizeClipRect(
        {
          left: bounds.x - SELECTION_MASK_EDGE_PAD_LEFT,
          top: bounds.y - SELECTION_MASK_EDGE_PAD_TOP,
          right: bounds.x + bounds.width + SELECTION_MASK_EDGE_PAD_RIGHT,
          bottom: bounds.y + bounds.height + SELECTION_MASK_EDGE_PAD_BOTTOM,
        },
        width,
        height
      )
    : fallbackBounds;
  if (!targetBounds) return null;

  const localWidth = Math.max(1, targetBounds.right - targetBounds.left);
  const localHeight = Math.max(1, targetBounds.bottom - targetBounds.top);
  const mask = createCanvasWithContext(localWidth, localHeight);
  const floating = createCanvasWithContext(localWidth, localHeight);
  if (!mask || !floating) return null;

  const localMask = new ImageData(localWidth, localHeight);
  let hasMaskPixel = false;
  for (let y = 0; y < localHeight; y += 1) {
    for (let x = 0; x < localWidth; x += 1) {
      const srcX = targetBounds.left + x;
      const srcY = targetBounds.top + y;
      const srcIdx = (srcY * selectionMask.width + srcX) * 4 + 3;
      const dstIdx = (y * localWidth + x) * 4;
      const alpha = selectionMask.data[srcIdx] ?? 0;
      localMask.data[dstIdx] = 255;
      localMask.data[dstIdx + 1] = 255;
      localMask.data[dstIdx + 2] = 255;
      localMask.data[dstIdx + 3] = alpha;
      if (alpha > 0) {
        hasMaskPixel = true;
      }
    }
  }

  if (!hasMaskPixel) return null;

  mask.ctx.putImageData(localMask, 0, 0);

  floating.ctx.clearRect(0, 0, localWidth, localHeight);
  floating.ctx.drawImage(sourceCanvas, -targetBounds.left, -targetBounds.top);
  floating.ctx.globalCompositeOperation = 'destination-in';
  floating.ctx.drawImage(mask.canvas, 0, 0);
  floating.ctx.globalCompositeOperation = 'source-over';

  return {
    bounds: targetBounds,
    maskCanvas: mask.canvas,
    floatingCanvas: floating.canvas,
  };
}

function renderSelectionPreview(args: {
  ctx: CanvasRenderingContext2D;
  sourceCanvas: HTMLCanvasElement;
  selection: SelectionPreviewData;
  deltaX: number;
  deltaY: number;
  width: number;
  height: number;
  clipRect: CanvasRect | null;
}): void {
  const { ctx, sourceCanvas, selection, deltaX, deltaY, width, height, clipRect } = args;
  clearCanvasWithOptionalClip({ ctx, width, height, clipRect });
  drawCanvasAtOffset(ctx, sourceCanvas, 0, 0, clipRect);

  ctx.globalCompositeOperation = 'destination-out';
  drawCanvasAtOffset(
    ctx,
    selection.maskCanvas,
    selection.bounds.left,
    selection.bounds.top,
    clipRect
  );

  ctx.globalCompositeOperation = 'source-over';
  drawCanvasAtOffset(
    ctx,
    selection.floatingCanvas,
    selection.bounds.left + deltaX,
    selection.bounds.top + deltaY,
    clipRect
  );
}

function commitFullLayerMove(args: {
  layerCtx: CanvasRenderingContext2D;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}): void {
  const { layerCtx, offsetX, offsetY, width, height } = args;
  const snapshot = createCanvasWithContext(width, height);
  if (!snapshot) return;
  snapshot.ctx.drawImage(layerCtx.canvas, 0, 0);
  layerCtx.clearRect(0, 0, width, height);
  layerCtx.drawImage(snapshot.canvas, offsetX, offsetY);
}

function commitSelectionMove(args: {
  layerCtx: CanvasRenderingContext2D;
  selection: SelectionPreviewData;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}): void {
  const { layerCtx, selection, offsetX, offsetY, width, height } = args;
  const snapshot = createCanvasWithContext(width, height);
  if (!snapshot) return;
  snapshot.ctx.drawImage(layerCtx.canvas, 0, 0);

  layerCtx.clearRect(0, 0, width, height);
  layerCtx.drawImage(snapshot.canvas, 0, 0);

  layerCtx.save();
  layerCtx.globalCompositeOperation = 'destination-out';
  layerCtx.drawImage(selection.maskCanvas, selection.bounds.left, selection.bounds.top);
  layerCtx.restore();

  layerCtx.drawImage(
    selection.floatingCanvas,
    selection.bounds.left + offsetX,
    selection.bounds.top + offsetY
  );
}

function computeFullMoveDirtyRect(args: {
  prevOffsetX: number;
  prevOffsetY: number;
  nextOffsetX: number;
  nextOffsetY: number;
  width: number;
  height: number;
  clipRect: CanvasRect | null;
}): CanvasRect | null {
  const { prevOffsetX, prevOffsetY, nextOffsetX, nextOffsetY, width, height, clipRect } = args;
  const canvasRect: CanvasRect = { left: 0, top: 0, right: width, bottom: height };
  const prevRect = intersectRect(
    {
      left: prevOffsetX,
      top: prevOffsetY,
      right: prevOffsetX + width,
      bottom: prevOffsetY + height,
    },
    canvasRect
  );
  const nextRect = intersectRect(
    {
      left: nextOffsetX,
      top: nextOffsetY,
      right: nextOffsetX + width,
      bottom: nextOffsetY + height,
    },
    canvasRect
  );

  const dirty = expandRect(unionRect(prevRect, nextRect), 2, width, height);
  return clipRect ? intersectRect(dirty, clipRect) : dirty;
}

function computeSelectionMoveDirtyRect(args: {
  bounds: CanvasRect;
  prevOffsetX: number;
  prevOffsetY: number;
  nextOffsetX: number;
  nextOffsetY: number;
  width: number;
  height: number;
  clipRect: CanvasRect | null;
}): CanvasRect | null {
  const { bounds, prevOffsetX, prevOffsetY, nextOffsetX, nextOffsetY, width, height, clipRect } =
    args;
  const canvasRect: CanvasRect = { left: 0, top: 0, right: width, bottom: height };
  const prevFloating = intersectRect(shiftRect(bounds, prevOffsetX, prevOffsetY), canvasRect);
  const nextFloating = intersectRect(shiftRect(bounds, nextOffsetX, nextOffsetY), canvasRect);
  const baseRect = intersectRect(bounds, canvasRect);

  const dirty = expandRect(
    unionRect(baseRect, unionRect(prevFloating, nextFloating)),
    MOVE_PREVIEW_DIRTY_PAD,
    width,
    height
  );
  return clipRect ? intersectRect(dirty, clipRect) : dirty;
}

export function useMoveTool({
  layerRendererRef,
  currentTool,
  layers,
  activeLayerId,
  width,
  height,
  setActiveLayer,
  syncAllPendingGpuLayersToCpu,
  captureBeforeImage,
  saveStrokeToHistory,
  markLayerDirty,
  compositeAndRender,
  updateThumbnail,
  getVisibleCanvasRect,
}: UseMoveToolParams) {
  const moveSessionRef = useRef<MoveSession | null>(null);
  const movePreviewRafRef = useRef<number | null>(null);

  const clearPreviewRaf = useCallback(() => {
    if (movePreviewRafRef.current !== null) {
      cancelAnimationFrame(movePreviewRafRef.current);
      movePreviewRafRef.current = null;
    }
  }, []);

  const getPreviewClipRect = useCallback((): CanvasRect | null => {
    if (!getVisibleCanvasRect) return null;
    return normalizeClipRect(getVisibleCanvasRect(), width, height);
  }, [getVisibleCanvasRect, height, width]);

  useEffect(() => {
    return () => {
      clearPreviewRaf();
    };
  }, [clearPreviewRaf]);

  const resetSessionToBase = useCallback(
    (session: MoveSession) => {
      clearCanvasWithOptionalClip({
        ctx: session.previewCtx,
        width,
        height,
        clipRect: null,
      });
      if (session.mode === 'selection') {
        useSelectionStore.getState().cancelMove();
      }
      compositeAndRender();
    },
    [compositeAndRender, height, width]
  );

  useEffect(() => {
    if (currentTool === 'move') return;
    const session = moveSessionRef.current;
    if (!session) return;
    moveSessionRef.current = null;
    session.cancelled = true;
    clearPreviewRaf();
    resetSessionToBase(session);
  }, [clearPreviewRaf, currentTool, resetSessionToBase]);

  const applySelectionPreviewPath = useCallback((deltaX: number, deltaY: number) => {
    const state = useSelectionStore.getState();
    if (!state.isMoving) return;

    const newPath = state.originalPath.map((contour) =>
      contour.map((point) => ({
        ...point,
        x: point.x + deltaX,
        y: point.y + deltaY,
      }))
    );

    useSelectionStore.setState({
      selectionPath: newPath,
      bounds: calculateBounds(newPath),
    });
  }, []);

  const pickLayerByPixel = useCallback(
    async (canvasX: number, canvasY: number): Promise<void> => {
      await syncAllPendingGpuLayersToCpu();
      const renderer = layerRendererRef.current;
      if (!renderer) return;

      const x = Math.floor(canvasX);
      const y = Math.floor(canvasY);
      if (x < 0 || x >= width || y < 0 || y >= height) return;

      for (let i = layers.length - 1; i >= 0; i -= 1) {
        const layerMeta = layers[i];
        if (!layerMeta || !layerMeta.visible || layerMeta.opacity <= 0) continue;
        const layer = renderer.getLayer(layerMeta.id);
        if (!layer) continue;
        const pixel = layer.ctx.getImageData(x, y, 1, 1).data;
        if ((pixel[3] ?? 0) > 0) {
          setActiveLayer(layerMeta.id);
          return;
        }
      }
    },
    [height, layerRendererRef, layers, setActiveLayer, syncAllPendingGpuLayersToCpu, width]
  );

  const applyMovePreview = useCallback(
    (session: MoveSession, canvasX: number, canvasY: number, previewOnly: boolean): void => {
      const nextOffsetX = roundDelta(canvasX - session.startX);
      const nextOffsetY = roundDelta(canvasY - session.startY);
      if (session.renderedDeltaX === nextOffsetX && session.renderedDeltaY === nextOffsetY) {
        return;
      }

      const prevOffsetX = session.deltaX;
      const prevOffsetY = session.deltaY;
      session.deltaX = nextOffsetX;
      session.deltaY = nextOffsetY;
      session.renderedDeltaX = nextOffsetX;
      session.renderedDeltaY = nextOffsetY;
      if (nextOffsetX !== 0 || nextOffsetY !== 0) {
        session.moved = true;
      }

      if (session.mode === 'selection') {
        applySelectionPreviewPath(nextOffsetX, nextOffsetY);
      }

      const visibleClip = previewOnly ? getPreviewClipRect() : null;
      const dirtyRect =
        session.mode === 'selection' && session.selectionData
          ? computeSelectionMoveDirtyRect({
              bounds: session.selectionData.bounds,
              prevOffsetX,
              prevOffsetY,
              nextOffsetX,
              nextOffsetY,
              width,
              height,
              clipRect: visibleClip,
            })
          : computeFullMoveDirtyRect({
              prevOffsetX,
              prevOffsetY,
              nextOffsetX,
              nextOffsetY,
              width,
              height,
              clipRect: visibleClip,
            });

      if (session.mode === 'selection' && session.selectionData) {
        renderSelectionPreview({
          ctx: session.previewCtx,
          sourceCanvas: session.sourceCanvas,
          selection: session.selectionData,
          deltaX: nextOffsetX,
          deltaY: nextOffsetY,
          width,
          height,
          clipRect: dirtyRect,
        });
      } else {
        clearCanvasWithOptionalClip({
          ctx: session.previewCtx,
          width,
          height,
          clipRect: dirtyRect,
        });
        drawCanvasAtOffset(
          session.previewCtx,
          session.sourceCanvas,
          nextOffsetX,
          nextOffsetY,
          dirtyRect
        );
      }

      compositeAndRender({
        clipRect: dirtyRect,
        movePreview: {
          layerId: session.layerId,
          canvas: session.previewCanvas,
          dirtyRect,
        },
      });
    },
    [applySelectionPreviewPath, compositeAndRender, getPreviewClipRect, height, width]
  );

  const scheduleMovePreview = useCallback(() => {
    if (movePreviewRafRef.current !== null) return;
    movePreviewRafRef.current = requestAnimationFrame(() => {
      movePreviewRafRef.current = null;
      const session = moveSessionRef.current;
      if (!session || session.cancelled) return;
      applyMovePreview(session, session.latestX, session.latestY, true);
    });
  }, [applyMovePreview]);

  const finalizeMoveSession = useCallback(
    (session: MoveSession, canvasX: number, canvasY: number) => {
      void (async () => {
        if (session.cancelled) return;

        applyMovePreview(session, canvasX, canvasY, false);

        if (!session.moved) {
          if (session.mode === 'selection') {
            useSelectionStore.getState().cancelMove();
          }
          resetSessionToBase(session);
          session.cancelled = true;
          return;
        }

        await session.historyPromise;

        if (session.mode === 'selection' && session.selectionData) {
          const selectionStore = useSelectionStore.getState();
          selectionStore.commitMove(width, height);
          commitSelectionMove({
            layerCtx: session.layerCtx,
            selection: session.selectionData,
            offsetX: session.deltaX,
            offsetY: session.deltaY,
            width,
            height,
          });

          if (session.selectionBefore) {
            const selectionAfter = useSelectionStore.getState().createSnapshot();
            saveStrokeToHistory({
              selectionBefore: session.selectionBefore,
              selectionAfter,
            });
          } else {
            saveStrokeToHistory();
          }
        } else {
          commitFullLayerMove({
            layerCtx: session.layerCtx,
            offsetX: session.deltaX,
            offsetY: session.deltaY,
            width,
            height,
          });
          saveStrokeToHistory();
        }

        markLayerDirty(session.layerId);
        compositeAndRender();
        updateThumbnail(session.layerId);
        clearCanvasWithOptionalClip({
          ctx: session.previewCtx,
          width,
          height,
          clipRect: null,
        });
        session.cancelled = true;
      })().catch(() => undefined);
    },
    [
      applyMovePreview,
      compositeAndRender,
      height,
      markLayerDirty,
      resetSessionToBase,
      saveStrokeToHistory,
      updateThumbnail,
      width,
    ]
  );

  const handleMovePointerDown = useCallback(
    (canvasX: number, canvasY: number, event: MoveDownEventLike): boolean => {
      if (event.ctrlKey) {
        void pickLayerByPixel(canvasX, canvasY);
        return true;
      }

      if (!activeLayerId) return true;
      const layerMeta = layers.find((layer) => layer.id === activeLayerId);
      if (!layerMeta || !layerMeta.visible || layerMeta.locked) {
        return true;
      }

      const renderer = layerRendererRef.current;
      const layer = renderer?.getLayer(activeLayerId);
      if (!renderer || !layer) return true;

      const preview = createCanvasWithContext(width, height);
      if (!preview) return true;

      const historyPromise = (async () => {
        await syncAllPendingGpuLayersToCpu();
        await captureBeforeImage(false);
      })().catch(() => undefined);

      const session: MoveSession = {
        pointerId: event.pointerId,
        layerId: activeLayerId,
        mode: 'full',
        startX: canvasX,
        startY: canvasY,
        latestX: canvasX,
        latestY: canvasY,
        deltaX: 0,
        deltaY: 0,
        renderedDeltaX: Number.NaN,
        renderedDeltaY: Number.NaN,
        moved: false,
        cancelled: false,
        sourceCanvas: layer.canvas,
        layerCtx: layer.ctx,
        previewCanvas: preview.canvas,
        previewCtx: preview.ctx,
        selectionData: null,
        historyPromise,
      };

      const selectionStore = useSelectionStore.getState();
      const selectionMask = selectionStore.hasSelection ? selectionStore.selectionMask : null;
      if (selectionMask) {
        const selectionData = buildSelectionPreviewData({
          sourceCanvas: layer.canvas,
          selectionMask,
          bounds: selectionStore.bounds,
          width,
          height,
        });
        if (!selectionData) return true;

        session.mode = 'selection';
        session.selectionData = selectionData;
        session.selectionBefore = selectionStore.createSnapshot();
        selectionStore.beginMove({ x: canvasX, y: canvasY, type: 'freehand' });
      }

      moveSessionRef.current = session;
      copyCanvasContent(session.previewCtx, session.sourceCanvas, null);
      return true;
    },
    [
      activeLayerId,
      captureBeforeImage,
      height,
      layerRendererRef,
      layers,
      pickLayerByPixel,
      syncAllPendingGpuLayersToCpu,
      width,
    ]
  );

  const handleMovePointerMove = useCallback(
    (canvasX: number, canvasY: number, event: MovePointerEventLike): boolean => {
      const session = moveSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return false;

      session.latestX = canvasX;
      session.latestY = canvasY;
      if (session.cancelled) return true;

      scheduleMovePreview();
      return true;
    },
    [scheduleMovePreview]
  );

  const handleMovePointerUp = useCallback(
    (canvasX: number, canvasY: number, event: MovePointerEventLike): boolean => {
      const session = moveSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return false;

      moveSessionRef.current = null;
      clearPreviewRaf();
      session.latestX = canvasX;
      session.latestY = canvasY;
      finalizeMoveSession(session, canvasX, canvasY);
      return true;
    },
    [clearPreviewRaf, finalizeMoveSession]
  );

  const finalizeFloatingSelectionSession = useCallback(
    (reason = 'external'): void => {
      void reason;
      const session = moveSessionRef.current;
      if (!session || session.mode !== 'selection') {
        compositeAndRender();
        return;
      }

      moveSessionRef.current = null;
      clearPreviewRaf();
      session.cancelled = true;
      useSelectionStore.getState().cancelMove();
      resetSessionToBase(session);
    },
    [clearPreviewRaf, compositeAndRender, resetSessionToBase]
  );

  const hasFloatingSelectionSession = useCallback((): boolean => {
    const session = moveSessionRef.current;
    return !!session && session.mode === 'selection';
  }, []);

  return {
    handleMovePointerDown,
    handleMovePointerMove,
    handleMovePointerUp,
    finalizeFloatingSelectionSession,
    hasFloatingSelectionSession,
  };
}
