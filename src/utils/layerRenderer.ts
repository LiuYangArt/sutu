import { BlendMode } from '@/stores/document';

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
}

/**
 * Map CSS blend mode names to canvas globalCompositeOperation
 */
function getCompositeOperation(blendMode: BlendMode): GlobalCompositeOperation {
  const mapping: Record<BlendMode, GlobalCompositeOperation> = {
    normal: 'source-over',
    multiply: 'multiply',
    screen: 'screen',
    overlay: 'overlay',
    darken: 'darken',
    lighten: 'lighten',
    'color-dodge': 'color-dodge',
    'color-burn': 'color-burn',
    'hard-light': 'hard-light',
    'soft-light': 'soft-light',
    difference: 'difference',
    exclusion: 'exclusion',
    hue: 'hue',
    saturation: 'saturation',
    color: 'color',
    luminosity: 'luminosity',
  };

  return mapping[blendMode] || 'source-over';
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

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;

    // Create composite canvas for final output
    this.compositeCanvas = document.createElement('canvas');
    this.compositeCanvas.width = width;
    this.compositeCanvas.height = height;
    const ctx = this.compositeCanvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Failed to create composite canvas context');
    this.compositeCtx = ctx;
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
    } = {}
  ): LayerCanvas {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;

    const ctx = canvas.getContext('2d', {
      alpha: true,
      desynchronized: true,
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
    props: { visible?: boolean; opacity?: number; blendMode?: BlendMode }
  ): void {
    const layer = this.layers.get(id);
    if (!layer) return;

    if (props.visible !== undefined) layer.visible = props.visible;
    if (props.opacity !== undefined) layer.opacity = props.opacity;
    if (props.blendMode !== undefined) layer.blendMode = props.blendMode;
  }

  /**
   * Composite all visible layers to the output canvas
   */
  composite(): HTMLCanvasElement {
    // Clear composite canvas
    this.compositeCtx.clearRect(0, 0, this.width, this.height);

    // Draw layers in order (bottom to top)
    for (const id of this.layerOrder) {
      const layer = this.layers.get(id);
      if (!layer || !layer.visible) continue;

      this.compositeCtx.save();
      this.compositeCtx.globalAlpha = layer.opacity / 100;
      this.compositeCtx.globalCompositeOperation = getCompositeOperation(layer.blendMode);
      this.compositeCtx.drawImage(layer.canvas, 0, 0);
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
   * Clear a single layer's content (make it transparent)
   */
  clearLayer(id: string): void {
    const layer = this.layers.get(id);
    if (!layer) return;
    layer.ctx.clearRect(0, 0, this.width, this.height);
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
