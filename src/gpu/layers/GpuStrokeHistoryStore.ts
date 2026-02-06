import type { TileCoord } from './GpuLayerStore';

export type GpuStrokeHistorySnapshotMode = 'gpu' | 'cpu';
export type GpuStrokeHistoryDirection = 'undo' | 'redo';

export interface GpuStrokeHistoryTileApplyItem {
  coord: TileCoord;
  texture: GPUTexture | null;
}

export interface GpuStrokeHistoryApplyPayload {
  entryId: string;
  layerId: string;
  direction: GpuStrokeHistoryDirection;
  tiles: GpuStrokeHistoryTileApplyItem[];
}

export interface GpuStrokeHistoryStats {
  budgetBytes: number;
  usedBytes: number;
  entryCount: number;
  activeStrokeCount: number;
  fallbackCount: number;
  captureBeforeCount: number;
  captureAfterCount: number;
  applyCount: number;
  lastFallbackAtMs: number | null;
  lastApplyAtMs: number | null;
}

interface StrokeTileSnapshotPair {
  coord: TileCoord;
  beforeTexture: GPUTexture | null;
  afterTexture: GPUTexture | null;
}

interface ActiveStrokeEntry {
  entryId: string;
  layerId: string;
  mode: GpuStrokeHistorySnapshotMode;
  createdAtMs: number;
  tiles: Map<string, StrokeTileSnapshotPair>;
}

interface CommittedStrokeEntry {
  entryId: string;
  layerId: string;
  createdAtMs: number;
  tiles: Map<string, StrokeTileSnapshotPair>;
}

interface GpuStrokeHistoryStoreOptions {
  device: GPUDevice;
  tileSize: number;
  layerFormat: GPUTextureFormat;
  budgetBytes: number;
}

const FORMAT_BYTES_PER_PIXEL: Partial<Record<GPUTextureFormat, number>> = {
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  bgra8unorm: 4,
  rgba16float: 8,
  rgba32float: 16,
};

function coordKey(coord: TileCoord): string {
  return `${coord.x},${coord.y}`;
}

export class GpuStrokeHistoryStore {
  private device: GPUDevice;
  private tileSize: number;
  private layerFormat: GPUTextureFormat;
  private budgetBytes: number;
  private usedBytes = 0;
  private bytesPerTileSnapshot: number;

  private activeStrokes = new Map<string, ActiveStrokeEntry>();
  private committedEntries = new Map<string, CommittedStrokeEntry>();

  private fallbackCount = 0;
  private captureBeforeCount = 0;
  private captureAfterCount = 0;
  private applyCount = 0;
  private lastFallbackAtMs: number | null = null;
  private lastApplyAtMs: number | null = null;

  constructor(options: GpuStrokeHistoryStoreOptions) {
    this.device = options.device;
    this.tileSize = options.tileSize;
    this.layerFormat = options.layerFormat;
    this.budgetBytes = Math.max(0, Math.floor(options.budgetBytes));
    const bytesPerPixel = FORMAT_BYTES_PER_PIXEL[this.layerFormat] ?? 4;
    this.bytesPerTileSnapshot = this.tileSize * this.tileSize * bytesPerPixel;
  }

  setBudgetBytes(nextBudgetBytes: number): void {
    this.budgetBytes = Math.max(0, Math.floor(nextBudgetBytes));
  }

  beginStroke(entryId: string, layerId: string): GpuStrokeHistorySnapshotMode {
    const mode: GpuStrokeHistorySnapshotMode = this.usedBytes >= this.budgetBytes ? 'cpu' : 'gpu';
    if (mode === 'cpu') {
      this.fallbackCount += 1;
      this.lastFallbackAtMs = performance.now();
      return mode;
    }

    this.activeStrokes.set(entryId, {
      entryId,
      layerId,
      mode,
      createdAtMs: performance.now(),
      tiles: new Map(),
    });
    return mode;
  }

  captureBeforeTile(
    entryId: string,
    encoder: GPUCommandEncoder,
    layerId: string,
    coord: TileCoord,
    sourceTexture: GPUTexture | null
  ): boolean {
    const entry = this.getActiveGpuStroke(entryId, layerId);
    if (!entry) return false;
    const pair = this.getOrCreateTileSnapshotPair(entry, coord);
    if (pair.beforeTexture !== null || sourceTexture === null) {
      return true;
    }

    const snapshotTexture = this.createSnapshotTexture('History Before Snapshot');
    encoder.copyTextureToTexture({ texture: sourceTexture }, { texture: snapshotTexture }, [
      this.tileSize,
      this.tileSize,
      1,
    ]);
    pair.beforeTexture = snapshotTexture;
    this.usedBytes += this.bytesPerTileSnapshot;
    this.captureBeforeCount += 1;
    return true;
  }

  captureAfterTile(
    entryId: string,
    encoder: GPUCommandEncoder,
    layerId: string,
    coord: TileCoord,
    sourceTexture: GPUTexture | null
  ): boolean {
    const entry = this.getActiveGpuStroke(entryId, layerId);
    if (!entry) return false;
    const pair = this.getOrCreateTileSnapshotPair(entry, coord);
    if (pair.afterTexture !== null || sourceTexture === null) {
      return true;
    }

    const snapshotTexture = this.createSnapshotTexture('History After Snapshot');
    encoder.copyTextureToTexture({ texture: sourceTexture }, { texture: snapshotTexture }, [
      this.tileSize,
      this.tileSize,
      1,
    ]);
    pair.afterTexture = snapshotTexture;
    this.usedBytes += this.bytesPerTileSnapshot;
    this.captureAfterCount += 1;
    return true;
  }

  finalizeStroke(entryId: string): void {
    const entry = this.activeStrokes.get(entryId);
    if (!entry) return;
    this.activeStrokes.delete(entryId);

    if (entry.mode !== 'gpu' || entry.tiles.size === 0) {
      this.destroyTilePairs(entry.tiles);
      return;
    }

    this.committedEntries.set(entryId, {
      entryId: entry.entryId,
      layerId: entry.layerId,
      createdAtMs: entry.createdAtMs,
      tiles: entry.tiles,
    });
  }

  apply(
    entryId: string,
    direction: GpuStrokeHistoryDirection
  ): GpuStrokeHistoryApplyPayload | null {
    const entry = this.committedEntries.get(entryId);
    if (!entry) return null;

    const tiles: GpuStrokeHistoryTileApplyItem[] = [];
    for (const pair of entry.tiles.values()) {
      tiles.push({
        coord: pair.coord,
        texture: direction === 'undo' ? pair.beforeTexture : pair.afterTexture,
      });
    }

    this.applyCount += 1;
    this.lastApplyAtMs = performance.now();
    return {
      entryId,
      layerId: entry.layerId,
      direction,
      tiles,
    };
  }

  pruneExcept(entryIds: Set<string>): number {
    let removed = 0;
    for (const [entryId, entry] of this.committedEntries.entries()) {
      if (entryIds.has(entryId)) continue;
      this.destroyTilePairs(entry.tiles);
      this.committedEntries.delete(entryId);
      removed += 1;
    }
    return removed;
  }

  clear(): void {
    for (const entry of this.activeStrokes.values()) {
      this.destroyTilePairs(entry.tiles);
    }
    this.activeStrokes.clear();

    for (const entry of this.committedEntries.values()) {
      this.destroyTilePairs(entry.tiles);
    }
    this.committedEntries.clear();
    this.usedBytes = 0;
  }

  getStats(): GpuStrokeHistoryStats {
    return {
      budgetBytes: this.budgetBytes,
      usedBytes: this.usedBytes,
      entryCount: this.committedEntries.size,
      activeStrokeCount: this.activeStrokes.size,
      fallbackCount: this.fallbackCount,
      captureBeforeCount: this.captureBeforeCount,
      captureAfterCount: this.captureAfterCount,
      applyCount: this.applyCount,
      lastFallbackAtMs: this.lastFallbackAtMs,
      lastApplyAtMs: this.lastApplyAtMs,
    };
  }

  private createSnapshotTexture(label: string): GPUTexture {
    return this.device.createTexture({
      label,
      size: [this.tileSize, this.tileSize, 1],
      format: this.layerFormat,
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  private getActiveGpuStroke(entryId: string, layerId: string): ActiveStrokeEntry | null {
    const entry = this.activeStrokes.get(entryId);
    if (!entry || entry.mode !== 'gpu' || entry.layerId !== layerId) {
      return null;
    }
    return entry;
  }

  private getOrCreateTileSnapshotPair(
    entry: ActiveStrokeEntry,
    coord: TileCoord
  ): StrokeTileSnapshotPair {
    const key = coordKey(coord);
    const existing = entry.tiles.get(key);
    if (existing) return existing;

    const created: StrokeTileSnapshotPair = {
      coord,
      beforeTexture: null,
      afterTexture: null,
    };
    entry.tiles.set(key, created);
    return created;
  }

  private destroyTilePairs(tiles: Map<string, StrokeTileSnapshotPair>): void {
    for (const pair of tiles.values()) {
      if (pair.beforeTexture) {
        pair.beforeTexture.destroy();
        pair.beforeTexture = null;
        this.usedBytes = Math.max(0, this.usedBytes - this.bytesPerTileSnapshot);
      }
      if (pair.afterTexture) {
        pair.afterTexture.destroy();
        pair.afterTexture = null;
        this.usedBytes = Math.max(0, this.usedBytes - this.bytesPerTileSnapshot);
      }
    }
    tiles.clear();
  }
}
