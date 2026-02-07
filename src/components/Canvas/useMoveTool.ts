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

interface MoveCompositeRenderOptions {
  clipRect?: CanvasRect | null;
  forceCpu?: boolean;
}

interface UseMoveToolParams {
  layerRendererRef: RefObject<LayerRenderer | null>;
  movePreviewCanvasRef?: RefObject<HTMLCanvasElement | null>;
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
  getLayerRevision?: (layerId: string) => number;
}

interface MoveDownEventLike {
  ctrlKey: boolean;
  pointerId: number;
}

interface MovePointerEventLike {
  pointerId: number;
}

type MoveMode = 'full' | 'selection';
type SelectionPreviewMode = 'overlay' | 'legacy';

interface PreservedLayerState {
  sourceCanvas: HTMLCanvasElement;
  offsetX: number;
  offsetY: number;
  revision: number;
}

interface FloatingSelectionSession {
  layerId: string;
  anchorBaseCanvas: HTMLCanvasElement;
  floatingSourceCanvas: HTMLCanvasElement;
  anchorOffsetX: number;
  anchorOffsetY: number;
  floatingOffsetX: number;
  floatingOffsetY: number;
  anchorLayerRevision: number;
  previewProxyCanvas: HTMLCanvasElement | null;
  previewProxyScale: number;
}

interface MoveSession {
  pointerId: number;
  layerId: string;
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  deltaX: number;
  deltaY: number;
  renderedDeltaX: number;
  renderedDeltaY: number;
  moved: boolean;
  ready: boolean;
  cancelled: boolean;
  mode: MoveMode;
  baseOffsetX: number;
  baseOffsetY: number;
  layerCtx: CanvasRenderingContext2D;
  sourceCanvas: HTMLCanvasElement | null;
  selectionBefore?: SelectionSnapshot;
  selectionPreviewMode: SelectionPreviewMode;
  floatingSession: FloatingSelectionSession | null;
}

const PREVIEW_DOWNSAMPLE_THRESHOLD_PIXELS = 8 * 1024 * 1024;
const PREVIEW_PROXY_SCALE = 0.5;

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
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  return { canvas, ctx };
}

function cloneCanvas(
  source: HTMLCanvasElement,
  width: number,
  height: number
): HTMLCanvasElement | null {
  const target = createCanvasWithContext(width, height);
  if (!target) return null;
  target.ctx.clearRect(0, 0, width, height);
  target.ctx.drawImage(source, 0, 0);
  return target.canvas;
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

  const padding = 2;
  const x = Math.max(0, clipRect.left - padding);
  const y = Math.max(0, clipRect.top - padding);
  const w = Math.min(width - x, clipRect.right - clipRect.left + padding * 2);
  const h = Math.min(height - y, clipRect.bottom - clipRect.top + padding * 2);
  if (w <= 0 || h <= 0) return;
  ctx.clearRect(x, y, w, h);
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

function drawScaledCanvasAtOffset(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  offsetX: number,
  offsetY: number,
  drawWidth: number,
  drawHeight: number,
  clipRect: CanvasRect | null
): void {
  if (!clipRect) {
    ctx.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
    return;
  }

  const sourceScaleX = source.width / Math.max(1, drawWidth);
  const sourceScaleY = source.height / Math.max(1, drawHeight);
  const sourceLeft = (clipRect.left - offsetX) * sourceScaleX;
  const sourceTop = (clipRect.top - offsetY) * sourceScaleY;
  const sourceRight = (clipRect.right - offsetX) * sourceScaleX;
  const sourceBottom = (clipRect.bottom - offsetY) * sourceScaleY;

  const sx = Math.max(0, sourceLeft);
  const sy = Math.max(0, sourceTop);
  const ex = Math.min(source.width, sourceRight);
  const ey = Math.min(source.height, sourceBottom);
  const sw = ex - sx;
  const sh = ey - sy;
  if (sw <= 0 || sh <= 0) return;

  const dx = offsetX + sx / sourceScaleX;
  const dy = offsetY + sy / sourceScaleY;
  const dw = sw / sourceScaleX;
  const dh = sh / sourceScaleY;
  if (dw <= 0 || dh <= 0) return;
  ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
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

function buildSelectionSourceParts(args: {
  sourceCanvas: HTMLCanvasElement;
  baseOffsetX: number;
  baseOffsetY: number;
  selectionMask: ImageData;
  width: number;
  height: number;
}): { anchorBaseCanvas: HTMLCanvasElement; floatingSourceCanvas: HTMLCanvasElement } | null {
  const { sourceCanvas, baseOffsetX, baseOffsetY, selectionMask, width, height } = args;
  const mask = createCanvasWithContext(width, height);
  const anchorBase = createCanvasWithContext(sourceCanvas.width, sourceCanvas.height);
  const floatingSource = createCanvasWithContext(sourceCanvas.width, sourceCanvas.height);
  if (!mask || !anchorBase || !floatingSource) return null;

  mask.ctx.putImageData(selectionMask, 0, 0);

  anchorBase.ctx.clearRect(0, 0, anchorBase.canvas.width, anchorBase.canvas.height);
  anchorBase.ctx.drawImage(sourceCanvas, 0, 0);
  anchorBase.ctx.globalCompositeOperation = 'destination-out';
  anchorBase.ctx.drawImage(mask.canvas, -baseOffsetX, -baseOffsetY);
  anchorBase.ctx.globalCompositeOperation = 'source-over';

  floatingSource.ctx.clearRect(0, 0, floatingSource.canvas.width, floatingSource.canvas.height);
  floatingSource.ctx.drawImage(sourceCanvas, 0, 0);
  floatingSource.ctx.globalCompositeOperation = 'destination-in';
  floatingSource.ctx.drawImage(mask.canvas, -baseOffsetX, -baseOffsetY);
  floatingSource.ctx.globalCompositeOperation = 'source-over';

  return {
    anchorBaseCanvas: anchorBase.canvas,
    floatingSourceCanvas: floatingSource.canvas,
  };
}

function buildPreviewProxyCanvas(source: HTMLCanvasElement): {
  proxy: HTMLCanvasElement | null;
  scale: number;
} {
  const pixels = source.width * source.height;
  if (pixels <= PREVIEW_DOWNSAMPLE_THRESHOLD_PIXELS) {
    return { proxy: null, scale: 1 };
  }

  const proxyW = Math.max(1, Math.floor(source.width * PREVIEW_PROXY_SCALE));
  const proxyH = Math.max(1, Math.floor(source.height * PREVIEW_PROXY_SCALE));
  const proxy = createCanvasWithContext(proxyW, proxyH);
  if (!proxy) {
    return { proxy: null, scale: 1 };
  }

  proxy.ctx.clearRect(0, 0, proxyW, proxyH);
  proxy.ctx.imageSmoothingEnabled = true;
  proxy.ctx.imageSmoothingQuality = 'medium';
  proxy.ctx.drawImage(source, 0, 0, proxyW, proxyH);
  return { proxy: proxy.canvas, scale: PREVIEW_PROXY_SCALE };
}

function renderFloatingCompositionToLayer(
  layerCtx: CanvasRenderingContext2D,
  floating: FloatingSelectionSession,
  floatingOffsetX: number,
  floatingOffsetY: number,
  width: number,
  height: number
): void {
  layerCtx.clearRect(0, 0, width, height);
  layerCtx.drawImage(floating.anchorBaseCanvas, floating.anchorOffsetX, floating.anchorOffsetY);
  layerCtx.drawImage(floating.floatingSourceCanvas, floatingOffsetX, floatingOffsetY);
}

export function useMoveTool({
  layerRendererRef,
  movePreviewCanvasRef,
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
  getLayerRevision,
}: UseMoveToolParams) {
  const moveSessionRef = useRef<MoveSession | null>(null);
  const movePreviewRafRef = useRef<number | null>(null);
  const preservedLayerStateRef = useRef<Map<string, PreservedLayerState>>(new Map());
  const floatingSelectionSessionRef = useRef<FloatingSelectionSession | null>(null);

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

  const clearMovePreviewLayer = useCallback(
    (clipRect: CanvasRect | null = null) => {
      const previewCanvas = movePreviewCanvasRef?.current;
      if (!previewCanvas) return;
      const previewCtx = previewCanvas.getContext('2d', { willReadFrequently: true });
      if (!previewCtx) return;
      clearCanvasWithOptionalClip({
        ctx: previewCtx,
        width,
        height,
        clipRect,
      });
    },
    [height, movePreviewCanvasRef, width]
  );

  useEffect(() => {
    return () => {
      clearPreviewRaf();
      clearMovePreviewLayer();
    };
  }, [clearMovePreviewLayer, clearPreviewRaf]);

  useEffect(() => {
    if (currentTool === 'move') return;
    const session = moveSessionRef.current;
    if (!session) return;
    session.cancelled = true;
    moveSessionRef.current = null;
    clearPreviewRaf();
    clearMovePreviewLayer();
  }, [clearMovePreviewLayer, clearPreviewRaf, currentTool]);

  const resolveNextLayerRevision = useCallback(
    (layerId: string): number => {
      if (!getLayerRevision) return 0;
      return getLayerRevision(layerId) + 1;
    },
    [getLayerRevision]
  );

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

  const renderFullLayerMoveLegacy = useCallback(
    (session: MoveSession, deltaX: number, deltaY: number, clipRect: CanvasRect | null): void => {
      if (!session.sourceCanvas) return;
      clearCanvasWithOptionalClip({
        ctx: session.layerCtx,
        width,
        height,
        clipRect,
      });
      drawCanvasAtOffset(session.layerCtx, session.sourceCanvas, deltaX, deltaY, clipRect);
    },
    [height, width]
  );

  const renderSelectionMoveLegacy = useCallback(
    (
      session: MoveSession,
      floating: FloatingSelectionSession,
      floatingOffsetX: number,
      floatingOffsetY: number,
      clipRect: CanvasRect | null
    ): void => {
      clearCanvasWithOptionalClip({
        ctx: session.layerCtx,
        width,
        height,
        clipRect,
      });
      drawCanvasAtOffset(
        session.layerCtx,
        floating.anchorBaseCanvas,
        floating.anchorOffsetX,
        floating.anchorOffsetY,
        clipRect
      );
      drawCanvasAtOffset(
        session.layerCtx,
        floating.floatingSourceCanvas,
        floatingOffsetX,
        floatingOffsetY,
        clipRect
      );
    },
    [height, width]
  );

  const renderSelectionMoveOverlay = useCallback(
    (
      floating: FloatingSelectionSession,
      floatingOffsetX: number,
      floatingOffsetY: number,
      clipRect: CanvasRect | null
    ): void => {
      const previewCanvas = movePreviewCanvasRef?.current;
      if (!previewCanvas) return;
      const previewCtx = previewCanvas.getContext('2d', { willReadFrequently: true });
      if (!previewCtx) return;

      clearCanvasWithOptionalClip({
        ctx: previewCtx,
        width,
        height,
        clipRect,
      });

      const previewSource = floating.previewProxyCanvas ?? floating.floatingSourceCanvas;
      const drawW = floating.floatingSourceCanvas.width;
      const drawH = floating.floatingSourceCanvas.height;
      drawScaledCanvasAtOffset(
        previewCtx,
        previewSource,
        floatingOffsetX,
        floatingOffsetY,
        drawW,
        drawH,
        clipRect
      );
    },
    [height, movePreviewCanvasRef, width]
  );

  const renderFloatingSessionToLayer = useCallback(
    (
      layerId: string,
      floatingOffsetX: number,
      floatingOffsetY: number
    ): { rendered: boolean; floating: FloatingSelectionSession | null } => {
      const floating = floatingSelectionSessionRef.current;
      const renderer = layerRendererRef.current;
      if (!floating || !renderer || floating.layerId !== layerId) {
        return { rendered: false, floating: null };
      }

      const layer = renderer.getLayer(layerId);
      if (!layer) return { rendered: false, floating: null };
      renderFloatingCompositionToLayer(
        layer.ctx,
        floating,
        floatingOffsetX,
        floatingOffsetY,
        width,
        height
      );
      return { rendered: true, floating };
    },
    [height, layerRendererRef, width]
  );

  const finalizeFloatingSelectionSession = useCallback(
    (reason = 'external'): void => {
      void reason;
      const activeMove = moveSessionRef.current;
      let shouldRender = false;

      if (
        activeMove &&
        activeMove.mode === 'selection' &&
        activeMove.ready &&
        activeMove.floatingSession
      ) {
        const floatingOffsetX = activeMove.baseOffsetX + activeMove.deltaX;
        const floatingOffsetY = activeMove.baseOffsetY + activeMove.deltaY;
        const rendered = renderFloatingSessionToLayer(
          activeMove.layerId,
          floatingOffsetX,
          floatingOffsetY
        );
        if (rendered.rendered) {
          rendered.floating!.floatingOffsetX = floatingOffsetX;
          rendered.floating!.floatingOffsetY = floatingOffsetY;
          shouldRender = true;
        }
        useSelectionStore.getState().cancelMove();
      }

      moveSessionRef.current = null;
      clearPreviewRaf();
      clearMovePreviewLayer();
      floatingSelectionSessionRef.current = null;
      if (shouldRender) {
        compositeAndRender({ forceCpu: true });
      }
    },
    [clearMovePreviewLayer, clearPreviewRaf, compositeAndRender, renderFloatingSessionToLayer]
  );

  const hasFloatingSelectionSession = useCallback((): boolean => {
    return !!floatingSelectionSessionRef.current;
  }, []);

  const applyMovePreview = useCallback(
    (session: MoveSession, canvasX: number, canvasY: number, previewOnly: boolean): void => {
      const clipRect = previewOnly ? getPreviewClipRect() : null;
      if (session.mode === 'selection') {
        const floating = session.floatingSession;
        if (!floating) return;

        const moveDeltaX = roundDelta(canvasX - session.startX);
        const moveDeltaY = roundDelta(canvasY - session.startY);
        const nextOffsetX = session.baseOffsetX + moveDeltaX;
        const nextOffsetY = session.baseOffsetY + moveDeltaY;
        if (session.renderedDeltaX === nextOffsetX && session.renderedDeltaY === nextOffsetY) {
          return;
        }

        session.deltaX = moveDeltaX;
        session.deltaY = moveDeltaY;
        session.renderedDeltaX = nextOffsetX;
        session.renderedDeltaY = nextOffsetY;
        applySelectionPreviewPath(moveDeltaX, moveDeltaY);

        if (session.selectionPreviewMode === 'overlay') {
          renderSelectionMoveOverlay(floating, nextOffsetX, nextOffsetY, clipRect);
        } else {
          renderSelectionMoveLegacy(session, floating, nextOffsetX, nextOffsetY, clipRect);
          if (previewOnly) {
            compositeAndRender({ clipRect, forceCpu: true });
          } else {
            compositeAndRender({ forceCpu: true });
          }
        }

        if (moveDeltaX !== 0 || moveDeltaY !== 0) {
          session.moved = true;
        }
        return;
      }

      const nextOffsetX = session.baseOffsetX + roundDelta(canvasX - session.startX);
      const nextOffsetY = session.baseOffsetY + roundDelta(canvasY - session.startY);
      if (session.renderedDeltaX === nextOffsetX && session.renderedDeltaY === nextOffsetY) {
        return;
      }

      session.deltaX = nextOffsetX;
      session.deltaY = nextOffsetY;
      session.renderedDeltaX = nextOffsetX;
      session.renderedDeltaY = nextOffsetY;
      renderFullLayerMoveLegacy(session, nextOffsetX, nextOffsetY, clipRect);

      if (nextOffsetX !== session.baseOffsetX || nextOffsetY !== session.baseOffsetY) {
        session.moved = true;
      }
      markLayerDirty(session.layerId);
      if (previewOnly) {
        compositeAndRender({ clipRect, forceCpu: true });
      } else {
        compositeAndRender({ forceCpu: true });
      }
    },
    [
      applySelectionPreviewPath,
      compositeAndRender,
      getPreviewClipRect,
      markLayerDirty,
      renderFullLayerMoveLegacy,
      renderSelectionMoveLegacy,
      renderSelectionMoveOverlay,
    ]
  );

  const scheduleMovePreview = useCallback(() => {
    if (movePreviewRafRef.current !== null) return;
    movePreviewRafRef.current = requestAnimationFrame(() => {
      movePreviewRafRef.current = null;
      const session = moveSessionRef.current;
      if (!session || !session.ready) return;
      applyMovePreview(session, session.latestX, session.latestY, true);
    });
  }, [applyMovePreview]);

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

      const session: MoveSession = {
        pointerId: event.pointerId,
        layerId: activeLayerId,
        startX: canvasX,
        startY: canvasY,
        latestX: canvasX,
        latestY: canvasY,
        deltaX: 0,
        deltaY: 0,
        renderedDeltaX: Number.NaN,
        renderedDeltaY: Number.NaN,
        moved: false,
        ready: false,
        cancelled: false,
        mode: 'full',
        baseOffsetX: 0,
        baseOffsetY: 0,
        layerCtx: layer.ctx,
        sourceCanvas: null,
        selectionPreviewMode: movePreviewCanvasRef?.current ? 'overlay' : 'legacy',
        floatingSession: null,
      };
      moveSessionRef.current = session;

      void (async () => {
        await syncAllPendingGpuLayersToCpu();
        if (moveSessionRef.current !== session || session.cancelled) return;

        await captureBeforeImage(false);
        if (moveSessionRef.current !== session || session.cancelled) return;

        const selectionStore = useSelectionStore.getState();
        const selectionMask = selectionStore.hasSelection ? selectionStore.selectionMask : null;
        if (selectionMask) {
          let floating = floatingSelectionSessionRef.current;
          const layerRevision = getLayerRevision ? getLayerRevision(activeLayerId) : 0;
          const canReuse =
            !!floating &&
            floating.layerId === activeLayerId &&
            selectionStore.hasSelection &&
            (!getLayerRevision || floating.anchorLayerRevision === layerRevision);

          if (!canReuse) {
            floatingSelectionSessionRef.current = null;
            const preserved = preservedLayerStateRef.current.get(activeLayerId);
            const currentRevision = getLayerRevision ? getLayerRevision(activeLayerId) : null;
            if (preserved && (currentRevision === null || preserved.revision === currentRevision)) {
              session.sourceCanvas = preserved.sourceCanvas;
              session.baseOffsetX = preserved.offsetX;
              session.baseOffsetY = preserved.offsetY;
            } else {
              preservedLayerStateRef.current.delete(activeLayerId);
              session.sourceCanvas = cloneCanvas(layer.canvas, width, height);
            }
            if (!session.sourceCanvas) {
              moveSessionRef.current = null;
              return;
            }

            const parts = buildSelectionSourceParts({
              sourceCanvas: session.sourceCanvas,
              baseOffsetX: session.baseOffsetX,
              baseOffsetY: session.baseOffsetY,
              selectionMask,
              width,
              height,
            });
            if (!parts) {
              moveSessionRef.current = null;
              return;
            }
            const proxy = buildPreviewProxyCanvas(parts.floatingSourceCanvas);
            floating = {
              layerId: activeLayerId,
              anchorBaseCanvas: parts.anchorBaseCanvas,
              floatingSourceCanvas: parts.floatingSourceCanvas,
              anchorOffsetX: session.baseOffsetX,
              anchorOffsetY: session.baseOffsetY,
              floatingOffsetX: session.baseOffsetX,
              floatingOffsetY: session.baseOffsetY,
              anchorLayerRevision: layerRevision,
              previewProxyCanvas: proxy.proxy,
              previewProxyScale: proxy.scale,
            };
            floatingSelectionSessionRef.current = floating;
          }

          session.mode = 'selection';
          session.floatingSession = floating ?? null;
          session.baseOffsetX = floating?.floatingOffsetX ?? 0;
          session.baseOffsetY = floating?.floatingOffsetY ?? 0;
          session.selectionBefore = selectionStore.createSnapshot();
          selectionStore.beginMove({ x: canvasX, y: canvasY, type: 'freehand' });

          if (session.selectionPreviewMode === 'overlay' && floating) {
            renderFloatingCompositionToLayer(
              session.layerCtx,
              floating,
              floating.anchorOffsetX,
              floating.anchorOffsetY,
              width,
              height
            );
            compositeAndRender({ forceCpu: true, clipRect: getPreviewClipRect() });
            renderSelectionMoveOverlay(
              floating,
              floating.floatingOffsetX,
              floating.floatingOffsetY,
              getPreviewClipRect()
            );
          }
        } else {
          const preserved = preservedLayerStateRef.current.get(activeLayerId);
          const currentRevision = getLayerRevision ? getLayerRevision(activeLayerId) : null;
          if (preserved && (currentRevision === null || preserved.revision === currentRevision)) {
            session.sourceCanvas = preserved.sourceCanvas;
            session.baseOffsetX = preserved.offsetX;
            session.baseOffsetY = preserved.offsetY;
          } else {
            preservedLayerStateRef.current.delete(activeLayerId);
            session.sourceCanvas = cloneCanvas(layer.canvas, width, height);
          }
          if (!session.sourceCanvas) {
            moveSessionRef.current = null;
            return;
          }
        }

        session.ready = true;
        scheduleMovePreview();
      })();

      return true;
    },
    [
      activeLayerId,
      captureBeforeImage,
      compositeAndRender,
      getLayerRevision,
      getPreviewClipRect,
      layerRendererRef,
      layers,
      movePreviewCanvasRef,
      pickLayerByPixel,
      renderSelectionMoveOverlay,
      scheduleMovePreview,
      syncAllPendingGpuLayersToCpu,
      width,
      height,
    ]
  );

  const handleMovePointerMove = useCallback(
    (canvasX: number, canvasY: number, event: MovePointerEventLike): boolean => {
      const session = moveSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return false;

      session.latestX = canvasX;
      session.latestY = canvasY;
      if (!session.ready) return true;

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
      session.cancelled = true;
      clearPreviewRaf();

      if (!session.ready) {
        clearMovePreviewLayer();
        return true;
      }

      applyMovePreview(session, canvasX, canvasY, false);

      if (!session.moved) {
        if (session.mode === 'selection') {
          useSelectionStore.getState().cancelMove();
          if (session.floatingSession) {
            renderFloatingCompositionToLayer(
              session.layerCtx,
              session.floatingSession,
              session.floatingSession.floatingOffsetX,
              session.floatingSession.floatingOffsetY,
              width,
              height
            );
          }
          clearMovePreviewLayer();
          compositeAndRender({ forceCpu: true, clipRect: getPreviewClipRect() });
          return true;
        }

        renderFullLayerMoveLegacy(session, session.baseOffsetX, session.baseOffsetY, null);
        markLayerDirty(session.layerId);
        compositeAndRender({ forceCpu: true });
        return true;
      }

      if (session.mode === 'selection' && session.floatingSession) {
        const floating = session.floatingSession;
        const selectionStore = useSelectionStore.getState();
        selectionStore.commitMove(width, height);

        const finalOffsetX = session.baseOffsetX + session.deltaX;
        const finalOffsetY = session.baseOffsetY + session.deltaY;
        renderFloatingCompositionToLayer(
          session.layerCtx,
          floating,
          finalOffsetX,
          finalOffsetY,
          width,
          height
        );
        floating.floatingOffsetX = finalOffsetX;
        floating.floatingOffsetY = finalOffsetY;
        floating.anchorLayerRevision = resolveNextLayerRevision(session.layerId);

        if (session.selectionBefore) {
          const selectionAfter = useSelectionStore.getState().createSnapshot();
          saveStrokeToHistory({
            selectionBefore: session.selectionBefore,
            selectionAfter,
          });
        } else {
          saveStrokeToHistory();
        }
        clearMovePreviewLayer();
        markLayerDirty(session.layerId);
        compositeAndRender({ forceCpu: true });
        updateThumbnail(session.layerId);
        return true;
      }

      if (session.sourceCanvas) {
        preservedLayerStateRef.current.set(session.layerId, {
          sourceCanvas: session.sourceCanvas,
          offsetX: session.deltaX,
          offsetY: session.deltaY,
          revision: resolveNextLayerRevision(session.layerId),
        });
      }
      renderFullLayerMoveLegacy(session, session.deltaX, session.deltaY, null);
      saveStrokeToHistory();
      markLayerDirty(session.layerId);
      compositeAndRender({ forceCpu: true });
      updateThumbnail(session.layerId);
      clearMovePreviewLayer();
      return true;
    },
    [
      applyMovePreview,
      clearMovePreviewLayer,
      clearPreviewRaf,
      compositeAndRender,
      getPreviewClipRect,
      markLayerDirty,
      renderFullLayerMoveLegacy,
      resolveNextLayerRevision,
      saveStrokeToHistory,
      updateThumbnail,
      width,
      height,
    ]
  );

  return {
    handleMovePointerDown,
    handleMovePointerMove,
    handleMovePointerUp,
    finalizeFloatingSelectionSession,
    hasFloatingSelectionSession,
  };
}
