type BooleanSelectionMode = 'add' | 'subtract' | 'intersect';

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

type CommitBooleanSelectionRequest = {
  type: 'commit_boolean_selection';
  requestId: number;
  mode: BooleanSelectionMode;
  path: SelectionPoint[];
  width: number;
  height: number;
  baseBuffer: ArrayBuffer;
};

type WorkerRequest = BuildMaskRequest | CommitBooleanSelectionRequest;

type BuildMaskResponse = {
  type: 'build_mask_done';
  requestId: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
};

type CommitBooleanSelectionResponse = {
  type: 'commit_boolean_selection_done';
  requestId: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  path: SelectionPoint[][];
};

type WorkerErrorResponse = {
  type: 'build_mask_error' | 'commit_boolean_selection_error';
  requestId: number;
  reason: string;
};

type WorkerResponse = BuildMaskResponse | CommitBooleanSelectionResponse | WorkerErrorResponse;

type Point = { x: number; y: number };

type LocalMask = {
  data: Uint8ClampedArray;
  originX: number;
  originY: number;
  width: number;
  height: number;
};

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

function ensureOffscreenCanvasCtor(): typeof OffscreenCanvas {
  const OffscreenCanvasCtor = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas })
    .OffscreenCanvas;
  if (!OffscreenCanvasCtor) {
    throw new Error('OffscreenCanvas is not available in selection mask worker');
  }
  return OffscreenCanvasCtor;
}

function rasterizePathToLocalMask(
  path: SelectionPoint[],
  fullWidth: number,
  fullHeight: number
): LocalMask {
  if (path.length === 0) {
    return {
      data: new Uint8ClampedArray(4),
      originX: 0,
      originY: 0,
      width: 1,
      height: 1,
    };
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
  const endX = Math.min(fullWidth, Math.ceil(maxX) + 2);
  const endY = Math.min(fullHeight, Math.ceil(maxY) + 2);
  const localWidth = Math.max(1, endX - originX);
  const localHeight = Math.max(1, endY - originY);

  const OffscreenCanvasCtor = ensureOffscreenCanvasCtor();
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
  return {
    data: localMask.data,
    originX,
    originY,
    width: localWidth,
    height: localHeight,
  };
}

function expandLocalMaskToFullMask(
  localMask: LocalMask,
  fullWidth: number,
  fullHeight: number
): Uint8ClampedArray {
  if (
    localMask.originX === 0 &&
    localMask.originY === 0 &&
    localMask.width === fullWidth &&
    localMask.height === fullHeight
  ) {
    return localMask.data;
  }

  const fullData = new Uint8ClampedArray(fullWidth * fullHeight * 4);
  for (let y = 0; y < localMask.height; y += 1) {
    const srcStart = y * localMask.width * 4;
    const srcEnd = srcStart + localMask.width * 4;
    const dstStart = ((y + localMask.originY) * fullWidth + localMask.originX) * 4;
    fullData.set(localMask.data.subarray(srcStart, srcEnd), dstStart);
  }
  return fullData;
}

function combineBooleanMaskData(
  baseData: Uint8ClampedArray,
  addedMask: LocalMask,
  mode: BooleanSelectionMode,
  fullWidth: number,
  fullHeight: number
): Uint8ClampedArray {
  const result =
    mode === 'intersect' ? new Uint8ClampedArray(fullWidth * fullHeight * 4) : baseData;
  const localData = addedMask.data;

  for (let y = 0; y < addedMask.height; y += 1) {
    const fullY = y + addedMask.originY;
    for (let x = 0; x < addedMask.width; x += 1) {
      const fullX = x + addedMask.originX;
      const fullIdx = (fullY * fullWidth + fullX) * 4;
      const localIdx = (y * addedMask.width + x) * 4;
      const baseAlpha = baseData[fullIdx + 3] ?? 0;
      const addedAlpha = localData[localIdx + 3] ?? 0;

      let finalAlpha = 0;
      if (mode === 'add') {
        if (addedAlpha <= 0) continue;
        finalAlpha = Math.max(baseAlpha, addedAlpha);
      } else if (mode === 'subtract') {
        if (addedAlpha <= 0) continue;
        finalAlpha = Math.max(0, baseAlpha - addedAlpha);
      } else {
        finalAlpha = Math.min(baseAlpha, addedAlpha);
      }

      writeMaskPixel(result, fullIdx, finalAlpha);
    }
  }

  return result;
}

function writeMaskPixel(target: Uint8ClampedArray, index: number, alpha: number): void {
  if (alpha > 0) {
    target[index] = 255;
    target[index + 1] = 255;
    target[index + 2] = 255;
    target[index + 3] = alpha;
    return;
  }
  target[index] = 0;
  target[index + 1] = 0;
  target[index + 2] = 0;
  target[index + 3] = 0;
}

function toTransferableArrayBuffer(data: Uint8ClampedArray): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return buffer;
}

function traceMaskToPathsFromData(
  data: Uint8ClampedArray,
  width: number,
  height: number
): SelectionPoint[][] {
  const paths: SelectionPoint[][] = [];
  const visitedStart = new Uint8Array(width * height);

  const isSelected = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const idx = (y * width + x) * 4 + 3;
    return (data[idx] ?? 0) > 128;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (!isSelected(x, y) || visitedStart[idx]) continue;

      const isBoundary =
        !isSelected(x - 1, y) ||
        !isSelected(x + 1, y) ||
        !isSelected(x, y - 1) ||
        !isSelected(x, y + 1);
      if (!isBoundary) continue;

      let backtrack: { x: number; y: number } | null = null;
      if (!isSelected(x - 1, y)) backtrack = { x: x - 1, y };
      else if (!isSelected(x, y - 1)) backtrack = { x, y: y - 1 };
      else if (!isSelected(x + 1, y)) backtrack = { x: x + 1, y };
      else if (!isSelected(x, y + 1)) backtrack = { x, y: y + 1 };
      if (!backtrack) continue;

      const path = mooreNeighborTraceFromData(data, width, height, x, y, backtrack, visitedStart);
      if (path.length > 2) {
        paths.push(path);
      }
    }
  }

  return paths;
}

function mooreNeighborTraceFromData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  startBacktrack: { x: number; y: number },
  visitedMap: Uint8Array
): SelectionPoint[] {
  const path: SelectionPoint[] = [];

  const isSelected = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const idx = (y * width + x) * 4 + 3;
    return (data[idx] ?? 0) > 128;
  };

  let cx = startX;
  let cy = startY;
  let bx = startBacktrack.x;
  let by = startBacktrack.y;

  path.push({ x: cx, y: cy });
  visitedMap[cy * width + cx] = 1;

  let i = 0;
  const maxIter = width * height * 4;
  while (i < maxIter) {
    const neighbors = [
      { x: cx, y: cy - 1 },
      { x: cx + 1, y: cy - 1 },
      { x: cx + 1, y: cy },
      { x: cx + 1, y: cy + 1 },
      { x: cx, y: cy + 1 },
      { x: cx - 1, y: cy + 1 },
      { x: cx - 1, y: cy },
      { x: cx - 1, y: cy - 1 },
    ];

    let bIdx = -1;
    for (let k = 0; k < 8; k += 1) {
      const n = neighbors[k];
      if (n && n.x === bx && n.y === by) {
        bIdx = k;
        break;
      }
    }
    if (bIdx < 0) {
      break;
    }

    let nextPixel: { x: number; y: number } | null = null;
    let nextBacktrack: { x: number; y: number } | null = null;
    for (let j = 0; j < 8; j += 1) {
      const idx = (bIdx + 1 + j) % 8;
      const n = neighbors[idx];
      if (n && isSelected(n.x, n.y)) {
        nextPixel = n;
        const prevIdx = (idx + 7) % 8;
        nextBacktrack = neighbors[prevIdx] ?? null;
        break;
      }
    }

    if (!nextPixel || !nextBacktrack) {
      break;
    }
    if (nextPixel.x === startX && nextPixel.y === startY) {
      break;
    }

    path.push(nextPixel);
    visitedMap[nextPixel.y * width + nextPixel.x] = 1;
    cx = nextPixel.x;
    cy = nextPixel.y;
    bx = nextBacktrack.x;
    by = nextBacktrack.y;
    i += 1;
  }

  return path;
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void;
};

function postWorkerError(
  requestId: number,
  type: WorkerErrorResponse['type'],
  error: unknown
): void {
  workerScope.postMessage({
    type,
    requestId,
    reason: String(error),
  });
}

workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const payload = event.data;
  if (!payload) return;

  if (payload.type === 'build_mask') {
    try {
      const localMask = rasterizePathToLocalMask(payload.path, payload.width, payload.height);
      const data = expandLocalMaskToFullMask(localMask, payload.width, payload.height);
      const buffer = toTransferableArrayBuffer(data);
      workerScope.postMessage(
        {
          type: 'build_mask_done',
          requestId: payload.requestId,
          width: payload.width,
          height: payload.height,
          buffer,
        },
        [buffer]
      );
    } catch (error) {
      postWorkerError(payload.requestId, 'build_mask_error', error);
    }
    return;
  }

  if (payload.type === 'commit_boolean_selection') {
    try {
      const baseData = new Uint8ClampedArray(payload.baseBuffer);
      const localAddedMask = rasterizePathToLocalMask(payload.path, payload.width, payload.height);
      const finalData = combineBooleanMaskData(
        baseData,
        localAddedMask,
        payload.mode,
        payload.width,
        payload.height
      );
      const finalPath = traceMaskToPathsFromData(finalData, payload.width, payload.height);
      const buffer = toTransferableArrayBuffer(finalData);
      workerScope.postMessage(
        {
          type: 'commit_boolean_selection_done',
          requestId: payload.requestId,
          width: payload.width,
          height: payload.height,
          buffer,
          path: finalPath,
        },
        [buffer]
      );
    } catch (error) {
      postWorkerError(payload.requestId, 'commit_boolean_selection_error', error);
    }
  }
};
