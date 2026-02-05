import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayerRenderer } from '../layerRenderer';

type DrawImageOp = {
  type: 'drawImage';
  img: unknown;
  alpha: number;
  op: GlobalCompositeOperation;
};

type Op = DrawImageOp | { type: 'save' | 'restore' | 'clearRect' };

type Mock2dContext = {
  ops: Op[];
  globalAlpha: number;
  globalCompositeOperation: GlobalCompositeOperation;
  save: () => void;
  restore: () => void;
  clearRect: (...args: unknown[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  drawImage: (...args: any[]) => void;
  // Minimal props used during layer creation/resizing
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: ImageSmoothingQuality;
  fillStyle: string;
  fillRect: (...args: unknown[]) => void;
  getImageData: (...args: unknown[]) => ImageData;
  putImageData: (...args: unknown[]) => void;
};

function createMock2dContext(): Mock2dContext {
  const ops: Op[] = [];
  const stack: Array<{ globalAlpha: number; globalCompositeOperation: GlobalCompositeOperation }> =
    [];

  const ctx: Mock2dContext = {
    ops,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    save: () => {
      stack.push({
        globalAlpha: ctx.globalAlpha,
        globalCompositeOperation: ctx.globalCompositeOperation,
      });
      ops.push({ type: 'save' });
    },
    restore: () => {
      const s = stack.pop();
      if (s) {
        ctx.globalAlpha = s.globalAlpha;
        ctx.globalCompositeOperation = s.globalCompositeOperation;
      }
      ops.push({ type: 'restore' });
    },
    clearRect: () => {
      ops.push({ type: 'clearRect' });
    },
    drawImage: (img: unknown) => {
      ops.push({
        type: 'drawImage',
        img,
        alpha: ctx.globalAlpha,
        op: ctx.globalCompositeOperation,
      });
    },
    lineCap: 'round',
    lineJoin: 'round',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    fillStyle: '#000000',
    fillRect: () => {},
    getImageData: () => new ImageData(1, 1),
    putImageData: () => {},
  };

  return ctx;
}

describe('LayerRenderer preview compositing', () => {
  let getContextSpy: ReturnType<typeof vi.spyOn>;
  let ctxByCanvas: WeakMap<HTMLCanvasElement, Mock2dContext>;

  beforeEach(() => {
    ctxByCanvas = new WeakMap();

    // @ts-expect-error - Overloading getContext for testing causes TS issues with disjoint union types
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(function (this: HTMLCanvasElement) {
        const existing = ctxByCanvas.get(this);
        if (existing) return existing as any;

        const next = createMock2dContext();
        ctxByCanvas.set(this, next);
        return next as any;
      });
  });

  afterEach(() => {
    getContextSpy.mockRestore();
  });

  it('applies layer opacity to stroke preview as a group (WYSIWYG)', () => {
    const renderer = new LayerRenderer(10, 10);
    const layer = renderer.createLayer('layer1', { opacity: 50, blendMode: 'normal' });

    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = 10;
    previewCanvas.height = 10;

    const compositeCanvas = renderer.composite({
      activeLayerId: 'layer1',
      canvas: previewCanvas,
      opacity: 1,
    });

    const compositeCtx = ctxByCanvas.get(compositeCanvas);
    expect(compositeCtx).toBeTruthy();

    const compositeDrawOps = compositeCtx!.ops.filter(
      (op): op is DrawImageOp => op.type === 'drawImage'
    );

    // Active layer is drawn once as a grouped source (layer+preview), then layer opacity is applied.
    expect(compositeDrawOps).toHaveLength(1);
    expect(compositeDrawOps[0]!.alpha).toBeCloseTo(0.5, 6);
    expect(compositeDrawOps[0]!.img).not.toBe(layer.canvas);

    const groupedCanvas = compositeDrawOps[0]!.img as HTMLCanvasElement;
    const groupedCtx = ctxByCanvas.get(groupedCanvas);
    expect(groupedCtx).toBeTruthy();

    const groupedDrawOps = groupedCtx!.ops.filter(
      (op): op is DrawImageOp => op.type === 'drawImage'
    );
    expect(groupedDrawOps).toHaveLength(2);

    // 1) Copy base layer into scratch (including transparency)
    expect(groupedDrawOps[0]!.op).toBe('copy');
    expect(groupedDrawOps[0]!.alpha).toBeCloseTo(1, 6);
    expect(groupedDrawOps[0]!.img).toBe(layer.canvas);

    // 2) Composite preview stroke with stroke-level opacity before layer opacity is applied
    expect(groupedDrawOps[1]!.op).toBe('source-over');
    expect(groupedDrawOps[1]!.alpha).toBeCloseTo(1, 6);
    expect(groupedDrawOps[1]!.img).toBe(previewCanvas);
  });
});
