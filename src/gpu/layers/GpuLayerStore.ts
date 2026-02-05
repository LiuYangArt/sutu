import { TileResidencyManager } from './TileResidencyManager';

export interface TileCoord {
  x: number;
  y: number;
}

export interface TileRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

export interface TileHandle {
  key: string;
  coord: TileCoord;
  texture: GPUTexture;
  view: GPUTextureView;
}

const BYTES_PER_PIXEL: Partial<Record<GPUTextureFormat, number>> = {
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  bgra8unorm: 4,
  rgba16float: 8,
  rgba32float: 16,
};

export class GpuLayerStore {
  private device: GPUDevice;
  private layers: Map<string, Map<string, TileHandle>> = new Map();
  private residency: TileResidencyManager;
  private _tileSize: number;
  private _format: GPUTextureFormat;
  private _width: number;
  private _height: number;

  constructor(args: {
    device: GPUDevice;
    tileSize: number;
    format: GPUTextureFormat;
    width: number;
    height: number;
    residency: TileResidencyManager;
  }) {
    this.device = args.device;
    this._tileSize = args.tileSize;
    this._format = args.format;
    this._width = args.width;
    this._height = args.height;
    this.residency = args.residency;
  }

  get tileSize(): number {
    return this._tileSize;
  }

  get format(): GPUTextureFormat {
    return this._format;
  }

  get width(): number {
    return this._width;
  }

  get height(): number {
    return this._height;
  }

  resize(width: number, height: number): void {
    this._width = width;
    this._height = height;
  }

  clear(): void {
    for (const layer of this.layers.values()) {
      for (const handle of layer.values()) {
        handle.texture.destroy();
      }
    }
    this.layers.clear();
    this.residency.clear();
  }

  ensureLayer(layerId: string): Map<string, TileHandle> {
    let layer = this.layers.get(layerId);
    if (!layer) {
      layer = new Map();
      this.layers.set(layerId, layer);
    }
    return layer;
  }

  removeLayer(layerId: string): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    for (const handle of layer.values()) {
      this.residency.release(handle.key);
      handle.texture.destroy();
    }
    this.layers.delete(layerId);
  }

  getTile(layerId: string, coord: TileCoord): TileHandle | null {
    const layer = this.layers.get(layerId);
    if (!layer) return null;
    return layer.get(this.getTileKey(coord)) ?? null;
  }

  getOrCreateTile(layerId: string, coord: TileCoord): TileHandle {
    const layer = this.ensureLayer(layerId);
    const key = this.getTileKey(coord);
    const existing = layer.get(key);
    if (existing) {
      this.residency.touch(key);
      return existing;
    }

    const texture = this.createTileTexture();
    const view = texture.createView();
    const handle: TileHandle = { key, coord, texture, view };

    layer.set(key, handle);
    this.residency.registerTile(key, this.estimateTileBytes(), () => {
      layer.delete(key);
      texture.destroy();
    });

    return handle;
  }

  setTile(layerId: string, handle: TileHandle): void {
    const layer = this.ensureLayer(layerId);
    layer.set(handle.key, handle);
    this.residency.touch(handle.key);
  }

  listTiles(layerId: string): TileHandle[] {
    const layer = this.layers.get(layerId);
    if (!layer) return [];
    return Array.from(layer.values());
  }

  getTileRect(coord: TileCoord): TileRect {
    const originX = coord.x * this._tileSize;
    const originY = coord.y * this._tileSize;
    const width = Math.min(this._tileSize, Math.max(0, this._width - originX));
    const height = Math.min(this._tileSize, Math.max(0, this._height - originY));
    return { originX, originY, width, height };
  }

  uploadLayerFromCanvas(layerId: string, canvas: HTMLCanvasElement): void {
    const tilesX = Math.ceil(this._width / this._tileSize);
    const tilesY = Math.ceil(this._height / this._tileSize);
    for (let ty = 0; ty < tilesY; ty += 1) {
      for (let tx = 0; tx < tilesX; tx += 1) {
        this.uploadTileFromCanvas(layerId, { x: tx, y: ty }, canvas);
      }
    }
  }

  uploadTileFromCanvas(layerId: string, coord: TileCoord, canvas: HTMLCanvasElement): void {
    const rect = this.getTileRect(coord);
    if (rect.width <= 0 || rect.height <= 0) return;

    const handle = this.getOrCreateTile(layerId, coord);
    this.clearTile(handle.texture);

    this.device.queue.copyExternalImageToTexture(
      {
        source: canvas,
        origin: { x: rect.originX, y: rect.originY },
      },
      { texture: handle.texture },
      { width: rect.width, height: rect.height }
    );
  }

  private getTileKey(coord: TileCoord): string {
    return `${coord.x}_${coord.y}`;
  }

  private estimateTileBytes(): number {
    const bpp = BYTES_PER_PIXEL[this._format] ?? 4;
    return this._tileSize * this._tileSize * bpp;
  }

  private createTileTexture(): GPUTexture {
    const texture = this.device.createTexture({
      label: 'Layer Tile',
      size: [this._tileSize, this._tileSize],
      format: this._format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });

    this.clearTile(texture);
    return texture;
  }

  private clearTile(texture: GPUTexture): void {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}
