import { useCallback, useRef, type RefObject } from 'react';
import type { Layer } from '@/stores/document';
import { useSelectionStore, type SelectionSnapshot } from '@/stores/selection';
import { LayerRenderer } from '@/utils/layerRenderer';

interface SaveMoveHistoryOptions {
  selectionBefore?: SelectionSnapshot;
  selectionAfter?: SelectionSnapshot;
}

interface UseMoveToolParams {
  layerRendererRef: RefObject<LayerRenderer | null>;
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
  layerCtx: CanvasRenderingContext2D;
  sourceCanvas: HTMLCanvasElement | null;
  workCanvas: HTMLCanvasElement | null;
  workCtx: CanvasRenderingContext2D | null;
  movedCanvas: HTMLCanvasElement | null;
  movedCtx: CanvasRenderingContext2D | null;
  maskCanvas: HTMLCanvasElement | null;
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
      if (!session.sourceCanvas || !session.maskCanvas) return;
      if (!session.workCanvas || !session.workCtx || !session.movedCanvas || !session.movedCtx)
        return;

      const workCtx = session.workCtx;
      const movedCtx = session.movedCtx;

      workCtx.clearRect(0, 0, width, height);
      workCtx.globalCompositeOperation = 'source-over';
      workCtx.drawImage(session.sourceCanvas, 0, 0);

      workCtx.globalCompositeOperation = 'destination-out';
      workCtx.drawImage(session.maskCanvas, 0, 0);
      workCtx.globalCompositeOperation = 'source-over';

      movedCtx.clearRect(0, 0, width, height);
      movedCtx.globalCompositeOperation = 'source-over';
      movedCtx.drawImage(session.sourceCanvas, deltaX, deltaY);
      movedCtx.globalCompositeOperation = 'destination-in';
      movedCtx.drawImage(session.maskCanvas, deltaX, deltaY);
      movedCtx.globalCompositeOperation = 'source-over';

      workCtx.drawImage(session.movedCanvas, 0, 0);

      session.layerCtx.clearRect(0, 0, width, height);
      session.layerCtx.drawImage(session.workCanvas, 0, 0);
    },
    [width, height]
  );

  const applyMovePreview = useCallback(
    (session: MoveSession, canvasX: number, canvasY: number): void => {
      if (session.mode === 'selection') {
        const selectionStore = useSelectionStore.getState();
        selectionStore.updateMove({ x: canvasX, y: canvasY, type: 'freehand' }, width, height);
        const latest = useSelectionStore.getState();
        const origin = latest.originalBounds;
        const bounds = latest.bounds;
        if (!origin || !bounds) return;

        const deltaX = clampToCanvas(bounds.x - origin.x);
        const deltaY = clampToCanvas(bounds.y - origin.y);
        renderSelectionLayerMove(session, deltaX, deltaY);
        session.deltaX = deltaX;
        session.deltaY = deltaY;
      } else {
        const deltaX = clampToCanvas(canvasX - session.startX);
        const deltaY = clampToCanvas(canvasY - session.startY);
        renderFullLayerMove(session, deltaX, deltaY);
        session.deltaX = deltaX;
        session.deltaY = deltaY;
      }

      if (session.deltaX !== 0 || session.deltaY !== 0) {
        session.moved = true;
      }
      markLayerDirty(session.layerId);
      compositeAndRender();
    },
    [
      compositeAndRender,
      height,
      markLayerDirty,
      renderFullLayerMove,
      renderSelectionLayerMove,
      width,
    ]
  );

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
        layerCtx: layer.ctx,
        sourceCanvas: null,
        workCanvas: null,
        workCtx: null,
        movedCanvas: null,
        movedCtx: null,
        maskCanvas: null,
      };
      moveSessionRef.current = session;

      void (async () => {
        await syncAllPendingGpuLayersToCpu();
        if (moveSessionRef.current !== session || session.cancelled) return;

        await captureBeforeImage(false);
        if (moveSessionRef.current !== session || session.cancelled) return;

        session.sourceCanvas = cloneCanvas(layer.canvas, width, height);
        const work = createCanvasWithContext(width, height);
        if (!session.sourceCanvas || !work) {
          moveSessionRef.current = null;
          return;
        }
        session.workCanvas = work.canvas;
        session.workCtx = work.ctx;

        const selectionStore = useSelectionStore.getState();
        const selectionMask = selectionStore.hasSelection ? selectionStore.selectionMask : null;
        if (selectionMask) {
          const mask = createCanvasWithContext(width, height);
          const moved = createCanvasWithContext(width, height);
          if (!mask || !moved) {
            moveSessionRef.current = null;
            return;
          }
          mask.ctx.putImageData(selectionMask, 0, 0);
          session.maskCanvas = mask.canvas;
          session.movedCanvas = moved.canvas;
          session.movedCtx = moved.ctx;
          session.selectionBefore = selectionStore.createSnapshot();
          session.mode = 'selection';
          selectionStore.beginMove({ x: canvasX, y: canvasY, type: 'freehand' });
        }

        session.ready = true;
        applyMovePreview(session, session.latestX, session.latestY);
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

      applyMovePreview(session, canvasX, canvasY);
      return true;
    },
    [applyMovePreview]
  );

  const handleMovePointerUp = useCallback(
    (canvasX: number, canvasY: number, event: MovePointerEventLike): boolean => {
      const session = moveSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return false;
      moveSessionRef.current = null;
      session.cancelled = true;

      if (!session.ready) {
        return true;
      }

      applyMovePreview(session, canvasX, canvasY);

      if (session.mode === 'selection') {
        const selectionStore = useSelectionStore.getState();
        if (session.moved) {
          selectionStore.commitMove(width, height);
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
        saveStrokeToHistory();
      }

      markLayerDirty(session.layerId);
      compositeAndRender();
      updateThumbnail(session.layerId);
      return true;
    },
    [
      applyMovePreview,
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
