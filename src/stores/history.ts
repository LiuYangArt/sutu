import { create } from 'zustand';
import { Layer } from './document';
import type { SelectionSnapshot } from './selection';

/**
 * History entry types for unified timeline
 */
export type HistoryEntry =
  | StrokeEntry
  | AddLayerEntry
  | RemoveLayerEntry
  | ResizeCanvasEntry
  | SelectionEntry;

export type StrokeSnapshotMode = 'cpu' | 'gpu';

export interface StrokeEntry {
  type: 'stroke';
  layerId: string;
  entryId: string;
  snapshotMode: StrokeSnapshotMode;
  beforeImage?: ImageData;
  afterImage?: ImageData; // Filled during undo, used for redo
  timestamp: number;
}

export interface PushStrokeParams {
  layerId: string;
  entryId: string;
  snapshotMode: StrokeSnapshotMode;
  beforeImage?: ImageData;
}

interface AddLayerEntry {
  type: 'addLayer';
  layerId: string;
  layerMeta: Layer;
  layerIndex: number;
  timestamp: number;
}

interface RemoveLayerEntry {
  type: 'removeLayer';
  layerId: string;
  layerMeta: Layer;
  layerIndex: number;
  imageData: ImageData;
  timestamp: number;
}

interface ResizeCanvasLayerSnapshot {
  layerId: string;
  imageData: ImageData;
}

interface ResizeCanvasEntry {
  type: 'resizeCanvas';
  beforeWidth: number;
  beforeHeight: number;
  beforeLayers: ResizeCanvasLayerSnapshot[];
  after?: { width: number; height: number; layers: ResizeCanvasLayerSnapshot[] };
  timestamp: number;
}

interface SelectionEntry {
  type: 'selection';
  before: SelectionSnapshot;
  after?: SelectionSnapshot; // Filled during undo, used for redo
  timestamp: number;
}

interface HistoryState {
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  maxHistorySize: number;

  // Push stroke operation (CPU/GPU dual-track snapshots)
  pushStroke: (params: PushStrokeParams) => void;

  // Push layer add operation
  pushAddLayer: (layerId: string, layerMeta: Layer, layerIndex: number) => void;

  // Push layer remove operation
  pushRemoveLayer: (
    layerId: string,
    layerMeta: Layer,
    layerIndex: number,
    imageData: ImageData
  ) => void;

  // Push canvas resize operation (with full layer snapshots)
  pushResizeCanvas: (
    beforeWidth: number,
    beforeHeight: number,
    beforeLayers: ResizeCanvasLayerSnapshot[]
  ) => void;

  // Push selection change operation (stores immutable snapshot references)
  pushSelection: (before: SelectionSnapshot) => void;

  // Undo/Redo
  undo: () => HistoryEntry | null;
  redo: () => HistoryEntry | null;
  canUndo: () => boolean;
  canRedo: () => boolean;
  clear: () => void;
}

// Clone ImageData to avoid reference issues
function cloneImageData(imageData: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
}

function cloneLayerSnapshots(layers: ResizeCanvasLayerSnapshot[]): ResizeCanvasLayerSnapshot[] {
  return layers.map((l) => ({ layerId: l.layerId, imageData: cloneImageData(l.imageData) }));
}

export function createHistoryEntryId(prefix: string = 'stroke'): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${random}`;
}

export const useHistoryStore = create<HistoryState>((set, get) => {
  // Helper to push entry and manage stack size
  function pushEntry(entry: HistoryEntry) {
    const { undoStack, maxHistorySize } = get();
    const newStack = [...undoStack, entry];
    if (newStack.length > maxHistorySize) newStack.shift();
    set({ undoStack: newStack, redoStack: [] });
  }

  return {
    undoStack: [],
    redoStack: [],
    maxHistorySize: 50,

    pushStroke: ({ layerId, entryId, snapshotMode, beforeImage }) => {
      if (snapshotMode === 'cpu' && !beforeImage) {
        console.warn('[HistoryStore] Missing beforeImage for CPU stroke entry', {
          layerId,
          entryId,
        });
        return;
      }
      pushEntry({
        type: 'stroke',
        layerId,
        entryId,
        snapshotMode,
        beforeImage: beforeImage ? cloneImageData(beforeImage) : undefined,
        timestamp: Date.now(),
      });
    },

    pushAddLayer: (layerId, layerMeta, layerIndex) => {
      pushEntry({
        type: 'addLayer',
        layerId,
        layerMeta: { ...layerMeta },
        layerIndex,
        timestamp: Date.now(),
      });
    },

    pushRemoveLayer: (layerId, layerMeta, layerIndex, imageData) => {
      pushEntry({
        type: 'removeLayer',
        layerId,
        layerMeta: { ...layerMeta },
        layerIndex,
        imageData: cloneImageData(imageData),
        timestamp: Date.now(),
      });
    },

    pushResizeCanvas: (beforeWidth, beforeHeight, beforeLayers) => {
      pushEntry({
        type: 'resizeCanvas',
        beforeWidth,
        beforeHeight,
        beforeLayers: cloneLayerSnapshots(beforeLayers),
        timestamp: Date.now(),
      });
    },

    pushSelection: (before) => {
      pushEntry({
        type: 'selection',
        before,
        timestamp: Date.now(),
      });
    },

    undo: () => {
      const { undoStack, redoStack } = get();
      if (undoStack.length === 0) return null;

      const entry = undoStack[undoStack.length - 1];
      if (!entry) return null;

      set({
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, entry],
      });
      return entry;
    },

    redo: () => {
      const { undoStack, redoStack } = get();
      if (redoStack.length === 0) return null;

      const entry = redoStack[redoStack.length - 1];
      if (!entry) return null;

      set({
        undoStack: [...undoStack, entry],
        redoStack: redoStack.slice(0, -1),
      });
      return entry;
    },

    canUndo: () => get().undoStack.length > 0,
    canRedo: () => get().redoStack.length > 0,

    clear: () => {
      set({ undoStack: [], redoStack: [] });
    },
  };
});
