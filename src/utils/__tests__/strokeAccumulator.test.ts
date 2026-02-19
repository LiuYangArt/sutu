import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { StrokeAccumulator } from '../strokeBuffer';

type MockPutCall = {
  imageData: ImageData;
  dx: number;
  dy: number;
};

type MockContext = {
  putCalls: MockPutCall[];
  createImageData: (width: number, height: number) => ImageData;
  getImageData: (x: number, y: number, width: number, height: number) => ImageData;
  putImageData: (imageData: ImageData, dx: number, dy: number) => void;
  clearRect: (x: number, y: number, width: number, height: number) => void;
};

const ensureImageData = () => {
  if (typeof globalThis.ImageData !== 'undefined') return;

  class SimpleImageData {
    width: number;
    height: number;
    data: Uint8ClampedArray;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  }

  // @ts-expect-error - Injecting ImageData for jsdom fallback
  globalThis.ImageData = SimpleImageData;
};

const createMockContext = (): MockContext => {
  const putCalls: MockPutCall[] = [];
  return {
    putCalls,
    createImageData: (width, height) => new ImageData(width, height),
    getImageData: (_x, _y, width, height) => new ImageData(width, height),
    putImageData: (imageData, dx, dy) => {
      putCalls.push({ imageData, dx, dy });
    },
    clearRect: () => {},
  };
};

describe('StrokeAccumulator preview sync', () => {
  let mockCtx: MockContext;
  let getContextSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ensureImageData();
    mockCtx = createMockContext();
    // @ts-expect-error - Overloading getContext for testing causes TS issues with disjoint union types
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(() => mockCtx as any);
  });

  afterEach(() => {
    getContextSpy.mockRestore();
  });

  function runSinglePixelDualPreview(args: {
    mode: string;
    primary: number;
    secondary: number;
    baseAlphaByte: number;
  }): number {
    const buffer = new StrokeAccumulator(2, 2);
    buffer.beginStroke(1, 0);

    const internal = buffer as unknown as {
      bufferData: Uint8ClampedArray;
      primaryMaskAccumulator: Float32Array | null;
      dualMaskAccumulator: Float32Array | null;
      dualBrushMode: string | null;
      dualBrushEnabled: boolean;
      pendingDirtyRect: { left: number; top: number; right: number; bottom: number };
      syncPendingToCanvas: () => void;
    };

    internal.bufferData.fill(0);
    internal.bufferData[3] = args.baseAlphaByte;
    internal.primaryMaskAccumulator = new Float32Array(4);
    internal.dualMaskAccumulator = new Float32Array(4);
    internal.primaryMaskAccumulator[0] = args.primary;
    internal.dualMaskAccumulator[0] = args.secondary;
    internal.dualBrushMode = args.mode;
    internal.dualBrushEnabled = true;
    internal.pendingDirtyRect = { left: 0, top: 0, right: 1, bottom: 1 };
    internal.syncPendingToCanvas();

    const call = mockCtx.putCalls[mockCtx.putCalls.length - 1];
    expect(call).toBeTruthy();
    return (call?.imageData.data[3] ?? 0) / 255;
  }

  it('uses per-dab sync interval for ground-truth preview', () => {
    const interval = (StrokeAccumulator as unknown as { SYNC_INTERVAL: number }).SYNC_INTERVAL;
    expect(interval).toBe(1);
  });

  it('syncs using dual dirty rect when primary pending is empty', () => {
    const buffer = new StrokeAccumulator(10, 10);
    buffer.beginStroke(1, 0);

    const internal = buffer as unknown as {
      dualBrushEnabled: boolean;
      dualMaskAccumulator: Float32Array | null;
      dualMaskAccumulatorDirty: { left: number; top: number; right: number; bottom: number };
      pendingDirtyRect: { left: number; top: number; right: number; bottom: number };
      syncPendingToCanvas: () => void;
      width: number;
      height: number;
    };

    internal.dualBrushEnabled = true;
    internal.dualMaskAccumulator = new Float32Array(100);
    internal.dualMaskAccumulatorDirty = { left: 2, top: 3, right: 6, bottom: 8 };
    internal.pendingDirtyRect = { left: internal.width, top: internal.height, right: 0, bottom: 0 };

    internal.syncPendingToCanvas();

    expect(mockCtx.putCalls).toHaveLength(1);
    const call = mockCtx.putCalls[0]!;
    expect(call.dx).toBe(2);
    expect(call.dy).toBe(3);
    expect(call.imageData.width).toBe(4);
    expect(call.imageData.height).toBe(5);

    expect(internal.dualMaskAccumulatorDirty).toEqual({
      left: internal.width,
      top: internal.height,
      right: 0,
      bottom: 0,
    });
  });

  it('does not mutate bufferData during dual brush preview blend', () => {
    const buffer = new StrokeAccumulator(4, 4);
    buffer.beginStroke(1, 0);

    const internal = buffer as unknown as {
      bufferData: Uint8ClampedArray;
      primaryMaskAccumulator: Float32Array | null;
      dualMaskAccumulator: Float32Array | null;
      dualBrushMode: string | null;
      dualBrushEnabled: boolean;
      pendingDirtyRect: { left: number; top: number; right: number; bottom: number };
      syncPendingToCanvas: () => void;
    };

    const { bufferData } = internal;
    bufferData.fill(0);
    for (let i = 0; i < bufferData.length; i += 4) {
      bufferData[i + 3] = 200;
    }

    internal.primaryMaskAccumulator = new Float32Array(16);
    internal.dualMaskAccumulator = new Float32Array(16);
    internal.dualBrushMode = 'multiply';
    internal.dualBrushEnabled = true;
    internal.primaryMaskAccumulator[0] = 0.5;
    internal.dualMaskAccumulator[0] = 1.0;
    internal.pendingDirtyRect = { left: 0, top: 0, right: 2, bottom: 2 };

    const before = Array.from(bufferData);
    internal.syncPendingToCanvas();
    const after = Array.from(bufferData);

    expect(after).toEqual(before);
  });

  it('keeps CPU colorDodge lift behavior for dual preview alpha', () => {
    const alpha = runSinglePixelDualPreview({
      mode: 'colorDodge',
      primary: 0.25,
      secondary: 0.8,
      baseAlphaByte: 128,
    });

    expect(alpha).toBeCloseTo(1.0, 6);
  });

  it('keeps CPU overlay lift behavior for high-alpha dual preview region', () => {
    const primary = 0.75;
    const secondary = 0.8;
    const baseAlphaByte = 120;
    const overlay =
      primary < 0.5 ? 2.0 * primary * secondary : 1.0 - 2.0 * (1.0 - primary) * (1.0 - secondary);
    expect(overlay).toBeGreaterThan(primary);
    const expectedAlpha = Math.round(Math.min(255, baseAlphaByte * (overlay / primary))) / 255;

    const alpha = runSinglePixelDualPreview({
      mode: 'overlay',
      primary,
      secondary,
      baseAlphaByte,
    });

    expect(alpha).toBeCloseTo(expectedAlpha, 6);
    expect(alpha).toBeGreaterThan(baseAlphaByte / 255);
  });

  it('uses continuous hardMix curve instead of binary threshold', () => {
    const primary = 0.35;
    const secondary = 0.5;
    const baseAlphaByte = 200;
    const expectedBlended = Math.max(0, Math.min(1, 3.0 * primary - 2.0 * (1.0 - secondary)));
    const expectedAlpha =
      Math.round(Math.min(255, baseAlphaByte * (expectedBlended / primary))) / 255;

    const alpha = runSinglePixelDualPreview({
      mode: 'hardMix',
      primary,
      secondary,
      baseAlphaByte,
    });

    expect(alpha).toBeCloseTo(expectedAlpha, 6);
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(0.2);
  });

  it('uses high-gain linearHeight formula in dual preview', () => {
    const primary = 0.35;
    const secondary = 0.8;
    const baseAlphaByte = 100;
    const m = 10.0 * primary;
    const expectedBlended = Math.max(
      0,
      Math.min(1, Math.max((1.0 - secondary) * m, m - secondary))
    );
    expect(expectedBlended).toBe(1);

    const alpha = runSinglePixelDualPreview({
      mode: 'linearHeight',
      primary,
      secondary,
      baseAlphaByte,
    });

    expect(alpha).toBeCloseTo(1.0, 6);
  });
});
