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
  | RemoveLayersEntry
  | MergeLayersEntry
  | LayerPropsEntry
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
  selectionBefore?: SelectionSnapshot;
  selectionAfter?: SelectionSnapshot;
  timestamp: number;
}

export interface PushStrokeParams {
  layerId: string;
  entryId: string;
  snapshotMode: StrokeSnapshotMode;
  beforeImage?: ImageData;
  selectionBefore?: SelectionSnapshot;
  selectionAfter?: SelectionSnapshot;
}

interface AddLayerEntry {
  type: 'addLayer';
  layerId: string;
  layerMeta: Layer;
  layerIndex: number;
  imageData?: ImageData;
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

interface LayerSelectionStateSnapshot {
  activeLayerId: string | null;
  selectedLayerIds: string[];
  layerSelectionAnchorId: string | null;
}

interface RemovedLayerSnapshot {
  layerId: string;
  layerMeta: Layer;
  layerIndex: number;
  imageData: ImageData;
}

interface RemoveLayersEntry {
  type: 'removeLayers';
  layers: RemovedLayerSnapshot[];
  beforeSelection: LayerSelectionStateSnapshot;
  afterSelection: LayerSelectionStateSnapshot;
  timestamp: number;
}

interface MergeLayersEntry {
  type: 'mergeLayers';
  targetLayerId: string;
  targetBeforeMeta: Layer;
  targetAfterMeta: Layer;
  targetBeforeImage: ImageData;
  targetAfterImage: ImageData;
  removedLayers: RemovedLayerSnapshot[];
  beforeOrder: string[];
  afterOrder: string[];
  beforeSelection: LayerSelectionStateSnapshot;
  afterSelection: LayerSelectionStateSnapshot;
  timestamp: number;
}

export interface LayerPropsChange {
  layerId: string;
  beforeOpacity: number;
  beforeBlendMode: Layer['blendMode'];
  afterOpacity: number;
  afterBlendMode: Layer['blendMode'];
}

interface LayerPropsEntry {
  type: 'layerProps';
  changes: LayerPropsChange[];
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
  patchAddLayerImage: (layerId: string, imageData: ImageData) => void;

  // Push layer remove operation
  pushRemoveLayer: (
    layerId: string,
    layerMeta: Layer,
    layerIndex: number,
    imageData: ImageData
  ) => void;
  pushRemoveLayers: (
    layers: RemovedLayerSnapshot[],
    beforeSelection: LayerSelectionStateSnapshot,
    afterSelection: LayerSelectionStateSnapshot
  ) => void;

  pushMergeLayers: (params: {
    targetLayerId: string;
    targetBeforeMeta: Layer;
    targetAfterMeta: Layer;
    targetBeforeImage: ImageData;
    targetAfterImage: ImageData;
    removedLayers: RemovedLayerSnapshot[];
    beforeOrder: string[];
    afterOrder: string[];
    beforeSelection: LayerSelectionStateSnapshot;
    afterSelection: LayerSelectionStateSnapshot;
  }) => void;
  pushLayerProps: (changes: LayerPropsChange[]) => void;

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

function cloneRemovedLayerSnapshot(layer: RemovedLayerSnapshot): RemovedLayerSnapshot {
  return {
    layerId: layer.layerId,
    layerMeta: { ...layer.layerMeta },
    layerIndex: layer.layerIndex,
    imageData: cloneImageData(layer.imageData),
  };
}

function cloneLayerSelectionState(
  selection: LayerSelectionStateSnapshot
): LayerSelectionStateSnapshot {
  return {
    activeLayerId: selection.activeLayerId,
    selectedLayerIds: [...selection.selectedLayerIds],
    layerSelectionAnchorId: selection.layerSelectionAnchorId,
  };
}

function cloneLayerPropsChange(change: LayerPropsChange): LayerPropsChange {
  return {
    layerId: change.layerId,
    beforeOpacity: change.beforeOpacity,
    beforeBlendMode: change.beforeBlendMode,
    afterOpacity: change.afterOpacity,
    afterBlendMode: change.afterBlendMode,
  };
}

function hasSameLayerPropsTargets(a: LayerPropsChange[], b: LayerPropsChange[]): boolean {
  if (a.length !== b.length) return false;
  const targetMap = new Set<string>();
  for (const change of a) {
    targetMap.add(change.layerId);
  }
  for (const change of b) {
    if (!targetMap.has(change.layerId)) return false;
  }
  return true;
}

function isOpacityOnlyLayerProps(changes: LayerPropsChange[]): boolean {
  return changes.every((change) => change.beforeBlendMode === change.afterBlendMode);
}

function mergeOpacityOnlyLayerPropsChanges(
  previous: LayerPropsChange[],
  next: LayerPropsChange[]
): LayerPropsChange[] {
  const nextByLayerId = new Map(next.map((change) => [change.layerId, change]));
  return previous.map((prevChange) => {
    const nextChange = nextByLayerId.get(prevChange.layerId);
    if (!nextChange) return cloneLayerPropsChange(prevChange);
    return {
      layerId: prevChange.layerId,
      beforeOpacity: prevChange.beforeOpacity,
      beforeBlendMode: prevChange.beforeBlendMode,
      afterOpacity: nextChange.afterOpacity,
      afterBlendMode: nextChange.afterBlendMode,
    };
  });
}

function canMergeLayerPropsEntry(
  previousEntry: LayerPropsEntry,
  nextChanges: LayerPropsChange[]
): boolean {
  return (
    isOpacityOnlyLayerProps(previousEntry.changes) &&
    isOpacityOnlyLayerProps(nextChanges) &&
    hasSameLayerPropsTargets(previousEntry.changes, nextChanges)
  );
}

function createLayerPropsEntry(changes: LayerPropsChange[], timestamp: number): LayerPropsEntry {
  return {
    type: 'layerProps',
    changes,
    timestamp,
  };
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

    pushStroke: ({
      layerId,
      entryId,
      snapshotMode,
      beforeImage,
      selectionBefore,
      selectionAfter,
    }) => {
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
        selectionBefore,
        selectionAfter,
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

    patchAddLayerImage: (layerId, imageData) => {
      const cloned = cloneImageData(imageData);
      const patchEntry = (entry: HistoryEntry): HistoryEntry => {
        if (entry.type !== 'addLayer' || entry.layerId !== layerId) {
          return entry;
        }
        return {
          ...entry,
          imageData: cloneImageData(cloned),
        };
      };

      set((state) => ({
        undoStack: state.undoStack.map(patchEntry),
        redoStack: state.redoStack.map(patchEntry),
      }));
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

    pushRemoveLayers: (layers, beforeSelection, afterSelection) => {
      if (layers.length === 0) return;
      pushEntry({
        type: 'removeLayers',
        layers: layers.map(cloneRemovedLayerSnapshot),
        beforeSelection: cloneLayerSelectionState(beforeSelection),
        afterSelection: cloneLayerSelectionState(afterSelection),
        timestamp: Date.now(),
      });
    },

    pushMergeLayers: ({
      targetLayerId,
      targetBeforeMeta,
      targetAfterMeta,
      targetBeforeImage,
      targetAfterImage,
      removedLayers,
      beforeOrder,
      afterOrder,
      beforeSelection,
      afterSelection,
    }) => {
      pushEntry({
        type: 'mergeLayers',
        targetLayerId,
        targetBeforeMeta: { ...targetBeforeMeta },
        targetAfterMeta: { ...targetAfterMeta },
        targetBeforeImage: cloneImageData(targetBeforeImage),
        targetAfterImage: cloneImageData(targetAfterImage),
        removedLayers: removedLayers.map(cloneRemovedLayerSnapshot),
        beforeOrder: [...beforeOrder],
        afterOrder: [...afterOrder],
        beforeSelection: cloneLayerSelectionState(beforeSelection),
        afterSelection: cloneLayerSelectionState(afterSelection),
        timestamp: Date.now(),
      });
    },

    pushLayerProps: (changes) => {
      if (changes.length === 0) return;
      const nextChanges = changes.map(cloneLayerPropsChange);
      const now = Date.now();
      set((state) => {
        const lastEntry = state.undoStack[state.undoStack.length - 1];
        if (lastEntry?.type === 'layerProps' && canMergeLayerPropsEntry(lastEntry, nextChanges)) {
          const mergedEntry = createLayerPropsEntry(
            mergeOpacityOnlyLayerPropsChanges(lastEntry.changes, nextChanges),
            now
          );
          const newUndoStack = [...state.undoStack];
          newUndoStack[newUndoStack.length - 1] = mergedEntry;
          return {
            undoStack: newUndoStack,
            redoStack: [],
          };
        }

        const newUndoStack = [...state.undoStack, createLayerPropsEntry(nextChanges, now)];
        if (newUndoStack.length > state.maxHistorySize) {
          newUndoStack.shift();
        }
        return {
          undoStack: newUndoStack,
          redoStack: [],
        };
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
