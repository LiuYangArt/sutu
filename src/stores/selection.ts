import { create } from 'zustand';
import { combineMasks, traceMaskToPaths } from '@/utils/selectionAlgorithms';

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
}

/** Selection bounding box */
export interface SelectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SelectionState {
  // Core selection data
  hasSelection: boolean;
  selectionMask: ImageData | null; // Bitmap mask (0-255 alpha)
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
}

/**
 * Convert a closed path to a bitmap mask using Canvas 2D fill
 */
function pathToMask(path: SelectionPoint[], width: number, height: number): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Fill the path
  ctx.fillStyle = 'white';
  ctx.beginPath();
  if (path.length > 0) {
    const first = path[0];
    if (first) {
      ctx.moveTo(first.x, first.y);

      // If we have enough points (heuristic for freehand), use smoothing
      // Rectangle has 5 points (start, 3 corners, start repeated), so > 6 is safe
      if (path.length > 6) {
        // Quadratic Bezier smoothing
        for (let i = 1; i < path.length - 2; i++) {
          const pt = path[i];
          const next = path[i + 1];
          if (pt && next) {
            const xc = (pt.x + next.x) / 2;
            const yc = (pt.y + next.y) / 2;
            ctx.quadraticCurveTo(pt.x, pt.y, xc, yc);
          }
        }
        // Connect last few points
        const secondLast = path[path.length - 2];
        const last = path[path.length - 1];
        if (secondLast && last) {
          ctx.quadraticCurveTo(secondLast.x, secondLast.y, last.x, last.y);
        }
      } else {
        // Standard straight lines for Rect / simple polygons
        for (let i = 1; i < path.length; i++) {
          const pt = path[i];
          if (pt) {
            ctx.lineTo(pt.x, pt.y);
          }
        }
      }

      ctx.closePath();
      ctx.fill();
    }
  }

  return ctx.getImageData(0, 0, width, height);
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

  return [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
    { x: x1, y: y1 },
  ];
}

export const useSelectionStore = create<SelectionState>()((set, get) => ({
  // Initial state
  hasSelection: false,
  selectionMask: null,
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

    // Generate bitmap mask from path
    const newMask = pathToMask(path, documentWidth, documentHeight);

    let finalMask: ImageData;
    let finalPath: SelectionPoint[][];

    // Handle boolean operations
    if (state.selectionMode === 'new' || !state.hasSelection || !state.selectionMask) {
      finalMask = newMask;
      // For new selection, we can keep the original smooth path (wrapped in array of paths)
      // or trace it to be consistent. Let's keep original for smoothness in 'new' mode.
      finalPath = [path];
    } else {
      // Combine masks
      finalMask = combineMasks(state.selectionMask, newMask, state.selectionMode);
      // Regenerate path from the combined mask
      finalPath = traceMaskToPaths(finalMask);
    }

    const bounds = calculateBounds(finalPath);
    const hasSelection = finalPath.length > 0 && !!bounds;

    set({
      hasSelection,
      selectionMask: hasSelection ? finalMask : null,
      selectionPath: hasSelection ? finalPath : [],
      bounds: hasSelection ? bounds : null,
      isCreating: false,
      creationPoints: [],
      previewPoint: null, // Clear preview point
      creationStart: null,
    });
  },

  cancelSelection: () =>
    set({
      isCreating: false,
      creationPoints: [],
      previewPoint: null, // Clear preview point
      creationStart: null,
    }),

  selectAll: (width, height) => {
    const path = [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ];
    const mask = pathToMask(path, width, height);

    set({
      hasSelection: true,
      selectionMask: mask,
      selectionPath: [path],
      bounds: { x: 0, y: 0, width, height },
    });
  },

  deselectAll: () =>
    set({
      hasSelection: false,
      selectionMask: null,
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
    }),

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
    if (!state.selectionMask || !state.hasSelection) return true; // No selection = all allowed

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
}));
