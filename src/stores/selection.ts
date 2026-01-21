import { create } from 'zustand';

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
  selectionPath: SelectionPoint[]; // Vector path for marching ants
  bounds: SelectionBounds | null; // Selection bounding box

  // Interaction state
  isCreating: boolean; // Currently creating selection
  creationPoints: SelectionPoint[]; // Temporary points during creation
  creationStart: SelectionPoint | null; // Start point for rect selection
  selectionMode: SelectionMode; // Boolean operation mode
  lassoMode: LassoMode; // Lasso sub-mode

  // Rendering state
  featherRadius: number; // Feather radius in pixels
  marchingAntsOffset: number; // Animation offset for marching ants

  // Actions
  setSelectionMode: (mode: SelectionMode) => void;

  // Selection creation
  beginSelection: (startPoint?: SelectionPoint) => void;
  addCreationPoint: (point: SelectionPoint) => void;
  updateCreationRect: (start: SelectionPoint, end: SelectionPoint) => void;
  commitSelection: (documentWidth: number, documentHeight: number) => void;
  cancelSelection: () => void;

  // Selection operations
  selectAll: (width: number, height: number) => void;
  deselectAll: () => void;
  invertSelection: (width: number, height: number) => void;

  // Marching ants animation
  updateMarchingAnts: () => void;

  // Utility methods
  isPointInSelection: (x: number, y: number) => boolean;
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
      for (let i = 1; i < path.length; i++) {
        const pt = path[i];
        if (pt) {
          ctx.lineTo(pt.x, pt.y);
        }
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  return ctx.getImageData(0, 0, width, height);
}

/**
 * Calculate bounding box from path points
 */
function calculateBounds(path: SelectionPoint[]): SelectionBounds | null {
  if (path.length === 0) return null;

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  for (const pt of path) {
    minX = Math.min(minX, pt.x);
    minY = Math.min(minY, pt.y);
    maxX = Math.max(maxX, pt.x);
    maxY = Math.max(maxY, pt.y);
  }

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
  creationStart: null,
  selectionMode: 'new',
  lassoMode: 'freehand',

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
    })),

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
        creationStart: null,
      });
      return;
    }

    // Generate bitmap mask from path
    const mask = pathToMask(path, documentWidth, documentHeight);
    const bounds = calculateBounds(path);

    // TODO: Handle boolean operations (add/subtract/intersect) with existing selection

    set({
      hasSelection: true,
      selectionMask: mask,
      selectionPath: [...path], // Copy for marching ants
      bounds,
      isCreating: false,
      creationPoints: [],
      creationStart: null,
    });
  },

  cancelSelection: () =>
    set({
      isCreating: false,
      creationPoints: [],
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
      selectionPath: path,
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
      creationStart: null,
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

  getSelectionMaskForLayer: () => {
    const state = get();
    return state.hasSelection ? state.selectionMask : null;
  },
}));
