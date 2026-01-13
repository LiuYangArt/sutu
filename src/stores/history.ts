import { create } from 'zustand';
import { Layer } from './document';

/**
 * History entry types for unified timeline
 */
export type HistoryEntry = StrokeEntry | AddLayerEntry | RemoveLayerEntry;

interface StrokeEntry {
  type: 'stroke';
  layerId: string;
  beforeImage: ImageData;
  afterImage?: ImageData; // Filled during undo, used for redo
  timestamp: number;
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

interface HistoryState {
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  maxHistorySize: number;

  // Push stroke operation (with beforeImage)
  pushStroke: (layerId: string, beforeImage: ImageData) => void;

  // Push layer add operation
  pushAddLayer: (layerId: string, layerMeta: Layer, layerIndex: number) => void;

  // Push layer remove operation
  pushRemoveLayer: (
    layerId: string,
    layerMeta: Layer,
    layerIndex: number,
    imageData: ImageData
  ) => void;

  // Undo/Redo
  undo: () => HistoryEntry | null;
  redo: () => HistoryEntry | null;
  canUndo: () => boolean;
  canRedo: () => boolean;
  clear: () => void;
}

// Clone ImageData to avoid reference issues
function cloneImageData(imageData: ImageData): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to create canvas context');

  ctx.putImageData(imageData, 0, 0);
  return ctx.getImageData(0, 0, imageData.width, imageData.height);
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  undoStack: [],
  redoStack: [],
  maxHistorySize: 50,

  pushStroke: (layerId: string, beforeImage: ImageData) => {
    const { undoStack, maxHistorySize } = get();

    const entry: StrokeEntry = {
      type: 'stroke',
      layerId,
      beforeImage: cloneImageData(beforeImage),
      timestamp: Date.now(),
    };

    const newUndoStack = [...undoStack, entry];
    if (newUndoStack.length > maxHistorySize) {
      newUndoStack.shift();
    }

    set({
      undoStack: newUndoStack,
      redoStack: [],
    });
  },

  pushAddLayer: (layerId: string, layerMeta: Layer, layerIndex: number) => {
    const { undoStack, maxHistorySize } = get();

    const entry: AddLayerEntry = {
      type: 'addLayer',
      layerId,
      layerMeta: { ...layerMeta },
      layerIndex,
      timestamp: Date.now(),
    };

    const newUndoStack = [...undoStack, entry];
    if (newUndoStack.length > maxHistorySize) {
      newUndoStack.shift();
    }

    set({
      undoStack: newUndoStack,
      redoStack: [],
    });
  },

  pushRemoveLayer: (
    layerId: string,
    layerMeta: Layer,
    layerIndex: number,
    imageData: ImageData
  ) => {
    const { undoStack, maxHistorySize } = get();

    const entry: RemoveLayerEntry = {
      type: 'removeLayer',
      layerId,
      layerMeta: { ...layerMeta },
      layerIndex,
      imageData: cloneImageData(imageData),
      timestamp: Date.now(),
    };

    const newUndoStack = [...undoStack, entry];
    if (newUndoStack.length > maxHistorySize) {
      newUndoStack.shift();
    }

    set({
      undoStack: newUndoStack,
      redoStack: [],
    });
  },

  undo: () => {
    const { undoStack, redoStack } = get();

    if (undoStack.length === 0) {
      return null;
    }

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

    if (redoStack.length === 0) {
      return null;
    }

    const entry = redoStack[redoStack.length - 1];
    if (!entry) return null;

    set({
      undoStack: [...undoStack, entry],
      redoStack: redoStack.slice(0, -1),
    });

    return entry;
  },

  canUndo: () => {
    return get().undoStack.length > 0;
  },

  canRedo: () => {
    return get().redoStack.length > 0;
  },

  clear: () => {
    set({
      undoStack: [],
      redoStack: [],
    });
  },
}));
