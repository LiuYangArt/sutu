import { describe, expect, it, vi } from 'vitest';
import { GPUStrokeAccumulator } from './GPUStrokeAccumulator';

type AnyRecord = Record<string, unknown>;

function createBaseMock(): AnyRecord {
  return {
    cpuTimer: {
      start: vi.fn(),
      stop: vi.fn(() => 1),
    },
    profiler: {
      resolveTimestamps: vi.fn(() => Promise.resolve()),
      recordFrame: vi.fn(),
    },
    requestPreviewUpdate: vi.fn(),
    addPendingPreviewRect: vi.fn(),
    rectFromBbox: vi.fn((bbox: unknown) => bbox),
    shouldUseStrokeLevelPatternPass: vi.fn(() => true),
    submitStrokeLevelPostProcess: vi.fn(() => true),
    applyWetEdgeToDisplay: vi.fn(),
    submitEncoder: vi.fn(),
    dirtyRect: { left: 10, top: 12, right: 80, bottom: 96 },
    currentRenderScale: 1,
    currentPatternSettings: null,
    noiseTexture: {} as GPUTexture,
    currentNoiseEnabled: false,
    wetEdgeEnabled: false,
    wetEdgeStrength: 0,
    wetEdgeHardness: 0.5,
    dualPostPending: false,
    dualBlendTexture: { label: 'dual-blend' } as GPUTexture,
    pingPongBuffer: {
      source: { label: 'pp-src' } as GPUTexture,
      dest: { label: 'pp-dst' } as GPUTexture,
      display: { label: 'pp-display' } as GPUTexture,
      copyRect: vi.fn(),
      swap: vi.fn(),
    },
    patternCache: {
      getTexture: vi.fn(() => null),
    },
    device: {
      createCommandEncoder: vi.fn((args: { label: string }) => ({ label: args.label })),
    },
    lastPrimaryBatchRect: null,
    lastPrimaryBatchLabel: null,
    width: 512,
    height: 512,
  };
}

describe('GPUStrokeAccumulator texture post-process scheduling regression', () => {
  it('flushBatch: dual off + stroke-level texture should submit main pass then post pass', () => {
    const mock = createBaseMock();
    const dabs = [{ id: 1 }];
    const events: string[] = [];

    mock.instanceBuffer = {
      count: 1,
      getDabsData: vi.fn(() => dabs),
      getBoundingBox: vi.fn(() => ({ left: 10, top: 12, right: 80, bottom: 96 })),
      flush: vi.fn(),
    };
    mock.computeBrushPipeline = {
      dispatch: vi.fn(() => {
        events.push('dispatch-main');
        return true;
      }),
    };
    mock.submitEncoder = vi.fn((encoder: { label: string }) => {
      events.push(`submit-${encoder.label}`);
    });
    mock.submitStrokeLevelPostProcess = vi.fn(() => {
      events.push('submit-post-helper');
      return true;
    });

    const ok = (
      GPUStrokeAccumulator.prototype as unknown as { flushBatch: (deferPost?: boolean) => boolean }
    ).flushBatch.call(mock, false);

    expect(ok).toBe(true);
    expect(mock.submitStrokeLevelPostProcess).toHaveBeenCalledTimes(1);
    expect(mock.submitEncoder).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['dispatch-main', 'submit-Brush Batch Encoder', 'submit-post-helper']);
    expect(mock.requestPreviewUpdate).toHaveBeenCalledTimes(1);
    expect(mock.dualPostPending).toBe(false);
  });

  it('flushBatch: dual on (deferPost) should skip stroke-level post and mark dualPostPending', () => {
    const mock = createBaseMock();
    mock.instanceBuffer = {
      count: 1,
      getDabsData: vi.fn(() => [{ id: 1 }]),
      getBoundingBox: vi.fn(() => ({ left: 10, top: 12, right: 80, bottom: 96 })),
      flush: vi.fn(),
    };
    mock.computeBrushPipeline = {
      dispatch: vi.fn(() => true),
    };

    const ok = (
      GPUStrokeAccumulator.prototype as unknown as { flushBatch: (deferPost?: boolean) => boolean }
    ).flushBatch.call(mock, true);

    expect(ok).toBe(true);
    expect(mock.submitStrokeLevelPostProcess).not.toHaveBeenCalled();
    expect(mock.dualPostPending).toBe(true);
    expect(mock.addPendingPreviewRect).toHaveBeenCalledTimes(1);
  });

  it('flushTextureBatch: dual off + stroke-level texture should pass brushTexture to post helper', () => {
    const mock = createBaseMock();
    const brushTexture = {
      texture: { label: 'brush-tex' } as GPUTexture,
      view: {} as GPUTextureView,
      width: 64,
      height: 64,
    };
    mock.textureInstanceBuffer = {
      count: 1,
      getDabsData: vi.fn(() => [{ id: 1 }]),
      flush: vi.fn(),
      clear: vi.fn(),
    };
    mock.textureAtlas = {
      getCurrentTexture: vi.fn(() => brushTexture),
    };
    mock.computeTextureDabsBoundingBox = vi.fn(() => ({
      left: 10,
      top: 12,
      right: 80,
      bottom: 96,
    }));
    mock.computeTextureBrushPipeline = {
      dispatch: vi.fn(() => true),
    };

    const ok = (
      GPUStrokeAccumulator.prototype as unknown as {
        flushTextureBatch: (deferPost?: boolean) => boolean;
      }
    ).flushTextureBatch.call(mock, false);

    expect(ok).toBe(true);
    expect(mock.submitStrokeLevelPostProcess).toHaveBeenCalledTimes(1);
    expect(mock.submitStrokeLevelPostProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        brushTexture,
        runPostProcessPass: true,
        context: 'primary-texture',
      })
    );
    expect(mock.requestPreviewUpdate).toHaveBeenCalledTimes(1);
  });

  it('flushTextureBatch: dual on (deferPost) should skip stroke-level post and mark dualPostPending', () => {
    const mock = createBaseMock();
    const brushTexture = {
      texture: { label: 'brush-tex' } as GPUTexture,
      view: {} as GPUTextureView,
      width: 64,
      height: 64,
    };
    mock.textureInstanceBuffer = {
      count: 1,
      getDabsData: vi.fn(() => [{ id: 1 }]),
      flush: vi.fn(),
      clear: vi.fn(),
    };
    mock.textureAtlas = {
      getCurrentTexture: vi.fn(() => brushTexture),
    };
    mock.computeTextureDabsBoundingBox = vi.fn(() => ({
      left: 10,
      top: 12,
      right: 80,
      bottom: 96,
    }));
    mock.computeTextureBrushPipeline = {
      dispatch: vi.fn(() => true),
    };

    const ok = (
      GPUStrokeAccumulator.prototype as unknown as {
        flushTextureBatch: (deferPost?: boolean) => boolean;
      }
    ).flushTextureBatch.call(mock, true);

    expect(ok).toBe(true);
    expect(mock.submitStrokeLevelPostProcess).not.toHaveBeenCalled();
    expect(mock.dualPostPending).toBe(true);
    expect(mock.addPendingPreviewRect).toHaveBeenCalledTimes(1);
  });
});
