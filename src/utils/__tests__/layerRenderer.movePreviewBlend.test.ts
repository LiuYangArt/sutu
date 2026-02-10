import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlendMode } from '@/stores/document';
import { LayerRenderer } from '../layerRenderer';

type Mock2dContext = {
  canvas: HTMLCanvasElement;
  data: Uint8ClampedArray;
  globalAlpha: number;
  globalCompositeOperation: GlobalCompositeOperation;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  save: () => void;
  restore: () => void;
  clearRect: (x: number, y: number, w: number, h: number) => void;
  fillRect: (x: number, y: number, w: number, h: number) => void;
  drawImage: (img: unknown, ...args: number[]) => void;
  getImageData: (x: number, y: number, w: number, h: number) => ImageData;
  putImageData: (imageData: ImageData, x: number, y: number) => void;
  beginPath: () => void;
  rect: (_x: number, _y: number, _w: number, _h: number) => void;
  clip: () => void;
};

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function blendSourceOver(
  dst: readonly [number, number, number, number],
  src: readonly [number, number, number, number],
  alphaMul: number
): [number, number, number, number] {
  const srcAlpha = (src[3] / 255) * alphaMul;
  const dstAlpha = dst[3] / 255;
  const outAlpha = srcAlpha + dstAlpha * (1 - srcAlpha);
  if (outAlpha <= 0.0001) return [0, 0, 0, 0];

  const outR = (src[0] * srcAlpha + dst[0] * dstAlpha * (1 - srcAlpha)) / outAlpha;
  const outG = (src[1] * srcAlpha + dst[1] * dstAlpha * (1 - srcAlpha)) / outAlpha;
  const outB = (src[2] * srcAlpha + dst[2] * dstAlpha * (1 - srcAlpha)) / outAlpha;
  return [clampByte(outR), clampByte(outG), clampByte(outB), clampByte(outAlpha * 255)];
}

function parseFillStyle(
  fillStyle: string | CanvasGradient | CanvasPattern
): [number, number, number, number] {
  if (typeof fillStyle !== 'string') return [0, 0, 0, 255];
  const hex = /^#([a-f\d]{6})$/i.exec(fillStyle);
  if (!hex) return [0, 0, 0, 255];
  const raw = hex[1]!;
  return [
    Number.parseInt(raw.slice(0, 2), 16),
    Number.parseInt(raw.slice(2, 4), 16),
    Number.parseInt(raw.slice(4, 6), 16),
    255,
  ];
}

function createMock2dContext(
  canvas: HTMLCanvasElement,
  ctxByCanvas: WeakMap<HTMLCanvasElement, Mock2dContext>
): Mock2dContext {
  const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  const stack: Array<{ globalAlpha: number; globalCompositeOperation: GlobalCompositeOperation }> =
    [];

  const readPixel = (x: number, y: number): [number, number, number, number] => {
    const i = (y * canvas.width + x) * 4;
    return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0];
  };

  const writePixel = (
    x: number,
    y: number,
    rgba: readonly [number, number, number, number]
  ): void => {
    const i = (y * canvas.width + x) * 4;
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  };

  const resolveDrawRect = (
    args: number[],
    srcW: number,
    srcH: number
  ): {
    sx: number;
    sy: number;
    sw: number;
    sh: number;
    dx: number;
    dy: number;
    dw: number;
    dh: number;
  } => {
    if (args.length === 2) {
      return { sx: 0, sy: 0, sw: srcW, sh: srcH, dx: args[0]!, dy: args[1]!, dw: srcW, dh: srcH };
    }
    if (args.length === 4) {
      return {
        sx: 0,
        sy: 0,
        sw: srcW,
        sh: srcH,
        dx: args[0]!,
        dy: args[1]!,
        dw: args[2]!,
        dh: args[3]!,
      };
    }
    return {
      sx: args[0]!,
      sy: args[1]!,
      sw: args[2]!,
      sh: args[3]!,
      dx: args[4]!,
      dy: args[5]!,
      dw: args[6]!,
      dh: args[7]!,
    };
  };

  const ctx: Mock2dContext = {
    canvas,
    data,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000000',
    lineCap: 'round',
    lineJoin: 'round',
    save: () => {
      stack.push({
        globalAlpha: ctx.globalAlpha,
        globalCompositeOperation: ctx.globalCompositeOperation,
      });
    },
    restore: () => {
      const snap = stack.pop();
      if (!snap) return;
      ctx.globalAlpha = snap.globalAlpha;
      ctx.globalCompositeOperation = snap.globalCompositeOperation;
    },
    clearRect: (x, y, w, h) => {
      const left = Math.max(0, Math.floor(x));
      const top = Math.max(0, Math.floor(y));
      const right = Math.min(canvas.width, Math.ceil(x + w));
      const bottom = Math.min(canvas.height, Math.ceil(y + h));
      for (let py = top; py < bottom; py += 1) {
        for (let px = left; px < right; px += 1) {
          writePixel(px, py, [0, 0, 0, 0]);
        }
      }
    },
    fillRect: (x, y, w, h) => {
      const fill = parseFillStyle(ctx.fillStyle);
      const left = Math.max(0, Math.floor(x));
      const top = Math.max(0, Math.floor(y));
      const right = Math.min(canvas.width, Math.ceil(x + w));
      const bottom = Math.min(canvas.height, Math.ceil(y + h));
      for (let py = top; py < bottom; py += 1) {
        for (let px = left; px < right; px += 1) {
          const dst = readPixel(px, py);
          writePixel(px, py, blendSourceOver(dst, fill, ctx.globalAlpha));
        }
      }
    },
    drawImage: (img: unknown, ...args: number[]) => {
      const sourceCanvas = img as HTMLCanvasElement;
      const sourceCtx = ctxByCanvas.get(sourceCanvas);
      if (!sourceCtx) return;
      const rect = resolveDrawRect(args, sourceCanvas.width, sourceCanvas.height);
      if (rect.dw <= 0 || rect.dh <= 0 || rect.sw <= 0 || rect.sh <= 0) return;

      for (let py = 0; py < rect.dh; py += 1) {
        const dstY = rect.dy + py;
        if (dstY < 0 || dstY >= canvas.height) continue;
        const srcY = rect.sy + Math.floor((py * rect.sh) / rect.dh);
        if (srcY < 0 || srcY >= sourceCanvas.height) continue;

        for (let px = 0; px < rect.dw; px += 1) {
          const dstX = rect.dx + px;
          if (dstX < 0 || dstX >= canvas.width) continue;
          const srcX = rect.sx + Math.floor((px * rect.sw) / rect.dw);
          if (srcX < 0 || srcX >= sourceCanvas.width) continue;

          const srcI = (srcY * sourceCanvas.width + srcX) * 4;
          const src: [number, number, number, number] = [
            sourceCtx.data[srcI] ?? 0,
            sourceCtx.data[srcI + 1] ?? 0,
            sourceCtx.data[srcI + 2] ?? 0,
            sourceCtx.data[srcI + 3] ?? 0,
          ];

          if (ctx.globalCompositeOperation === 'copy') {
            writePixel(dstX, dstY, [
              src[0],
              src[1],
              src[2],
              clampByte((src[3] / 255) * ctx.globalAlpha * 255),
            ]);
            continue;
          }

          const dst = readPixel(dstX, dstY);
          writePixel(dstX, dstY, blendSourceOver(dst, src, ctx.globalAlpha));
        }
      }
    },
    getImageData: (x, y, w, h) => {
      const width = Math.max(0, Math.floor(w));
      const height = Math.max(0, Math.floor(h));
      const out = new Uint8ClampedArray(width * height * 4);
      for (let py = 0; py < height; py += 1) {
        const srcY = y + py;
        for (let px = 0; px < width; px += 1) {
          const srcX = x + px;
          const outI = (py * width + px) * 4;
          if (srcX < 0 || srcY < 0 || srcX >= canvas.width || srcY >= canvas.height) continue;
          const srcI = (srcY * canvas.width + srcX) * 4;
          out[outI] = data[srcI] ?? 0;
          out[outI + 1] = data[srcI + 1] ?? 0;
          out[outI + 2] = data[srcI + 2] ?? 0;
          out[outI + 3] = data[srcI + 3] ?? 0;
        }
      }
      return new ImageData(out, width, height);
    },
    putImageData: (imageData, x, y) => {
      for (let py = 0; py < imageData.height; py += 1) {
        const dstY = y + py;
        if (dstY < 0 || dstY >= canvas.height) continue;
        for (let px = 0; px < imageData.width; px += 1) {
          const dstX = x + px;
          if (dstX < 0 || dstX >= canvas.width) continue;
          const srcI = (py * imageData.width + px) * 4;
          writePixel(dstX, dstY, [
            imageData.data[srcI] ?? 0,
            imageData.data[srcI + 1] ?? 0,
            imageData.data[srcI + 2] ?? 0,
            imageData.data[srcI + 3] ?? 0,
          ]);
        }
      }
    },
    beginPath: () => undefined,
    rect: () => undefined,
    clip: () => undefined,
  };

  return ctx;
}

function setPixel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rgba: [number, number, number, number]
): void {
  const image = new ImageData(new Uint8ClampedArray(rgba), 1, 1);
  ctx.putImageData(image, x, y);
}

function snapshotPixels(
  ctxByCanvas: WeakMap<HTMLCanvasElement, Mock2dContext>,
  canvas: HTMLCanvasElement
): Uint8ClampedArray {
  const ctx = ctxByCanvas.get(canvas);
  if (!ctx) throw new Error('missing canvas context');
  return new Uint8ClampedArray(ctx.data);
}

function expectPixelsClose(
  actual: Uint8ClampedArray,
  expected: Uint8ClampedArray,
  tolerance = 1
): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i += 1) {
    expect(Math.abs((actual[i] ?? 0) - (expected[i] ?? 0))).toBeLessThanOrEqual(tolerance);
  }
}

describe('LayerRenderer move preview blend', () => {
  let getContextSpy: ReturnType<typeof vi.spyOn>;
  let ctxByCanvas: WeakMap<HTMLCanvasElement, Mock2dContext>;

  beforeEach(() => {
    ctxByCanvas = new WeakMap();
    getContextSpy = vi
      .spyOn(
        HTMLCanvasElement.prototype as unknown as {
          getContext: (...args: unknown[]) => unknown;
        },
        'getContext'
      )
      .mockImplementation(function (this: HTMLCanvasElement) {
        const existing = ctxByCanvas.get(this);
        if (existing) return existing as unknown as CanvasRenderingContext2D;
        const created = createMock2dContext(this, ctxByCanvas);
        ctxByCanvas.set(this, created);
        return created as unknown as CanvasRenderingContext2D;
      });
  });

  afterEach(() => {
    getContextSpy.mockRestore();
  });

  it.each(['normal', 'multiply', 'screen', 'overlay'] as BlendMode[])(
    'preview result matches committed result for blend mode %s',
    (blendMode) => {
      const renderer = new LayerRenderer(4, 4);
      const bottom = renderer.createLayer('bottom', { blendMode: 'normal', opacity: 100 });
      const active = renderer.createLayer('active', { blendMode, opacity: 100 });
      renderer.setLayerOrder(['bottom', 'active']);

      bottom.ctx.fillStyle = '#5078a0';
      bottom.ctx.fillRect(0, 0, 4, 4);
      setPixel(active.ctx, 0, 0, [255, 0, 0, 255]);
      setPixel(active.ctx, 1, 0, [0, 255, 0, 255]);
      setPixel(active.ctx, 0, 1, [0, 0, 255, 255]);

      const previewCanvas = document.createElement('canvas');
      previewCanvas.width = 4;
      previewCanvas.height = 4;
      const previewCtx = previewCanvas.getContext('2d', { willReadFrequently: true });
      if (!previewCtx) throw new Error('missing preview context');
      previewCtx.drawImage(active.canvas, 1, 1);

      const previewComposite = renderer.composite(undefined, undefined, {
        activeLayerId: 'active',
        canvas: previewCanvas,
      });
      const previewPixels = snapshotPixels(ctxByCanvas, previewComposite);

      const snapshot = document.createElement('canvas');
      snapshot.width = 4;
      snapshot.height = 4;
      const snapshotCtx = snapshot.getContext('2d', { willReadFrequently: true });
      if (!snapshotCtx) throw new Error('missing snapshot context');
      snapshotCtx.drawImage(active.canvas, 0, 0);
      active.ctx.clearRect(0, 0, 4, 4);
      active.ctx.drawImage(snapshot, 1, 1);

      const committedComposite = renderer.composite();
      const committedPixels = snapshotPixels(ctxByCanvas, committedComposite);
      expectPixelsClose(previewPixels, committedPixels, 1);
    }
  );
});
