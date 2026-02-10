export interface CompositeClipRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CompositeMovePreviewPayload {
  layerId: string;
  canvas: HTMLCanvasElement;
  dirtyRect?: CompositeClipRect | null;
}

export interface PendingMovePreviewRestore {
  layerId: string;
  dirtyRect: CompositeClipRect | null;
}

export interface TileCoord {
  x: number;
  y: number;
}

interface GpuMovePreviewSyncRenderer {
  syncLayerTilesFromCanvas: (
    layerId: string,
    canvas: HTMLCanvasElement,
    tiles: TileCoord[]
  ) => void;
  syncLayerFromCanvas: (layerId: string, canvas: HTMLCanvasElement, revision: number) => void;
}

interface RunGpuMovePreviewFrameOptions<TLayer extends { id: string; revision: number }> {
  gpuRenderer: GpuMovePreviewSyncRenderer;
  visibleLayers: TLayer[];
  movePreview: CompositeMovePreviewPayload | null;
  pendingRestore: PendingMovePreviewRestore | null;
  getLayerCanvas: (layerId: string) => HTMLCanvasElement | null;
  width: number;
  height: number;
  tileSize: number;
  onRender: (layers: TLayer[]) => void;
}

export function normalizeCompositeClipRect(
  rect: CompositeClipRect | null | undefined,
  width: number,
  height: number
): CompositeClipRect | null {
  if (!rect) return null;
  const left = Math.max(0, Math.floor(rect.left));
  const top = Math.max(0, Math.floor(rect.top));
  const right = Math.min(width, Math.ceil(rect.right));
  const bottom = Math.min(height, Math.ceil(rect.bottom));
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

export function collectTileCoordsForRect(
  rect: CompositeClipRect | null | undefined,
  width: number,
  height: number,
  tileSize: number
): TileCoord[] {
  const targetRect = rect ?? { left: 0, top: 0, right: width, bottom: height };
  const left = Math.max(0, Math.floor(targetRect.left));
  const top = Math.max(0, Math.floor(targetRect.top));
  const right = Math.min(width, Math.ceil(targetRect.right));
  const bottom = Math.min(height, Math.ceil(targetRect.bottom));
  if (left >= right || top >= bottom) return [];

  const tileLeft = Math.floor(left / tileSize);
  const tileTop = Math.floor(top / tileSize);
  const tileRight = Math.ceil(right / tileSize);
  const tileBottom = Math.ceil(bottom / tileSize);
  const tiles: TileCoord[] = [];

  for (let ty = tileTop; ty < tileBottom; ty += 1) {
    for (let tx = tileLeft; tx < tileRight; tx += 1) {
      tiles.push({ x: tx, y: ty });
    }
  }
  return tiles;
}

function resolveTargetTiles(
  rect: CompositeClipRect | null,
  width: number,
  height: number,
  tileSize: number
): TileCoord[] {
  const tiles = collectTileCoordsForRect(rect, width, height, tileSize);
  if (tiles.length > 0) return tiles;
  return collectTileCoordsForRect(null, width, height, tileSize);
}

export function runGpuMovePreviewFrame<TLayer extends { id: string; revision: number }>({
  gpuRenderer,
  visibleLayers,
  movePreview,
  pendingRestore,
  getLayerCanvas,
  width,
  height,
  tileSize,
  onRender,
}: RunGpuMovePreviewFrameOptions<TLayer>): PendingMovePreviewRestore | null {
  if (!movePreview && pendingRestore) {
    const restoreCanvas = getLayerCanvas(pendingRestore.layerId);
    if (restoreCanvas) {
      gpuRenderer.syncLayerTilesFromCanvas(
        pendingRestore.layerId,
        restoreCanvas,
        resolveTargetTiles(pendingRestore.dirtyRect, width, height, tileSize)
      );
    }
  }

  const normalizedMovePreviewRect = normalizeCompositeClipRect(
    movePreview?.dirtyRect,
    width,
    height
  );

  for (const visibleLayer of visibleLayers) {
    if (movePreview && visibleLayer.id === movePreview.layerId) {
      gpuRenderer.syncLayerTilesFromCanvas(
        visibleLayer.id,
        movePreview.canvas,
        resolveTargetTiles(normalizedMovePreviewRect, width, height, tileSize)
      );
      continue;
    }

    const layerCanvas = getLayerCanvas(visibleLayer.id);
    if (!layerCanvas) continue;
    gpuRenderer.syncLayerFromCanvas(visibleLayer.id, layerCanvas, visibleLayer.revision);
  }

  onRender(visibleLayers);

  if (!movePreview) return null;
  return {
    layerId: movePreview.layerId,
    dirtyRect: normalizedMovePreviewRect,
  };
}
