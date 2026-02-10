import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { Layer } from '@/stores/document';
import type { ToolType } from '@/stores/tool';
import { useToolStore } from '@/stores/tool';
import { useGradientStore } from '@/stores/gradient';
import { useSelectionStore } from '@/stores/selection';
import { LayerRenderer } from '@/utils/layerRenderer';
import {
  isZeroLengthGradient,
  renderGradientToImageData,
  type GradientPoint,
} from '@/utils/gradientRenderer';
import type { ApplyGradientToActiveLayerParams } from './useLayerOperations';

interface GradientPreviewPayload {
  layerId: string;
  previewLayerCanvas: HTMLCanvasElement;
}

interface UseGradientToolParams {
  currentTool: ToolType;
  activeLayerId: string | null;
  layers: Layer[];
  width: number;
  height: number;
  layerRendererRef: RefObject<LayerRenderer | null>;
  applyGradientToActiveLayer: (params: ApplyGradientToActiveLayerParams) => Promise<boolean>;
  renderPreview: (payload: GradientPreviewPayload) => void;
  clearPreview: () => void;
}

interface GradientSession {
  layerId: string;
  start: GradientPoint;
  end: GradientPoint;
  baseImageData: ImageData;
  previewCanvas: HTMLCanvasElement;
}

function canRenderSelectionPreview(
  selectionState: ReturnType<typeof useSelectionStore.getState>
): boolean {
  if (selectionState.selectionMaskPending) return false;
  if (selectionState.hasSelection && !selectionState.selectionMask) return false;
  return true;
}

function createPreviewCanvas(width: number, height: number): HTMLCanvasElement {
  const previewCanvas = document.createElement('canvas');
  previewCanvas.width = width;
  previewCanvas.height = height;
  return previewCanvas;
}

function constrain45Degree(start: GradientPoint, point: GradientPoint): GradientPoint {
  const dx = point.x - start.x;
  const dy = point.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length <= 1e-6) return point;

  const rawAngle = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const snapped = Math.round(rawAngle / step) * step;
  return {
    x: start.x + Math.cos(snapped) * length,
    y: start.y + Math.sin(snapped) * length,
  };
}

function buildGradientParams(
  start: GradientPoint,
  end: GradientPoint
): ApplyGradientToActiveLayerParams {
  const gradientState = useGradientStore.getState();
  const toolState = useToolStore.getState();
  const settings = gradientState.settings;

  return {
    start,
    end,
    shape: settings.shape,
    colorStops: settings.customGradient.colorStops,
    opacityStops: settings.customGradient.opacityStops,
    blendMode: settings.blendMode,
    opacity: settings.opacity,
    reverse: settings.reverse,
    dither: settings.dither,
    transparency: settings.transparency,
    foregroundColor: toolState.brushColor,
    backgroundColor: toolState.backgroundColor,
  };
}

export function useGradientTool({
  currentTool,
  activeLayerId,
  layers,
  width,
  height,
  layerRendererRef,
  applyGradientToActiveLayer,
  renderPreview,
  clearPreview,
}: UseGradientToolParams): {
  handleGradientPointerDown: (
    canvasX: number,
    canvasY: number,
    event: Pick<PointerEvent, 'button' | 'shiftKey'>
  ) => boolean;
  handleGradientPointerMove: (
    canvasX: number,
    canvasY: number,
    event: Pick<PointerEvent, 'shiftKey'>
  ) => void;
  handleGradientPointerUp: (
    canvasX: number,
    canvasY: number,
    event: Pick<PointerEvent, 'shiftKey'>
  ) => void;
  cancelGradientSession: () => void;
} {
  const sessionRef = useRef<GradientSession | null>(null);
  const rafRef = useRef<number | null>(null);

  const cancelScheduledPreview = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const stopSession = useCallback(() => {
    cancelScheduledPreview();
    sessionRef.current = null;
    clearPreview();
  }, [cancelScheduledPreview, clearPreview]);

  const renderPreviewFrame = useCallback(() => {
    rafRef.current = null;

    const session = sessionRef.current;
    if (!session) return;

    const selectionState = useSelectionStore.getState();
    if (!canRenderSelectionPreview(selectionState)) {
      clearPreview();
      return;
    }

    const params = buildGradientParams(session.start, session.end);
    const previewImage = renderGradientToImageData({
      ...params,
      width,
      height,
      dstImageData: session.baseImageData,
      selectionMask: selectionState.hasSelection ? selectionState.selectionMask : null,
    });

    const previewCtx = session.previewCanvas.getContext('2d');
    if (!previewCtx) return;
    previewCtx.putImageData(previewImage, 0, 0);

    renderPreview({
      layerId: session.layerId,
      previewLayerCanvas: session.previewCanvas,
    });
  }, [clearPreview, height, renderPreview, width]);

  const schedulePreview = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(renderPreviewFrame);
  }, [renderPreviewFrame]);

  const updateSessionEnd = useCallback(
    (x: number, y: number, shiftKey: boolean): void => {
      const session = sessionRef.current;
      if (!session) return;

      const nextPoint = shiftKey ? constrain45Degree(session.start, { x, y }) : { x, y };
      session.end = nextPoint;
      schedulePreview();
    },
    [schedulePreview]
  );

  const handleGradientPointerDown = useCallback(
    (
      canvasX: number,
      canvasY: number,
      event: Pick<PointerEvent, 'button' | 'shiftKey'>
    ): boolean => {
      if (currentTool !== 'gradient') return false;
      if (event.button !== 0) return false;
      if (!activeLayerId) return false;

      const layerState = layers.find((item) => item.id === activeLayerId);
      if (!layerState || layerState.locked || !layerState.visible) return false;

      const renderer = layerRendererRef.current;
      if (!renderer) return false;

      const baseImageData = renderer.getLayerImageData(activeLayerId);
      if (!baseImageData) return false;

      const start = { x: canvasX, y: canvasY };

      sessionRef.current = {
        layerId: activeLayerId,
        start,
        end: start,
        baseImageData,
        previewCanvas: createPreviewCanvas(width, height),
      };

      schedulePreview();
      return true;
    },
    [activeLayerId, currentTool, height, layerRendererRef, layers, schedulePreview, width]
  );

  const handleGradientPointerMove = useCallback(
    (canvasX: number, canvasY: number, event: Pick<PointerEvent, 'shiftKey'>): void => {
      if (!sessionRef.current) return;
      updateSessionEnd(canvasX, canvasY, event.shiftKey);
    },
    [updateSessionEnd]
  );

  const handleGradientPointerUp = useCallback(
    (canvasX: number, canvasY: number, event: Pick<PointerEvent, 'shiftKey'>): void => {
      const session = sessionRef.current;
      if (!session) return;

      session.end = event.shiftKey
        ? constrain45Degree(session.start, { x: canvasX, y: canvasY })
        : { x: canvasX, y: canvasY };
      cancelScheduledPreview();

      if (isZeroLengthGradient(session.start, session.end)) {
        sessionRef.current = null;
        clearPreview();
        return;
      }

      const params = buildGradientParams(session.start, session.end);
      sessionRef.current = null;
      clearPreview();
      void applyGradientToActiveLayer(params);
    },
    [applyGradientToActiveLayer, cancelScheduledPreview, clearPreview]
  );

  useEffect(() => {
    if (currentTool === 'gradient') return;
    stopSession();
  }, [currentTool, stopSession]);

  useEffect(() => {
    if (!sessionRef.current) return;
    if (!activeLayerId || sessionRef.current.layerId !== activeLayerId) {
      stopSession();
    }
  }, [activeLayerId, stopSession]);

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, [stopSession]);

  return {
    handleGradientPointerDown,
    handleGradientPointerMove,
    handleGradientPointerUp,
    cancelGradientSession: stopSession,
  };
}
