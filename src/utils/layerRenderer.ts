import { BlendMode, type ResizeCanvasOptions } from '@/stores/document';
import { compositePixelWithTransparentFallback, TRANSPARENT_BACKDROP_EPS } from './layerBlendMath';
import type { StrokeCompositeMode } from './strokeBuffer';

/**
 * Layer canvas data for rendering
 */
export interface LayerCanvas {
  id: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
  isBackground: boolean; // Background layer cannot be erased to transparency
}

interface CompositeRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

function normalizeCompositeRegion(
  region: CompositeRegion | undefined,
  width: number,
  height: number
): CompositeRegion | null {
  if (!region) return null;
  const x = Math.max(0, Math.floor(region.x));
  const y = Math.max(0, Math.floor(region.y));
  const right = Math.min(width, Math.ceil(region.x + region.width));
  const bottom = Math.min(height, Math.ceil(region.y + region.height));
  const w = right - x;
  const h = bottom - y;
  if (w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h };
}

function compositeLayerWithBlend(args: {
  dstCtx: CanvasRenderingContext2D;
  sourceCanvas: HTMLCanvasElement;
  width: number;
  height: number;
  layerOpacity: number;
  blendMode: BlendMode;
  region?: CompositeRegion | null;
}): void {
  const { dstCtx, sourceCanvas, width, height, layerOpacity, blendMode, region } = args;
  const srcCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!srcCtx) return;

  const targetRegion = normalizeCompositeRegion(region ?? undefined, width, height) ?? {
    x: 0,
    y: 0,
    width,
    height,
  };
  if (targetRegion.width <= 0 || targetRegion.height <= 0) return;

  const dst = dstCtx.getImageData(
    targetRegion.x,
    targetRegion.y,
    targetRegion.width,
    targetRegion.height
  );
  const src = srcCtx.getImageData(
    targetRegion.x,
    targetRegion.y,
    targetRegion.width,
    targetRegion.height
  );
  const out = dst.data;
  const srcData = src.data;

  for (let i = 0; i < out.length; i += 4) {
    const srcAlpha = ((srcData[i + 3] ?? 0) / 255) * layerOpacity;
    if (srcAlpha <= 0) continue;
    const pixelIndex = i >> 2;
    const pixelX = targetRegion.x + (pixelIndex % targetRegion.width);
    const pixelY = targetRegion.y + Math.floor(pixelIndex / targetRegion.width);

    const result = compositePixelWithTransparentFallback({
      blendMode,
      dstRgb: [(out[i] ?? 0) / 255, (out[i + 1] ?? 0) / 255, (out[i + 2] ?? 0) / 255],
      dstAlpha: (out[i + 3] ?? 0) / 255,
      srcRgb: [(srcData[i] ?? 0) / 255, (srcData[i + 1] ?? 0) / 255, (srcData[i + 2] ?? 0) / 255],
      srcAlpha,
      pixelX,
      pixelY,
      transparentBackdropEps: TRANSPARENT_BACKDROP_EPS,
    });

    out[i] = Math.round(result.rgb[0] * 255);
    out[i + 1] = Math.round(result.rgb[1] * 255);
    out[i + 2] = Math.round(result.rgb[2] * 255);
    out[i + 3] = Math.round(result.alpha * 255);
  }

  dstCtx.putImageData(dst, targetRegion.x, targetRegion.y);
}

function getAnchorOffset(
  anchor: ResizeCanvasOptions['anchor'],
  deltaX: number,
  deltaY: number
): { x: number; y: number } {
  let x: number;
  switch (anchor) {
    case 'top-left':
    case 'left':
    case 'bottom-left':
      x = 0;
      break;
    case 'top-right':
    case 'right':
    case 'bottom-right':
      x = deltaX;
      break;
    case 'top':
    case 'center':
    case 'bottom':
      x = Math.floor(deltaX / 2);
      break;
  }

  let y: number;
  switch (anchor) {
    case 'top-left':
    case 'top':
    case 'top-right':
      y = 0;
      break;
    case 'bottom-left':
    case 'bottom':
    case 'bottom-right':
      y = deltaY;
      break;
    case 'left':
    case 'center':
    case 'right':
      y = Math.floor(deltaY / 2);
      break;
  }

  return { x, y };
}

function configureResample(
  ctx: CanvasRenderingContext2D,
  mode: ResizeCanvasOptions['resampleMode']
): void {
  if (mode === 'nearest') {
    ctx.imageSmoothingEnabled = false;
    return;
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = mode === 'bilinear' ? 'medium' : 'high';
}

/**
 * LayerRenderer manages multiple canvas layers and composites them
 */
export class LayerRenderer {
  private width: number;
  private height: number;
  private layers: Map<string, LayerCanvas> = new Map();
  private layerOrder: string[] = [];
  private compositeCanvas: HTMLCanvasElement;
  private compositeCtx: CanvasRenderingContext2D;
  private previewLayerCanvas: HTMLCanvasElement;
  private previewLayerCtx: CanvasRenderingContext2D;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;

    // Create composite canvas for final output
    this.compositeCanvas = document.createElement('canvas');
    this.compositeCanvas.width = width;
    this.compositeCanvas.height = height;
    const ctx = this.compositeCanvas.getContext('2d', {
      alpha: true,
      willReadFrequently: true,
    });
    if (!ctx) throw new Error('Failed to create composite canvas context');
    this.compositeCtx = ctx;

    // Scratch canvas for compositing active layer + stroke preview as a group
    // This ensures layer opacity affects preview consistently (WYSIWYG).
    this.previewLayerCanvas = document.createElement('canvas');
    this.previewLayerCanvas.width = width;
    this.previewLayerCanvas.height = height;
    const previewCtx = this.previewLayerCanvas.getContext('2d', {
      alpha: true,
      willReadFrequently: true,
    });
    if (!previewCtx) throw new Error('Failed to create preview layer canvas context');
    this.previewLayerCtx = previewCtx;
  }

  private composeLayerWithPreview(
    layerCanvas: HTMLCanvasElement,
    previewCanvas: HTMLCanvasElement,
    previewOpacity: number,
    compositeMode: StrokeCompositeMode,
    region?: CompositeRegion | null
  ): HTMLCanvasElement {
    const opacity = Math.max(0, Math.min(1, previewOpacity));
    const previewCompositeOp: GlobalCompositeOperation =
      compositeMode === 'erase' ? 'destination-out' : 'source-over';
    const ctx = this.previewLayerCtx;
    const normalizedRegion = normalizeCompositeRegion(region ?? undefined, this.width, this.height);

    if (!normalizedRegion) {
      // Copy layer content including transparent pixels
      ctx.save();
      ctx.globalCompositeOperation = 'copy';
      ctx.globalAlpha = 1;
      ctx.drawImage(layerCanvas, 0, 0);

      if (opacity > 0) {
        ctx.globalCompositeOperation = previewCompositeOp;
        ctx.globalAlpha = opacity;
        ctx.drawImage(previewCanvas, 0, 0);
      }

      ctx.restore();
      return this.previewLayerCanvas;
    }

    const { x, y, width, height } = normalizedRegion;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(x, y, width, height);
    ctx.drawImage(layerCanvas, x, y, width, height, x, y, width, height);

    if (opacity > 0) {
      ctx.globalCompositeOperation = previewCompositeOp;
      ctx.globalAlpha = opacity;
      ctx.drawImage(previewCanvas, x, y, width, height, x, y, width, height);
    }

    ctx.restore();
    return this.previewLayerCanvas;
  }

  /**
   * Create a new layer canvas
   */
  createLayer(
    id: string,
    options: {
      visible?: boolean;
      opacity?: number;
      blendMode?: BlendMode;
      fillColor?: string;
      isBackground?: boolean;
    } = {}
  ): LayerCanvas {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;

    const ctx = canvas.getContext('2d', {
      alpha: true,
      desynchronized: true,
      willReadFrequently: true,
    });

    if (!ctx) throw new Error(`Failed to create layer canvas context for ${id}`);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Fill with background color if specified
    if (options.fillColor) {
      ctx.fillStyle = options.fillColor;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    const layer: LayerCanvas = {
      id,
      canvas,
      ctx,
      visible: options.visible ?? true,
      opacity: options.opacity ?? 100,
      blendMode: options.blendMode ?? 'normal',
      isBackground: options.isBackground ?? false,
    };

    this.layers.set(id, layer);

    // Add to order if not already present
    if (!this.layerOrder.includes(id)) {
      this.layerOrder.push(id);
    }

    return layer;
  }

  /**
   * Get a layer by ID
   */
  getLayer(id: string): LayerCanvas | undefined {
    return this.layers.get(id);
  }

  /**
   * Remove a layer
   */
  removeLayer(id: string): void {
    this.layers.delete(id);
    this.layerOrder = this.layerOrder.filter((layerId) => layerId !== id);
  }

  /**
   * Update layer order
   */
  setLayerOrder(order: string[]): void {
    this.layerOrder = order;
  }

  /**
   * Update layer properties
   */
  updateLayer(
    id: string,
    props: { visible?: boolean; opacity?: number; blendMode?: BlendMode; isBackground?: boolean }
  ): void {
    const layer = this.layers.get(id);
    if (!layer) return;

    if (props.visible !== undefined) layer.visible = props.visible;
    if (props.opacity !== undefined) layer.opacity = props.opacity;
    if (props.blendMode !== undefined) layer.blendMode = props.blendMode;
    if (props.isBackground !== undefined) layer.isBackground = props.isBackground;
  }

  /**
   * Composite all visible layers to the output canvas.
   * Optionally composites a stroke preview into the active layer (display-only),
   * so that layer opacity/blend mode is applied consistently (WYSIWYG).
   *
   * @param preview - Optional stroke preview config for the active layer
   */
  composite(
    preview?: {
      activeLayerId: string;
      canvas: HTMLCanvasElement;
      opacity: number;
      compositeMode?: StrokeCompositeMode;
    },
    region?: CompositeRegion
  ): HTMLCanvasElement {
    const normalizedRegion = normalizeCompositeRegion(region, this.width, this.height);

    if (normalizedRegion) {
      this.compositeCtx.clearRect(
        normalizedRegion.x,
        normalizedRegion.y,
        normalizedRegion.width,
        normalizedRegion.height
      );
    } else {
      this.compositeCtx.clearRect(0, 0, this.width, this.height);
    }

    // Draw layers in order (bottom to top)
    for (const id of this.layerOrder) {
      const layer = this.layers.get(id);
      if (!layer || !layer.visible) continue;

      let sourceCanvas = layer.canvas;
      if (preview && id === preview.activeLayerId && preview.opacity > 0) {
        sourceCanvas = this.composeLayerWithPreview(
          layer.canvas,
          preview.canvas,
          preview.opacity,
          preview.compositeMode ?? 'paint',
          normalizedRegion
        );
      }
      const layerOpacity = layer.opacity / 100;

      if (layer.blendMode !== 'normal') {
        compositeLayerWithBlend({
          dstCtx: this.compositeCtx,
          sourceCanvas,
          width: this.width,
          height: this.height,
          layerOpacity,
          blendMode: layer.blendMode,
          region: normalizedRegion,
        });
        continue;
      }

      // normal 快路径：保持 Canvas2D 直接合成性能
      this.compositeCtx.save();
      this.compositeCtx.globalAlpha = layerOpacity;
      this.compositeCtx.globalCompositeOperation = 'source-over';
      if (normalizedRegion) {
        this.compositeCtx.drawImage(
          sourceCanvas,
          normalizedRegion.x,
          normalizedRegion.y,
          normalizedRegion.width,
          normalizedRegion.height,
          normalizedRegion.x,
          normalizedRegion.y,
          normalizedRegion.width,
          normalizedRegion.height
        );
      } else {
        this.compositeCtx.drawImage(sourceCanvas, 0, 0);
      }
      this.compositeCtx.restore();
    }

    return this.compositeCanvas;
  }

  /**
   * Get the composite canvas
   */
  getCompositeCanvas(): HTMLCanvasElement {
    return this.compositeCanvas;
  }

  /**
   * Resize all layers
   */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;

    // Resize composite canvas
    this.compositeCanvas.width = width;
    this.compositeCanvas.height = height;

    // Resize preview scratch canvas
    this.previewLayerCanvas.width = width;
    this.previewLayerCanvas.height = height;

    // Resize each layer canvas (note: this clears content)
    for (const layer of this.layers.values()) {
      // Save current content
      const imageData = layer.ctx.getImageData(
        0,
        0,
        Math.min(layer.canvas.width, width),
        Math.min(layer.canvas.height, height)
      );

      // Resize
      layer.canvas.width = width;
      layer.canvas.height = height;

      // Restore content
      layer.ctx.putImageData(imageData, 0, 0);
      layer.ctx.lineCap = 'round';
      layer.ctx.lineJoin = 'round';
    }
  }

  /**
   * Resize canvas with advanced options (anchor/scale/resample/fill)
   */
  resizeWithOptions(options: ResizeCanvasOptions): void {
    const newWidth = options.width;
    const newHeight = options.height;
    if (newWidth <= 0 || newHeight <= 0) return;

    const oldWidth = this.width;
    const oldHeight = this.height;

    const deltaX = newWidth - oldWidth;
    const deltaY = newHeight - oldHeight;
    const offset = getAnchorOffset(options.anchor, deltaX, deltaY);

    this.width = newWidth;
    this.height = newHeight;

    // Resize composite canvas
    this.compositeCanvas.width = newWidth;
    this.compositeCanvas.height = newHeight;

    // Resize preview scratch canvas
    this.previewLayerCanvas.width = newWidth;
    this.previewLayerCanvas.height = newHeight;

    // Resize each layer canvas (note: this clears content)
    for (const layer of this.layers.values()) {
      // Backup current content
      const tmp = document.createElement('canvas');
      tmp.width = oldWidth;
      tmp.height = oldHeight;
      const tmpCtx = tmp.getContext('2d', { alpha: true });
      if (tmpCtx) {
        tmpCtx.drawImage(layer.canvas, 0, 0);
      }

      // Resize layer canvas (clears content and resets context state)
      layer.canvas.width = newWidth;
      layer.canvas.height = newHeight;

      // Restore essential stroke properties
      layer.ctx.lineCap = 'round';
      layer.ctx.lineJoin = 'round';

      // Fill extension area for background layer (crop/extend mode only)
      if (!options.scaleContent && layer.isBackground && options.extensionColor !== 'transparent') {
        layer.ctx.fillStyle = options.extensionColor;
        layer.ctx.fillRect(0, 0, newWidth, newHeight);
      }

      if (!tmpCtx) continue;

      if (options.scaleContent) {
        configureResample(layer.ctx, options.resampleMode);
        layer.ctx.drawImage(tmp, 0, 0, newWidth, newHeight);
      } else {
        layer.ctx.drawImage(tmp, offset.x, offset.y);
      }
    }
  }

  /**
   * Get ImageData from a layer
   */
  getLayerImageData(id: string): ImageData | null {
    const layer = this.layers.get(id);
    if (!layer) return null;
    return layer.ctx.getImageData(0, 0, this.width, this.height);
  }

  /**
   * Set ImageData to a layer
   */
  setLayerImageData(id: string, imageData: ImageData): void {
    const layer = this.layers.get(id);
    if (!layer) return;
    layer.ctx.putImageData(imageData, 0, 0);
  }

  /**
   * Clear a single layer's content
   * For background layers, fill with white instead of making transparent
   */
  clearLayer(id: string, backgroundFillColor = '#ffffff'): void {
    const layer = this.layers.get(id);
    if (!layer) return;
    layer.ctx.clearRect(0, 0, this.width, this.height);

    // Background layer should be filled with white after clearing
    if (layer.isBackground) {
      layer.ctx.fillStyle = backgroundFillColor;
      layer.ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  /**
   * Clear all layers
   */
  clear(): void {
    this.layers.clear();
    this.layerOrder = [];
    this.compositeCtx.clearRect(0, 0, this.width, this.height);
  }

  /**
   * Get all layer IDs in order
   */
  getLayerIds(): string[] {
    return [...this.layerOrder];
  }
}
