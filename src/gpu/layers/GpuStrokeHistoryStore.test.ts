import { describe, expect, it, vi } from 'vitest';
import { GpuStrokeHistoryStore } from './GpuStrokeHistoryStore';

interface MockTexture {
  destroy: ReturnType<typeof vi.fn>;
  createView: ReturnType<typeof vi.fn<[], GPUTextureView>>;
}

function createMockTexture(): MockTexture {
  return {
    destroy: vi.fn(),
    createView: vi.fn(() => ({}) as GPUTextureView),
  };
}

function createMockDevice(): { device: GPUDevice; textures: MockTexture[] } {
  const textures: MockTexture[] = [];
  const device = {
    createTexture: vi.fn(() => {
      const texture = createMockTexture();
      textures.push(texture);
      return texture as unknown as GPUTexture;
    }),
  } as unknown as GPUDevice;
  return { device, textures };
}

function createMockEncoder(): GPUCommandEncoder {
  return {
    copyTextureToTexture: vi.fn(),
  } as unknown as GPUCommandEncoder;
}

function ensureGpuTextureUsageGlobal(): void {
  const g = globalThis as unknown as {
    GPUTextureUsage?: {
      COPY_SRC: number;
      COPY_DST: number;
      TEXTURE_BINDING: number;
    };
  };
  if (!g.GPUTextureUsage) {
    g.GPUTextureUsage = {
      COPY_SRC: 1,
      COPY_DST: 2,
      TEXTURE_BINDING: 4,
    };
  }
}

describe('GpuStrokeHistoryStore', () => {
  it('captures before/after snapshots and applies undo/redo payloads', () => {
    ensureGpuTextureUsageGlobal();
    const { device, textures } = createMockDevice();
    const encoder = createMockEncoder();
    const layerTexture = createMockTexture() as unknown as GPUTexture;
    const store = new GpuStrokeHistoryStore({
      device,
      tileSize: 16,
      layerFormat: 'rgba8unorm',
      budgetBytes: 4096,
    });

    expect(store.beginStroke('entry-1', 'layer-1')).toBe('gpu');
    expect(
      store.captureBeforeTile('entry-1', encoder, 'layer-1', { x: 0, y: 0 }, layerTexture)
    ).toBe(true);
    expect(
      store.captureAfterTile('entry-1', encoder, 'layer-1', { x: 0, y: 0 }, layerTexture)
    ).toBe(true);
    store.finalizeStroke('entry-1');

    const undoPayload = store.apply('entry-1', 'undo');
    const redoPayload = store.apply('entry-1', 'redo');
    expect(undoPayload?.entryId).toBe('entry-1');
    expect(undoPayload?.tiles).toHaveLength(1);
    expect(undoPayload?.tiles[0]?.texture).toBeTruthy();
    expect(redoPayload?.entryId).toBe('entry-1');
    expect(redoPayload?.tiles).toHaveLength(1);
    expect(redoPayload?.tiles[0]?.texture).toBeTruthy();

    const statsAfterCapture = store.getStats();
    expect(statsAfterCapture.entryCount).toBe(1);
    expect(statsAfterCapture.captureBeforeCount).toBe(1);
    expect(statsAfterCapture.captureAfterCount).toBe(1);
    expect(statsAfterCapture.usedBytes).toBe(2048);
    expect(statsAfterCapture.applyCount).toBe(2);

    expect(store.pruneExcept(new Set())).toBe(1);
    const statsAfterPrune = store.getStats();
    expect(statsAfterPrune.entryCount).toBe(0);
    expect(statsAfterPrune.usedBytes).toBe(0);
    expect(textures).toHaveLength(2);
    expect(textures[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(textures[1]?.destroy).toHaveBeenCalledTimes(1);
  });

  it('falls back to CPU mode when budget is exhausted', () => {
    ensureGpuTextureUsageGlobal();
    const { device } = createMockDevice();
    const store = new GpuStrokeHistoryStore({
      device,
      tileSize: 16,
      layerFormat: 'rgba8unorm',
      budgetBytes: 0,
    });

    expect(store.beginStroke('entry-2', 'layer-1')).toBe('cpu');
    const stats = store.getStats();
    expect(stats.fallbackCount).toBe(1);
    expect(stats.lastFallbackAtMs).not.toBeNull();
  });

  it('requires finalizeStroke before apply becomes available', () => {
    ensureGpuTextureUsageGlobal();
    const { device } = createMockDevice();
    const encoder = createMockEncoder();
    const layerTexture = createMockTexture() as unknown as GPUTexture;
    const store = new GpuStrokeHistoryStore({
      device,
      tileSize: 16,
      layerFormat: 'rgba8unorm',
      budgetBytes: 4096,
    });

    expect(store.beginStroke('entry-need-finalize', 'layer-1')).toBe('gpu');
    expect(
      store.captureBeforeTile(
        'entry-need-finalize',
        encoder,
        'layer-1',
        { x: 0, y: 0 },
        layerTexture
      )
    ).toBe(true);
    expect(
      store.captureAfterTile(
        'entry-need-finalize',
        encoder,
        'layer-1',
        { x: 0, y: 0 },
        layerTexture
      )
    ).toBe(true);

    expect(store.apply('entry-need-finalize', 'undo')).toBeNull();

    store.finalizeStroke('entry-need-finalize');
    expect(store.apply('entry-need-finalize', 'undo')).not.toBeNull();
  });
});
