import { create } from 'zustand';
import { combineMasks, traceMaskToPaths } from '@/utils/selectionAlgorithms';
import { simplifyPath, drawSmoothMaskPath } from '@/utils/pathSmoothing';

/**
 * Selection mode for boolean operations
 * - new: Replace existing selection
 * - add: Add to existing selection (Shift)
 * - subtract: Subtract from existing selection (Alt)
 * - intersect: Intersect with existing selection (Shift+Alt)
 */
export type SelectionMode = 'new' | 'add' | 'subtract' | 'intersect';

/**
 * Lasso tool sub-mode
 * - freehand: Free drawing mode (default)
 * - polygonal: Click to add vertices, double-click to complete
 */
export type LassoMode = 'freehand' | 'polygonal';

/** Selection path point */
export interface SelectionPoint {
  x: number;
  y: number;
  type?: 'freehand' | 'polygonal';
}

/** Selection bounding box */
export interface SelectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SelectionMaskWorkerBuildRequest {
  type: 'build_mask';
  requestId: number;
  path: SelectionPoint[];
  width: number;
  height: number;
}

interface SelectionMaskWorkerBooleanRequest {
  type: 'commit_boolean_selection';
  requestId: number;
  mode: Exclude<SelectionMode, 'new'>;
  path: SelectionPoint[];
  width: number;
  height: number;
  baseBuffer: ArrayBuffer;
}

type SelectionMaskWorkerRequest =
  | SelectionMaskWorkerBuildRequest
  | SelectionMaskWorkerBooleanRequest;

interface SelectionMaskWorkerBuildResponse {
  type: 'build_mask_done';
  requestId: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

interface SelectionMaskWorkerBooleanResponse {
  type: 'commit_boolean_selection_done';
  requestId: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  path: SelectionPoint[][];
}

interface SelectionMaskWorkerErrorResponse {
  type: 'build_mask_error' | 'commit_boolean_selection_error';
  requestId: number;
  reason: string;
}

type SelectionMaskWorkerResponse =
  | SelectionMaskWorkerBuildResponse
  | SelectionMaskWorkerBooleanResponse
  | SelectionMaskWorkerErrorResponse;

type BooleanSelectionWorkerResult = {
  mask: ImageData;
  path: SelectionPoint[][];
};

type SelectionMaskWorkerPendingHandler =
  | {
      kind: 'build';
      resolve: (mask: ImageData | null) => void;
      reject: (error: unknown) => void;
    }
  | {
      kind: 'boolean';
      resolve: (result: BooleanSelectionWorkerResult | null) => void;
      reject: (error: unknown) => void;
    };

let selectionMaskWorker: Worker | null | undefined;
let selectionMaskWorkerRequestSeq = 1;
const selectionMaskWorkerPending = new Map<number, SelectionMaskWorkerPendingHandler>();

function ensureSelectionMaskWorker(): Worker | null {
  if (selectionMaskWorker !== undefined) return selectionMaskWorker;
  if (typeof Worker === 'undefined') {
    selectionMaskWorker = null;
    return null;
  }

  try {
    const worker = new Worker(new URL('../workers/selectionMask.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<SelectionMaskWorkerResponse>) => {
      const payload = event.data;
      const pending = selectionMaskWorkerPending.get(payload.requestId);
      if (!pending) return;
      selectionMaskWorkerPending.delete(payload.requestId);

      if (pending.kind === 'build' && payload.type === 'build_mask_done') {
        const data = new Uint8ClampedArray(payload.buffer);
        pending.resolve(new ImageData(data, payload.width, payload.height));
        return;
      }

      if (pending.kind === 'boolean' && payload.type === 'commit_boolean_selection_done') {
        const data = new Uint8ClampedArray(payload.buffer);
        pending.resolve({
          mask: new ImageData(data, payload.width, payload.height),
          path: payload.path,
        });
        return;
      }

      if (
        payload.type === 'build_mask_error' ||
        payload.type === 'commit_boolean_selection_error'
      ) {
        pending.reject(new Error(payload.reason ?? 'selection mask worker error'));
        return;
      }

      pending.reject(new Error('selection mask worker invalid response'));
    };
    worker.onerror = () => {
      selectionMaskWorker = null;
      const pendings = Array.from(selectionMaskWorkerPending.values());
      selectionMaskWorkerPending.clear();
      for (const pending of pendings) {
        pending.resolve(null);
      }
    };
    selectionMaskWorker = worker;
  } catch {
    selectionMaskWorker = null;
  }
  return selectionMaskWorker;
}

function rasterizeSelectionMaskInWorker(
  path: SelectionPoint[],
  width: number,
  height: number
): Promise<ImageData | null> {
  const worker = ensureSelectionMaskWorker();
  if (!worker) {
    return Promise.resolve(null);
  }

  return new Promise<ImageData | null>((resolve, reject) => {
    const requestId = selectionMaskWorkerRequestSeq++;
    selectionMaskWorkerPending.set(requestId, { kind: 'build', resolve, reject });
    const payload: SelectionMaskWorkerRequest = {
      type: 'build_mask',
      requestId,
      path,
      width,
      height,
    };
    worker.postMessage(payload);
  }).catch(() => null);
}

function buildBooleanSelectionInWorker(
  baseMask: ImageData,
  path: SelectionPoint[],
  mode: Exclude<SelectionMode, 'new'>,
  width: number,
  height: number
): Promise<BooleanSelectionWorkerResult | null> {
  const worker = ensureSelectionMaskWorker();
  if (!worker) {
    return Promise.resolve(null);
  }

  return new Promise<BooleanSelectionWorkerResult | null>((resolve, reject) => {
    const requestId = selectionMaskWorkerRequestSeq++;
    selectionMaskWorkerPending.set(requestId, { kind: 'boolean', resolve, reject });
    const baseBuffer = new Uint8ClampedArray(baseMask.data).buffer;
    const payload: SelectionMaskWorkerRequest = {
      type: 'commit_boolean_selection',
      requestId,
      mode,
      path,
      width,
      height,
      baseBuffer,
    };
    worker.postMessage(payload, [baseBuffer]);
  }).catch(() => null);
}

function waitForRenderTick(): Promise<void> {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function waitForNextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isPointInPolygon(path: SelectionPoint[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = path.length - 1; i < path.length; j = i, i += 1) {
    const pi = path[i];
    const pj = path[j];
    if (!pi || !pj) continue;
    const yiAbove = pi.y > y;
    const yjAbove = pj.y > y;
    if (yiAbove === yjAbove) continue;
    const intersectX = ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y || 1e-6) + pi.x;
    if (x < intersectX) {
      inside = !inside;
    }
  }
  return inside;
}

function isPointInSelectionPath(paths: SelectionPoint[][], x: number, y: number): boolean {
  let inside = false;
  for (const contour of paths) {
    if (contour.length < 3) continue;
    if (isPointInPolygon(contour, x, y)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Immutable snapshot of selection core state for history.
 * Note: Snapshot stores references (no deep clone). Selection updates should be immutable.
 */
export interface SelectionSnapshot {
  hasSelection: boolean;
  selectionMask: ImageData | null;
  selectionMaskPending: boolean;
  selectionPath: SelectionPoint[][];
  bounds: SelectionBounds | null;
}

export function didSelectionChange(before: SelectionSnapshot, after: SelectionSnapshot): boolean {
  return (
    before.hasSelection !== after.hasSelection ||
    before.selectionMask !== after.selectionMask ||
    before.selectionMaskPending !== after.selectionMaskPending ||
    before.selectionPath !== after.selectionPath ||
    before.bounds !== after.bounds
  );
}

interface SelectionState {
  // Core selection data
  hasSelection: boolean;
  selectionMask: ImageData | null; // Bitmap mask (0-255 alpha)
  selectionMaskPending: boolean; // Mask is building asynchronously
  selectionMaskBuildId: number; // Async build token for stale-result guard
  selectionPath: SelectionPoint[][]; // Vector paths (contours) for marching ants
  bounds: SelectionBounds | null; // Selection bounding box

  // Interaction state
  isCreating: boolean; // Currently creating selection
  creationPoints: SelectionPoint[]; // Temporary points during creation
  previewPoint: SelectionPoint | null; // Preview point for polygonal mode (cursor position)
  creationStart: SelectionPoint | null; // Start point for rect selection
  selectionMode: SelectionMode; // Boolean operation mode
  lassoMode: LassoMode; // Lasso sub-mode

  // Move state
  isMoving: boolean; // Currently moving selection
  moveStartPoint: SelectionPoint | null; // Starting point of drag
  originalPath: SelectionPoint[][]; // Path before move started
  originalBounds: SelectionBounds | null; // Bounds before move started

  // Rendering state
  featherRadius: number; // Feather radius in pixels
  marchingAntsOffset: number; // Animation offset for marching ants

  // Actions
  setSelectionMode: (mode: SelectionMode) => void;
  setLassoMode: (mode: LassoMode) => void;

  // Selection creation
  beginSelection: (startPoint?: SelectionPoint) => void;
  addCreationPoint: (point: SelectionPoint) => void;
  updatePreviewPoint: (point: SelectionPoint | null) => void; // For polygonal mode preview line
  updateCreationRect: (start: SelectionPoint, end: SelectionPoint) => void;
  commitSelection: (documentWidth: number, documentHeight: number) => void;
  cancelSelection: () => void;

  // Selection operations
  selectAll: (width: number, height: number) => void;
  deselectAll: () => void;
  invertSelection: (width: number, height: number) => void;

  // Selection move
  beginMove: (startPoint: SelectionPoint) => void;
  updateMove: (currentPoint: SelectionPoint, docWidth: number, docHeight: number) => void;
  commitMove: (docWidth: number, docHeight: number) => void;
  cancelMove: () => void;

  // Marching ants animation
  updateMarchingAnts: () => void;

  // Utility methods
  isPointInSelection: (x: number, y: number) => boolean;
  isPointInBounds: (x: number, y: number) => boolean;
  getSelectionMaskForLayer: () => ImageData | null;

  // History helpers (core state only)
  createSnapshot: () => SelectionSnapshot;
  applySnapshot: (snapshot: SelectionSnapshot | null) => void;
}

/**
 * Convert a closed path to a bitmap mask using Canvas 2D fill
 */
function pathToMask(path: SelectionPoint[], width: number, height: number): ImageData {
  if (path.length === 0) {
    return new ImageData(width, height);
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

  const canvas = document.createElement('canvas');
  canvas.width = localWidth;
  canvas.height = localHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new ImageData(width, height);
  }

  // Fill the path
  ctx.fillStyle = 'white';
  ctx.beginPath();

  if (path.length > 0) {
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

      for (let i = 1; i < path.length; i++) {
        const p = path[i];
        if (p) {
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
      }

      if (buffer.length > 1) {
        const simplified = simplifyPath(buffer, 1.5);
        drawSmoothMaskPath(ctx, simplified, false);
      }

      ctx.closePath();
      ctx.fill();
    }
  }

  const localMask = ctx.getImageData(0, 0, localWidth, localHeight);
  if (originX === 0 && originY === 0 && localWidth === width && localHeight === height) {
    return localMask;
  }

  const fullMask = new ImageData(width, height);
  const fullData = fullMask.data;
  const localData = localMask.data;
  for (let y = 0; y < localHeight; y += 1) {
    const srcStart = y * localWidth * 4;
    const srcEnd = srcStart + localWidth * 4;
    const dstStart = ((y + originY) * width + originX) * 4;
    fullData.set(localData.subarray(srcStart, srcEnd), dstStart);
  }
  return fullMask;
}

/**
 * Calculate bounding box from path points (multiple contours)
 */
function calculateBounds(paths: SelectionPoint[][]): SelectionBounds | null {
  if (paths.length === 0) return null;

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let hasPoints = false;

  for (const path of paths) {
    for (const pt of path) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
      hasPoints = true;
    }
  }

  if (!hasPoints) return null;

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Create rectangle path from two corner points
 */
function createRectPath(start: SelectionPoint, end: SelectionPoint): SelectionPoint[] {
  const x1 = Math.min(start.x, end.x);
  const y1 = Math.min(start.y, end.y);
  const x2 = Math.max(start.x, end.x);
  const y2 = Math.max(start.y, end.y);

  const points = [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
    { x: x1, y: y1 },
  ];

  return points.map((p) => ({ ...p, type: 'polygonal' }));
}

export const useSelectionStore = create<SelectionState>()((set, get) => ({
  // Initial state
  hasSelection: false,
  selectionMask: null,
  selectionMaskPending: false,
  selectionMaskBuildId: 0,
  selectionPath: [],
  bounds: null,

  isCreating: false,
  creationPoints: [],
  previewPoint: null,
  creationStart: null,
  selectionMode: 'new',
  lassoMode: 'freehand',

  // Move state
  isMoving: false,
  moveStartPoint: null,
  originalPath: [],
  originalBounds: null,

  featherRadius: 0,
  marchingAntsOffset: 0,

  // Actions
  setSelectionMode: (mode) => set({ selectionMode: mode }),
  setLassoMode: (mode) => set({ lassoMode: mode }),

  beginSelection: (startPoint) =>
    set({
      isCreating: true,
      creationPoints: startPoint ? [startPoint] : [],
      creationStart: startPoint ?? null,
    }),

  addCreationPoint: (point) =>
    set((state) => ({
      creationPoints: [...state.creationPoints, point],
      previewPoint: null, // Clear preview when adding actual point
    })),

  updatePreviewPoint: (point) =>
    set({
      previewPoint: point,
    }),

  updateCreationRect: (start, end) =>
    set({
      creationStart: start,
      creationPoints: createRectPath(start, end),
    }),

  commitSelection: (documentWidth, documentHeight) => {
    const state = get();
    const path = state.creationPoints;

    // Need at least 3 points to form a valid selection
    if (path.length < 3) {
      set({
        isCreating: false,
        creationPoints: [],
        previewPoint: null, // Clear preview point
        creationStart: null,
      });
      return;
    }

    // Determine if we should start a new selection or combine with existing
    const isNewSelection =
      state.selectionMode === 'new' || !state.hasSelection || !state.selectionMask;

    if (isNewSelection) {
      const finalPath: SelectionPoint[][] = [path.map((p) => ({ ...p }))];
      const bounds = calculateBounds(finalPath);
      const hasSelection = finalPath.length > 0 && !!bounds;
      const buildId = state.selectionMaskBuildId + 1;

      set({
        hasSelection,
        selectionMask: null,
        selectionMaskPending: hasSelection,
        selectionMaskBuildId: buildId,
        selectionPath: hasSelection ? finalPath : [],
        bounds: hasSelection ? bounds : null,
        isCreating: false,
        creationPoints: [],
        previewPoint: null,
        creationStart: null,
      });

      if (!hasSelection) {
        return;
      }

      const pathForMask = finalPath[0]!.map((p) => ({ ...p }));
      void (async () => {
        let mask = await rasterizeSelectionMaskInWorker(pathForMask, documentWidth, documentHeight);
        if (!mask) {
          await waitForNextMacrotask();
          const latest = get();
          if (latest.selectionMaskBuildId !== buildId || !latest.hasSelection) {
            return;
          }
          mask = pathToMask(pathForMask, documentWidth, documentHeight);
        }

        set((current) => {
          if (current.selectionMaskBuildId !== buildId || !current.hasSelection) {
            return current;
          }
          return {
            selectionMask: mask,
            selectionMaskPending: false,
          };
        });
      })();

      return;
    }

    const buildId = state.selectionMaskBuildId + 1;
    const mode = state.selectionMode;
    const baseMask = state.selectionMask;
    if (mode === 'new' || !baseMask) {
      return;
    }
    const pathForMask = path.map((p) => ({ ...p }));
    set({
      selectionMaskPending: true,
      selectionMaskBuildId: buildId,
      isCreating: false,
      creationPoints: [],
      previewPoint: null, // Clear preview point
      creationStart: null,
    });

    void (async () => {
      await waitForRenderTick();
      let result = await buildBooleanSelectionInWorker(
        baseMask,
        pathForMask,
        mode,
        documentWidth,
        documentHeight
      );
      if (!result) {
        await waitForNextMacrotask();
        const latest = get();
        if (latest.selectionMaskBuildId !== buildId || !latest.selectionMask) {
          return;
        }
        const newMask = pathToMask(pathForMask, documentWidth, documentHeight);
        const finalMask = combineMasks(latest.selectionMask, newMask, mode);
        result = {
          mask: finalMask,
          path: traceMaskToPaths(finalMask),
        };
      }

      set((current) => {
        if (current.selectionMaskBuildId !== buildId) {
          return current;
        }
        const bounds = calculateBounds(result.path);
        const hasSelection = result.path.length > 0 && !!bounds;
        return {
          hasSelection,
          selectionMask: hasSelection ? result.mask : null,
          selectionMaskPending: false,
          selectionPath: hasSelection ? result.path : [],
          bounds: hasSelection ? bounds : null,
        };
      });
    })();
  },

  cancelSelection: () =>
    set((state) => ({
      isCreating: false,
      creationPoints: [],
      previewPoint: null, // Clear preview point
      creationStart: null,
      selectionMaskPending: false,
      selectionMaskBuildId: state.selectionMaskBuildId + 1,
    })),

  selectAll: (width, height) => {
    const path = createRectPath({ x: 0, y: 0 }, { x: width, y: height });
    const mask = pathToMask(path, width, height);

    set({
      hasSelection: true,
      selectionMask: mask,
      selectionMaskPending: false,
      selectionMaskBuildId: get().selectionMaskBuildId + 1,
      selectionPath: [path],
      bounds: { x: 0, y: 0, width, height },
    });
  },

  deselectAll: () =>
    set((state) => ({
      hasSelection: false,
      selectionMask: null,
      selectionMaskPending: false,
      selectionMaskBuildId: state.selectionMaskBuildId + 1,
      selectionPath: [],
      bounds: null,
      isCreating: false,
      creationPoints: [],
      previewPoint: null, // Clear preview point
      creationStart: null,
      // Also clear move state
      isMoving: false,
      moveStartPoint: null,
      originalPath: [],
      originalBounds: null,
    })),

  invertSelection: (width, height) => {
    const state = get();
    if (!state.selectionMask) return;

    // Invert the alpha channel of the mask
    const mask = state.selectionMask;
    const inverted = new ImageData(mask.width, mask.height);

    for (let i = 0; i < mask.data.length; i += 4) {
      // Copy RGB (not used, but keep for consistency)
      inverted.data[i] = mask.data[i] ?? 0;
      inverted.data[i + 1] = mask.data[i + 1] ?? 0;
      inverted.data[i + 2] = mask.data[i + 2] ?? 0;
      // Invert alpha
      const alpha = mask.data[i + 3] ?? 0;
      inverted.data[i + 3] = 255 - alpha;
    }

    set({
      selectionMask: inverted,
      selectionMaskPending: false,
      selectionMaskBuildId: state.selectionMaskBuildId + 1,
      bounds: { x: 0, y: 0, width, height },
      // Note: selectionPath would need complex inversion, keeping as-is for now
    });
  },

  updateMarchingAnts: () =>
    set((state) => ({
      marchingAntsOffset: (state.marchingAntsOffset + 0.15) % 8,
    })),

  isPointInSelection: (x, y) => {
    const state = get();
    if (!state.hasSelection) return true; // No selection = all allowed
    if (!state.selectionMask) {
      return isPointInSelectionPath(state.selectionPath, x, y);
    }

    const mask = state.selectionMask;
    const ix = Math.floor(x);
    const iy = Math.floor(y);

    if (ix < 0 || ix >= mask.width || iy < 0 || iy >= mask.height) {
      return false;
    }

    const idx = (iy * mask.width + ix) * 4 + 3; // Alpha channel
    return (mask.data[idx] ?? 0) > 0;
  },

  isPointInBounds: (x, y) => {
    const state = get();
    if (!state.hasSelection || !state.bounds) return false;
    const b = state.bounds;
    return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
  },

  // Selection move actions
  beginMove: (startPoint) => {
    const state = get();
    if (!state.hasSelection) return;

    set({
      isMoving: true,
      moveStartPoint: startPoint,
      originalPath: JSON.parse(JSON.stringify(state.selectionPath)), // Deep copy for array of arrays
      originalBounds: state.bounds ? { ...state.bounds } : null,
    });
  },

  updateMove: (currentPoint, docWidth, docHeight) => {
    const state = get();
    if (!state.isMoving || !state.moveStartPoint || !state.originalBounds) return;

    // Calculate offset
    let deltaX = currentPoint.x - state.moveStartPoint.x;
    let deltaY = currentPoint.y - state.moveStartPoint.y;

    // Constrain to canvas bounds
    const newX = state.originalBounds.x + deltaX;
    const newY = state.originalBounds.y + deltaY;
    const w = state.originalBounds.width;
    const h = state.originalBounds.height;

    if (newX < 0) deltaX -= newX;
    if (newY < 0) deltaY -= newY;
    if (newX + w > docWidth) deltaX -= newX + w - docWidth;
    if (newY + h > docHeight) deltaY -= newY + h - docHeight;

    // Translate path points (handle multiple contours)
    const newPath = state.originalPath.map((contour) =>
      contour.map((pt) => ({
        x: pt.x + deltaX,
        y: pt.y + deltaY,
      }))
    );

    set({
      selectionPath: newPath,
      bounds: calculateBounds(newPath),
    });
  },

  commitMove: (docWidth, docHeight) => {
    const state = get();
    if (!state.isMoving) return;

    // Regenerate mask from new path
    // Need to handle multiple contours for mask generation if we supported holes in pathToMask,
    // but pathToMask currently only takes SelectionPoint[].
    // Since we just translated the mask, we should ideally translate the bitmap or re-render.
    // For now, let's re-render all contours.
    // Optimization: composite multiple paths.

    // Create new mask
    const canvas = document.createElement('canvas');
    canvas.width = docWidth;
    canvas.height = docHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white';

    // Draw all contours
    ctx.beginPath();
    for (const contour of state.selectionPath) {
      if (contour.length > 0 && contour[0]) {
        ctx.moveTo(contour[0].x, contour[0].y);
        for (let i = 1; i < contour.length; i++) {
          const pt = contour[i];
          if (pt) {
            ctx.lineTo(pt.x, pt.y);
          }
        }
        ctx.closePath();
      }
    }
    // "evenodd" fill rule handles holes correctly if paths are oriented correctly,
    // or just filling them all if they are separate islands.
    // traceMaskToPaths usually returns islands. Holes might be tricky.
    // For now assume standard fill.
    ctx.fill('evenodd');

    const mask = ctx.getImageData(0, 0, docWidth, docHeight);

    set({
      selectionMask: mask,
      selectionMaskPending: false,
      selectionMaskBuildId: state.selectionMaskBuildId + 1,
      isMoving: false,
      moveStartPoint: null,
      originalPath: [],
      originalBounds: null,
    });
  },

  cancelMove: () => {
    const state = get();
    if (!state.isMoving) return;

    // Restore original path and bounds
    set({
      selectionPath: state.originalPath,
      bounds: state.originalBounds,
      isMoving: false,
      moveStartPoint: null,
      originalPath: [],
      originalBounds: null,
    });
  },

  getSelectionMaskForLayer: () => {
    const state = get();
    return state.hasSelection ? state.selectionMask : null;
  },

  createSnapshot: () => {
    const { hasSelection, selectionMask, selectionMaskPending, selectionPath, bounds } = get();
    return { hasSelection, selectionMask, selectionMaskPending, selectionPath, bounds };
  },

  applySnapshot: (snapshot) => {
    const hasSelection = snapshot?.hasSelection ?? false;
    set({
      hasSelection,
      selectionMask: hasSelection ? (snapshot?.selectionMask ?? null) : null,
      selectionMaskPending: false,
      selectionMaskBuildId: get().selectionMaskBuildId + 1,
      selectionPath: hasSelection ? (snapshot?.selectionPath ?? []) : [],
      bounds: hasSelection ? (snapshot?.bounds ?? null) : null,

      isCreating: false,
      creationPoints: [],
      previewPoint: null,
      creationStart: null,

      isMoving: false,
      moveStartPoint: null,
      originalPath: [],
      originalBounds: null,
    });
  },
}));
