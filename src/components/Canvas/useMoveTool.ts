import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { Layer } from '@/stores/document';
import type { ToolType } from '@/stores/tool';
import { useSelectionStore, type SelectionSnapshot } from '@/stores/selection';
import { LayerRenderer } from '@/utils/layerRenderer';

interface SaveMoveHistoryOptions {
  selectionBefore?: SelectionSnapshot;
  selectionAfter?: SelectionSnapshot;
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
  compositeAndRender: () => void;
  updateThumbnail: (layerId: string) => void;
}

interface MoveDownEventLike {
  ctrlKey: boolean;
  pointerId: number;
}

interface MovePointerEventLike {
  pointerId: number;
}

type MoveMode = 'full' | 'selection';

interface MoveSession {
  pointerId: number;
  layerId: string;
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  deltaX: number;
  deltaY: number;
  moved: boolean;
  ready: boolean;
  cancelled: boolean;
  mode: MoveMode;
  baseOffsetX: number;
  baseOffsetY: number;
  layerCtx: CanvasRenderingContext2D;
  sourceCanvas: HTMLCanvasElement | null;
  selectionBaseCanvas: HTMLCanvasElement | null;
  selectionCutoutCanvas: HTMLCanvasElement | null;
  selectionBefore?: SelectionSnapshot;
}

function clampToCanvas(value: number): number {
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
}: UseMoveToolParams) {
  const moveSessionRef = useRef<MoveSession | null>(null);
  const movePreviewRafRef = useRef<number | null>(null);
  const preservedLayerOffsetRef = useRef<
    Map<string, { sourceCanvas: HTMLCanvasElement; offsetX: number; offsetY: number }>
  >(new Map());

  const clearPreviewRaf = useCallback(() => {
    if (movePreviewRafRef.current !== null) {
      cancelAnimationFrame(movePreviewRafRef.current);
      movePreviewRafRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (currentTool !== 'move') {
      preservedLayerOffsetRef.current.clear();
    }
  }, [currentTool]);

  useEffect(() => {
    return () => {
      clearPreviewRaf();
    };
  }, [clearPreviewRaf]);

  const restoreLayerFromSource = useCallback(
    (session: MoveSession): void => {
      if (!session.sourceCanvas) return;
      session.layerCtx.clearRect(0, 0, width, height);
      session.layerCtx.drawImage(session.sourceCanvas, 0, 0);
    },
    [width, height]
  );

  const renderFullLayerMove = useCallback(
    (session: MoveSession, deltaX: number, deltaY: number): void => {
      if (!session.sourceCanvas) return;
      session.layerCtx.clearRect(0, 0, width, height);
      session.layerCtx.drawImage(session.sourceCanvas, deltaX, deltaY);
    },
    [width, height]
  );

  const renderSelectionLayerMove = useCallback(
    (session: MoveSession, deltaX: number, deltaY: number): void => {
      if (!session.selectionBaseCanvas || !session.selectionCutoutCanvas) return;
      session.layerCtx.clearRect(0, 0, width, height);
      session.layerCtx.drawImage(session.selectionBaseCanvas, 0, 0);
      session.layerCtx.drawImage(session.selectionCutoutCanvas, deltaX, deltaY);
    },
    [width, height]
  );

  const calculateBounds = useCallback((paths: Array<Array<{ x: number; y: number }>>) => {
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
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }, []);

  const applySelectionPreviewPath = useCallback(
    (deltaX: number, deltaY: number) => {
      const state = useSelectionStore.getState();
      if (!state.isMoving || !state.originalPath) return;
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
    },
    [calculateBounds]
  );

  const applyMovePreview = useCallback(
    (session: MoveSession, canvasX: number, canvasY: number): void => {
      if (session.mode === 'selection') {
        const deltaX = clampToCanvas(canvasX - session.startX);
        const deltaY = clampToCanvas(canvasY - session.startY);
        applySelectionPreviewPath(deltaX, deltaY);
        renderSelectionLayerMove(session, deltaX, deltaY);
        session.deltaX = deltaX;
        session.deltaY = deltaY;
      } else {
        const deltaX = session.baseOffsetX + clampToCanvas(canvasX - session.startX);
        const deltaY = session.baseOffsetY + clampToCanvas(canvasY - session.startY);
        renderFullLayerMove(session, deltaX, deltaY);
        session.deltaX = deltaX;
        session.deltaY = deltaY;
      }

      const movedFromBase =
        session.mode === 'selection'
          ? session.deltaX !== 0 || session.deltaY !== 0
          : session.deltaX !== session.baseOffsetX || session.deltaY !== session.baseOffsetY;
      if (movedFromBase) {
        session.moved = true;
      }
      markLayerDirty(session.layerId);
      compositeAndRender();
    },
    [
      applySelectionPreviewPath,
      compositeAndRender,
      markLayerDirty,
      renderFullLayerMove,
      renderSelectionLayerMove,
    ]
  );

  const scheduleMovePreview = useCallback(() => {
    if (movePreviewRafRef.current !== null) return;
    movePreviewRafRef.current = requestAnimationFrame(() => {
      movePreviewRafRef.current = null;
      const session = moveSessionRef.current;
      if (!session || !session.ready) return;
      applyMovePreview(session, session.latestX, session.latestY);
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
        moved: false,
        ready: false,
        cancelled: false,
        mode: 'full',
        baseOffsetX: 0,
        baseOffsetY: 0,
        layerCtx: layer.ctx,
        sourceCanvas: null,
        selectionBaseCanvas: null,
        selectionCutoutCanvas: null,
      };
      moveSessionRef.current = session;

      void (async () => {
        await syncAllPendingGpuLayersToCpu();
        if (moveSessionRef.current !== session || session.cancelled) return;

        await captureBeforeImage(false);
        if (moveSessionRef.current !== session || session.cancelled) return;

        const preserved = preservedLayerOffsetRef.current.get(activeLayerId);
        if (preserved) {
          session.sourceCanvas = preserved.sourceCanvas;
          session.baseOffsetX = preserved.offsetX;
          session.baseOffsetY = preserved.offsetY;
        } else {
          session.sourceCanvas = cloneCanvas(layer.canvas, width, height);
        }
        if (!session.sourceCanvas) {
          moveSessionRef.current = null;
          return;
        }

        const selectionStore = useSelectionStore.getState();
        const selectionMask = selectionStore.hasSelection ? selectionStore.selectionMask : null;
        if (selectionMask) {
          const mask = createCanvasWithContext(width, height);
          const selectionBase = createCanvasWithContext(width, height);
          const selectionCutout = createCanvasWithContext(width, height);
          if (!mask || !selectionBase || !selectionCutout) {
            moveSessionRef.current = null;
            return;
          }
          mask.ctx.putImageData(selectionMask, 0, 0);
          session.selectionBaseCanvas = selectionBase.canvas;
          session.selectionCutoutCanvas = selectionCutout.canvas;
          selectionBase.ctx.clearRect(0, 0, width, height);
          selectionBase.ctx.drawImage(
            session.sourceCanvas,
            session.baseOffsetX,
            session.baseOffsetY
          );
          selectionBase.ctx.globalCompositeOperation = 'destination-out';
          selectionBase.ctx.drawImage(mask.canvas, 0, 0);
          selectionBase.ctx.globalCompositeOperation = 'source-over';

          selectionCutout.ctx.clearRect(0, 0, width, height);
          selectionCutout.ctx.drawImage(
            session.sourceCanvas,
            session.baseOffsetX,
            session.baseOffsetY
          );
          selectionCutout.ctx.globalCompositeOperation = 'destination-in';
          selectionCutout.ctx.drawImage(mask.canvas, 0, 0);
          selectionCutout.ctx.globalCompositeOperation = 'source-over';
          session.selectionBefore = selectionStore.createSnapshot();
          session.mode = 'selection';
          selectionStore.beginMove({ x: canvasX, y: canvasY, type: 'freehand' });
        }

        session.ready = true;
        scheduleMovePreview();
      })();

      return true;
    },
    [
      activeLayerId,
      applyMovePreview,
      captureBeforeImage,
      layerRendererRef,
      layers,
      pickLayerByPixel,
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
        return true;
      }

      applyMovePreview(session, canvasX, canvasY);

      if (session.mode === 'selection') {
        const selectionStore = useSelectionStore.getState();
        if (session.moved) {
          selectionStore.commitMove(width, height);
          preservedLayerOffsetRef.current.delete(session.layerId);
        } else {
          selectionStore.cancelMove();
        }
      }

      if (!session.moved) {
        restoreLayerFromSource(session);
        markLayerDirty(session.layerId);
        compositeAndRender();
        return true;
      }

      if (session.mode === 'selection' && session.selectionBefore) {
        const selectionAfter = useSelectionStore.getState().createSnapshot();
        saveStrokeToHistory({
          selectionBefore: session.selectionBefore,
          selectionAfter,
        });
      } else {
        if (session.sourceCanvas) {
          preservedLayerOffsetRef.current.set(session.layerId, {
            sourceCanvas: session.sourceCanvas,
            offsetX: session.deltaX,
            offsetY: session.deltaY,
          });
        }
        saveStrokeToHistory();
      }

      markLayerDirty(session.layerId);
      compositeAndRender();
      updateThumbnail(session.layerId);
      return true;
    },
    [
      applyMovePreview,
      clearPreviewRaf,
      compositeAndRender,
      height,
      markLayerDirty,
      restoreLayerFromSource,
      saveStrokeToHistory,
      updateThumbnail,
      width,
    ]
  );

  return {
    handleMovePointerDown,
    handleMovePointerMove,
    handleMovePointerUp,
  };
}
