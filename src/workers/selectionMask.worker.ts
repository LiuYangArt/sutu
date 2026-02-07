type SelectionPoint = {
  x: number;
  y: number;
  type?: 'freehand' | 'polygonal';
};

type BuildMaskRequest = {
  type: 'build_mask';
  requestId: number;
  path: SelectionPoint[];
  width: number;
  height: number;
};

type BuildMaskResponse =
  | {
      type: 'build_mask_done';
      requestId: number;
      width: number;
      height: number;
      buffer: ArrayBuffer;
    }
  | {
      type: 'build_mask_error';
      requestId: number;
      reason: string;
    };

type Point = { x: number; y: number };

function perpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
  let dx = lineEnd.x - lineStart.x;
  let dy = lineEnd.y - lineStart.y;
  const mag = Math.sqrt(dx * dx + dy * dy);
  if (mag > 0) {
    dx /= mag;
    dy /= mag;
  }

  const pvx = point.x - lineStart.x;
  const pvy = point.y - lineStart.y;
  const pvdot = dx * pvx + dy * pvy;
  const dsx = pvdot * dx;
  const dsy = pvdot * dy;
  const ax = pvx - dsx;
  const ay = pvy - dsy;
  return Math.sqrt(ax * ax + ay * ay);
}

function simplifyPath(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points;

  let maxDistance = 0;
  let index = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i += 1) {
    const d = perpendicularDistance(points[i]!, points[0]!, points[end]!);
    if (d > maxDistance) {
      index = i;
      maxDistance = d;
    }
  }

  if (maxDistance > tolerance) {
    const left = simplifyPath(points.slice(0, index + 1), tolerance);
    const right = simplifyPath(points.slice(index, end + 1), tolerance);
    return [...left.slice(0, -1), ...right];
  }
  return [points[0]!, points[end]!];
}

function drawSmoothMaskPath(
  ctx: OffscreenCanvasRenderingContext2D,
  points: Point[],
  closePath: boolean = true
): void {
  if (points.length < 3) {
    if (points.length === 2) {
      ctx.lineTo(points[1]!.x, points[1]!.y);
    }
    return;
  }

  const n = points.length;
  const limit = closePath ? n : n - 1;
  for (let i = 0; i < limit; i += 1) {
    const p0 = points[i]!;
    const p1 = points[(i + 1) % n]!;
    const cpX = p0.x * 0.75 + p1.x * 0.25;
    const cpY = p0.y * 0.75 + p1.y * 0.25;
    const endX = p0.x * 0.25 + p1.x * 0.75;
    const endY = p0.y * 0.25 + p1.y * 0.75;

    if (i === 0) {
      ctx.lineTo(p0.x, p0.y);
    }
    ctx.quadraticCurveTo(cpX, cpY, endX, endY);
    if (!closePath && i === limit - 1) {
      ctx.lineTo(p1.x, p1.y);
    }
  }
}

function pathToMaskData(path: SelectionPoint[], width: number, height: number): Uint8ClampedArray {
  if (path.length === 0) {
    return new Uint8ClampedArray(width * height * 4);
  }

  const OffscreenCanvasCtor = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas })
    .OffscreenCanvas;
  if (!OffscreenCanvasCtor) {
    throw new Error('OffscreenCanvas is not available in selection mask worker');
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pt of path) {
    minX = Math.min(minX, pt.x);
    minY = Math.min(minY, pt.y);
    maxX = Math.max(maxX, pt.x);
    maxY = Math.max(maxY, pt.y);
  }

  const originX = Math.max(0, Math.floor(minX) - 1);
  const originY = Math.max(0, Math.floor(minY) - 1);
  const endX = Math.min(width, Math.ceil(maxX) + 2);
  const endY = Math.min(height, Math.ceil(maxY) + 2);
  const localWidth = Math.max(1, endX - originX);
  const localHeight = Math.max(1, endY - originY);

  const canvas = new OffscreenCanvasCtor(localWidth, localHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to create 2D context in selection mask worker');
  }

  ctx.fillStyle = 'white';
  ctx.beginPath();
  const start = path[0];
  if (start) {
    ctx.moveTo(start.x - originX, start.y - originY);
    let buffer: SelectionPoint[] = [
      {
        ...start,
        x: start.x - originX,
        y: start.y - originY,
      },
    ];

    for (let i = 1; i < path.length; i += 1) {
      const p = path[i];
      if (!p) continue;
      const localPoint: SelectionPoint = {
        ...p,
        x: p.x - originX,
        y: p.y - originY,
      };
      if (p.type === 'polygonal') {
        if (buffer.length > 1) {
          const simplified = simplifyPath(buffer, 1.5);
          drawSmoothMaskPath(ctx, simplified, false);
        }
        ctx.lineTo(localPoint.x, localPoint.y);
        buffer = [localPoint];
      } else {
        buffer.push(localPoint);
      }
    }

    if (buffer.length > 1) {
      const simplified = simplifyPath(buffer, 1.5);
      drawSmoothMaskPath(ctx, simplified, false);
    }

    ctx.closePath();
    ctx.fill();
  }

  const localMask = ctx.getImageData(0, 0, localWidth, localHeight);
  if (originX === 0 && originY === 0 && localWidth === width && localHeight === height) {
    return localMask.data;
  }

  const fullData = new Uint8ClampedArray(width * height * 4);
  const localData = localMask.data;
  for (let y = 0; y < localHeight; y += 1) {
    const srcStart = y * localWidth * 4;
    const srcEnd = srcStart + localWidth * 4;
    const dstStart = ((y + originY) * width + originX) * 4;
    fullData.set(localData.subarray(srcStart, srcEnd), dstStart);
  }
  return fullData;
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<BuildMaskRequest>) => void) | null;
  postMessage: (message: BuildMaskResponse, transfer?: Transferable[]) => void;
};

workerScope.onmessage = (event: MessageEvent<BuildMaskRequest>) => {
  const payload = event.data;
  if (!payload || payload.type !== 'build_mask') return;

  try {
    const data = pathToMaskData(payload.path, payload.width, payload.height);
    const transferableBuffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(transferableBuffer).set(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    );
    workerScope.postMessage(
      {
        type: 'build_mask_done',
        requestId: payload.requestId,
        width: payload.width,
        height: payload.height,
        buffer: transferableBuffer,
      },
      [transferableBuffer]
    );
  } catch (error) {
    workerScope.postMessage({
      type: 'build_mask_error',
      requestId: payload.requestId,
      reason: String(error),
    });
  }
};
