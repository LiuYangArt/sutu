import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { Layer } from '@/stores/document';
import type { ToolType } from '@/stores/tool';
import { useToolStore } from '@/stores/tool';
import { useGradientStore } from '@/stores/gradient';
import { useSelectionStore } from '@/stores/selection';
import { LayerRenderer } from '@/utils/layerRenderer';
import type { Rect } from '@/utils/strokeBuffer';
import {
  isZeroLengthGradient,
  renderGradientToImageData,
  type GradientPoint,
} from '@/utils/gradientRenderer';
import type { ApplyGradientToActiveLayerParams } from './useLayerOperations';

export interface GradientPreviewGuide {
  start: GradientPoint;
  end: GradientPoint;
  showAnchor: boolean;
}

export interface GradientPreviewPayload {
  layerId: string;
  previewLayerCanvas?: HTMLCanvasElement | null;
  guide?: GradientPreviewGuide;
}

interface UseGradientToolParams {
  currentTool: ToolType;
  activeLayerId: string | null;
  layers: Layer[];
  width: number;
  height: number;
  layerRendererRef: RefObject<LayerRenderer | null>;
  applyGradientToActiveLayer: (params: ApplyGradientToActiveLayerParams) => Promise<boolean>;
  applyGpuGradientToActiveLayer?: (
    params: ApplyGradientToActiveLayerParams & { layerId: string; dirtyRect: Rect | null }
  ) => Promise<boolean>;
  useGpuGradientPath?: boolean;
  renderGpuPreview?: (params: {
    layerId: string;
    gradientParams: ApplyGradientToActiveLayerParams;
    dirtyRect: Rect | null;
  }) => void;
  clearGpuPreview?: () => void;
  renderPreview: (payload: GradientPreviewPayload) => void;
  clearPreview: () => void;
}

interface GradientSession {
  layerId: string;
  start: GradientPoint;
  end: GradientPoint;
  dirtyRect: Rect | null;
  useGpuPath: boolean;
  gradientConfig: Omit<ApplyGradientToActiveLayerParams, 'start' | 'end'>;
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

function normalizeRect(rect: Rect, width: number, height: number): Rect | null {
  const left = Math.max(0, Math.floor(rect.left));
  const top = Math.max(0, Math.floor(rect.top));
  const right = Math.min(width, Math.ceil(rect.right));
  const bottom = Math.min(height, Math.ceil(rect.bottom));
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

function resolveGradientDirtyRect(
  width: number,
  height: number,
  selectionState: ReturnType<typeof useSelectionStore.getState>
): Rect | null {
  if (!selectionState.hasSelection) {
    return { left: 0, top: 0, right: width, bottom: height };
  }
  const bounds = selectionState.bounds;
  if (!bounds) {
    return { left: 0, top: 0, right: width, bottom: height };
  }
  return normalizeRect(
    {
      left: bounds.x,
      top: bounds.y,
      right: bounds.x + bounds.width,
      bottom: bounds.y + bounds.height,
    },
    width,
    height
  );
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

function buildGradientConfig(): Omit<ApplyGradientToActiveLayerParams, 'start' | 'end'> {
  const gradientState = useGradientStore.getState();
  const toolState = useToolStore.getState();
  const settings = gradientState.settings;

  return {
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

function buildGuidePreviewPayload(session: GradientSession): GradientPreviewPayload {
  return {
    layerId: session.layerId,
    guide: {
      start: session.start,
      end: session.end,
      showAnchor: true,
    },
  };
}

async function commitGradientWithFallback(args: {
  session: GradientSession;
  params: ApplyGradientToActiveLayerParams;
  applyGradientToActiveLayer: (params: ApplyGradientToActiveLayerParams) => Promise<boolean>;
  applyGpuGradientToActiveLayer?: (
    params: ApplyGradientToActiveLayerParams & { layerId: string; dirtyRect: Rect | null }
  ) => Promise<boolean>;
}): Promise<void> {
  const { session, params, applyGradientToActiveLayer, applyGpuGradientToActiveLayer } = args;
  if (!session.useGpuPath || !applyGpuGradientToActiveLayer) {
    await applyGradientToActiveLayer(params);
    return;
  }

  const applied = await applyGpuGradientToActiveLayer({
    ...params,
    layerId: session.layerId,
    dirtyRect: session.dirtyRect,
  });
  if (!applied) {
    await applyGradientToActiveLayer(params);
  }
}

export function useGradientTool({
  currentTool,
  activeLayerId,
  layers,
  width,
  height,
  layerRendererRef,
  applyGradientToActiveLayer,
  applyGpuGradientToActiveLayer,
  useGpuGradientPath = false,
  renderGpuPreview,
  clearGpuPreview,
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
    clearGpuPreview?.();
    clearPreview();
  }, [cancelScheduledPreview, clearGpuPreview, clearPreview]);

  const renderPreviewFrame = useCallback(() => {
    rafRef.current = null;

    const session = sessionRef.current;
    if (!session) return;

    const guidePayload = buildGuidePreviewPayload(session);

    const selectionState = useSelectionStore.getState();
    if (!canRenderSelectionPreview(selectionState)) {
      renderPreview(guidePayload);
      return;
    }

    if (isZeroLengthGradient(session.start, session.end)) {
      renderPreview(guidePayload);
      return;
    }

    const params: ApplyGradientToActiveLayerParams = {
      ...session.gradientConfig,
      start: session.start,
      end: session.end,
    };
    if (session.useGpuPath && renderGpuPreview) {
      renderGpuPreview({
        layerId: session.layerId,
        gradientParams: params,
        dirtyRect: session.dirtyRect,
      });
      renderPreview(guidePayload);
      return;
    }

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
      ...guidePayload,
      previewLayerCanvas: session.previewCanvas,
    });
  }, [height, renderGpuPreview, renderPreview, width]);

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

      const selectionState = useSelectionStore.getState();
      const start = { x: canvasX, y: canvasY };
      const useGpuPath =
        useGpuGradientPath && !!renderGpuPreview && !!applyGpuGradientToActiveLayer;

      sessionRef.current = {
        layerId: activeLayerId,
        start,
        end: start,
        dirtyRect: resolveGradientDirtyRect(width, height, selectionState),
        useGpuPath,
        gradientConfig: buildGradientConfig(),
        baseImageData,
        previewCanvas: createPreviewCanvas(width, height),
      };

      schedulePreview();
      return true;
    },
    [
      activeLayerId,
      applyGpuGradientToActiveLayer,
      currentTool,
      height,
      layerRendererRef,
      layers,
      renderGpuPreview,
      schedulePreview,
      useGpuGradientPath,
      width,
    ]
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
        clearGpuPreview?.();
        clearPreview();
        return;
      }

      const params: ApplyGradientToActiveLayerParams = {
        ...session.gradientConfig,
        start: session.start,
        end: session.end,
      };
      sessionRef.current = null;
      clearGpuPreview?.();
      clearPreview();
      void commitGradientWithFallback({
        session,
        params,
        applyGradientToActiveLayer,
        applyGpuGradientToActiveLayer,
      });
    },
    [
      applyGpuGradientToActiveLayer,
      applyGradientToActiveLayer,
      cancelScheduledPreview,
      clearGpuPreview,
      clearPreview,
    ]
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
