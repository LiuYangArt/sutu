import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

// Types
export interface Layer {
  id: string;
  name: string;
  type: 'raster' | 'group' | 'adjustment';
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: BlendMode;
  parent?: string;
  children?: string[];
  thumbnail?: string; // Data URL
  isBackground?: boolean; // Background layer cannot be erased to transparency
}

export type BlendMode =
  | 'normal'
  | 'dissolve'
  | 'darken'
  | 'multiply'
  | 'color-burn'
  | 'linear-burn'
  | 'darker-color'
  | 'lighten'
  | 'screen'
  | 'color-dodge'
  | 'linear-dodge'
  | 'lighter-color'
  | 'overlay'
  | 'soft-light'
  | 'hard-light'
  | 'vivid-light'
  | 'linear-light'
  | 'pin-light'
  | 'hard-mix'
  | 'difference'
  | 'exclusion'
  | 'subtract'
  | 'divide'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export type FileFormat = 'ora' | 'tiff' | 'psd';

export type CanvasAnchor =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'center'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right';

export type ResampleMode = 'nearest' | 'bilinear' | 'bicubic';

export interface ResizeCanvasOptions {
  width: number;
  height: number;
  anchor: CanvasAnchor;
  scaleContent: boolean;
  extensionColor: string;
  resampleMode: ResampleMode;
}

export type NewDocumentBackgroundPreset = 'transparent' | 'white' | 'black' | 'current-bg';

export interface NewDocumentBackgroundConfig {
  preset: NewDocumentBackgroundPreset;
  fillColor?: string;
}

interface DocumentState {
  // Document properties
  width: number;
  height: number;
  dpi: number;
  backgroundFillColor: string;

  // Internal: only user-triggered layer adds should be recorded in history
  pendingHistoryLayerAdds: string[];

  // File management
  filePath: string | null;
  fileFormat: FileFormat | null;
  isDirty: boolean;

  // Layers
  layers: Layer[];
  activeLayerId: string | null;
  selectedLayerIds: string[];
  layerSelectionAnchorId: string | null;

  // Actions
  initDocument: (config: {
    width: number;
    height: number;
    dpi: number;
    background?: NewDocumentBackgroundConfig;
  }) => void;
  reset: () => void;
  resizeCanvas: (options: ResizeCanvasOptions) => void;

  // Layer actions
  addLayer: (config: { name: string; type: Layer['type'] }) => void;
  removeLayer: (id: string) => void;
  duplicateLayer: (id: string) => string | null; // Returns new layer ID
  setActiveLayer: (id: string) => void;
  setLayerSelection: (ids: string[], activeId?: string | null, anchorId?: string | null) => void;
  clearLayerSelection: () => void;
  toggleLayerVisibility: (id: string) => void;
  toggleLayerLock: (id: string) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  setLayerBlendMode: (id: string, blendMode: BlendMode) => void;
  renameLayer: (id: string, name: string) => void;
  updateLayerThumbnail: (id: string, thumbnail: string) => void;
  moveLayer: (id: string, toIndex: number) => void;
  moveLayers: (ids: string[], toIndex: number) => void;

  // File management actions
  setFilePath: (path: string | null, format: FileFormat | null) => void;
  setDirty: (dirty: boolean) => void;
  markDirty: () => void;

  // Internal helpers
  consumePendingHistoryLayerAdd: (id: string) => boolean;
}

// Helper to generate unique IDs
const generateId = () => `layer_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

// Initial state
const initialState = {
  width: 4000,
  height: 3000,
  dpi: 72,
  backgroundFillColor: '#ffffff',
  pendingHistoryLayerAdds: [] as string[],
  filePath: null as string | null,
  fileFormat: null as FileFormat | null,
  isDirty: false,
  layers: [] as Layer[],
  activeLayerId: null as string | null,
  selectedLayerIds: [] as string[],
  layerSelectionAnchorId: null as string | null,
};

export const useDocumentStore = create<DocumentState>()(
  immer((set, get) => ({
    ...initialState,

    initDocument: (config) =>
      set((state) => {
        state.width = config.width;
        state.height = config.height;
        state.dpi = config.dpi;
        state.filePath = null;
        state.fileFormat = null;
        state.isDirty = false;

        state.pendingHistoryLayerAdds = [];

        const preset = config.background?.preset ?? 'white';
        if (preset === 'transparent') {
          const layer: Layer = {
            id: generateId(),
            name: 'Layer 1',
            type: 'raster',
            visible: true,
            locked: false,
            opacity: 100,
            blendMode: 'normal',
            isBackground: false,
          };
          state.backgroundFillColor = '#ffffff';
          state.layers = [layer];
          state.activeLayerId = layer.id;
          state.selectedLayerIds = [layer.id];
          state.layerSelectionAnchorId = layer.id;
          return;
        }

        const fillColor = config.background?.fillColor ?? '#ffffff';
        state.backgroundFillColor = fillColor;

        const bgLayer: Layer = {
          id: generateId(),
          name: 'Background',
          type: 'raster',
          visible: true,
          locked: false,
          opacity: 100,
          blendMode: 'normal',
          isBackground: true,
        };

        state.layers = [bgLayer];
        state.activeLayerId = bgLayer.id;
        state.selectedLayerIds = [bgLayer.id];
        state.layerSelectionAnchorId = bgLayer.id;
      }),

    reset: () => set(initialState),

    resizeCanvas: (options) => {
      const win = window as Window & {
        __canvasResize?: (opts: ResizeCanvasOptions) => void;
      };
      win.__canvasResize?.(options);
    },

    addLayer: (config) =>
      set((state) => {
        const newLayer: Layer = {
          id: generateId(),
          name: config.name,
          type: config.type,
          visible: true,
          locked: false,
          opacity: 100,
          blendMode: 'normal',
        };

        state.layers.push(newLayer);
        state.activeLayerId = newLayer.id;
        state.selectedLayerIds = [newLayer.id];
        state.layerSelectionAnchorId = newLayer.id;
        state.pendingHistoryLayerAdds.push(newLayer.id);
        state.isDirty = true;
      }),

    removeLayer: (id) =>
      set((state) => {
        const index = state.layers.findIndex((l) => l.id === id);
        if (index === -1) return;

        state.layers.splice(index, 1);

        // Update active layer if needed
        if (state.activeLayerId === id) {
          if (state.layers.length > 0) {
            // Select the layer above, or the last layer
            const newIndex = Math.min(index, state.layers.length - 1);
            state.activeLayerId = state.layers[newIndex]?.id ?? null;
          } else {
            state.activeLayerId = null;
          }
        }

        const nextSelected = state.selectedLayerIds.filter((layerId) =>
          state.layers.some((layer) => layer.id === layerId)
        );

        if (state.activeLayerId) {
          if (nextSelected.length === 0 || !nextSelected.includes(state.activeLayerId)) {
            state.selectedLayerIds = [state.activeLayerId];
          } else {
            state.selectedLayerIds = nextSelected;
          }
          if (
            !state.layerSelectionAnchorId ||
            !state.selectedLayerIds.includes(state.layerSelectionAnchorId)
          ) {
            state.layerSelectionAnchorId = state.activeLayerId;
          }
        } else {
          state.selectedLayerIds = [];
          state.layerSelectionAnchorId = null;
        }

        state.isDirty = true;
      }),

    duplicateLayer: (id) => {
      let newLayerId: string | null = null;
      set((state) => {
        const index = state.layers.findIndex((l) => l.id === id);
        if (index === -1) return;

        const original = state.layers[index];
        if (!original) return;

        newLayerId = generateId();
        const duplicated: Layer = {
          ...original,
          id: newLayerId,
          name: `${original.name} copy`,
          isBackground: false, // Duplicated layer is never a background layer
          thumbnail: original.thumbnail,
        };

        // Insert after the original layer
        state.layers.splice(index + 1, 0, duplicated);
        state.activeLayerId = newLayerId;
        state.selectedLayerIds = [newLayerId];
        state.layerSelectionAnchorId = newLayerId;
        state.pendingHistoryLayerAdds.push(newLayerId);
        state.isDirty = true;
      });
      return newLayerId;
    },

    setActiveLayer: (id) =>
      set((state) => {
        const exists = state.layers.some((layer) => layer.id === id);
        if (!exists) return;
        state.activeLayerId = id;
        state.selectedLayerIds = [id];
        state.layerSelectionAnchorId = id;
      }),

    setLayerSelection: (ids, activeId, anchorId) =>
      set((state) => {
        const existingIds = Array.from(
          new Set(ids.filter((id) => state.layers.some((layer) => layer.id === id)))
        );

        if (existingIds.length === 0) {
          const fallbackActive =
            (activeId && state.layers.some((layer) => layer.id === activeId) && activeId) ||
            state.activeLayerId;
          state.selectedLayerIds = [];
          state.activeLayerId = fallbackActive ?? null;
          state.layerSelectionAnchorId =
            (anchorId && state.layers.some((layer) => layer.id === anchorId) && anchorId) ||
            fallbackActive ||
            null;
          return;
        }

        const resolvedActive =
          (activeId && existingIds.includes(activeId) && activeId) ||
          state.activeLayerId ||
          existingIds[existingIds.length - 1]!;
        const safeActive = existingIds.includes(resolvedActive)
          ? resolvedActive
          : existingIds[existingIds.length - 1]!;
        const safeAnchor =
          (anchorId && existingIds.includes(anchorId) && anchorId) ||
          (state.layerSelectionAnchorId &&
            existingIds.includes(state.layerSelectionAnchorId) &&
            state.layerSelectionAnchorId) ||
          safeActive;

        state.selectedLayerIds = existingIds;
        state.activeLayerId = safeActive;
        state.layerSelectionAnchorId = safeAnchor;
      }),

    clearLayerSelection: () =>
      set((state) => {
        state.selectedLayerIds = [];
        state.layerSelectionAnchorId = null;
      }),

    toggleLayerVisibility: (id) =>
      set((state) => {
        const layer = state.layers.find((l) => l.id === id);
        if (layer) {
          layer.visible = !layer.visible;
          state.isDirty = true;
        }
      }),

    toggleLayerLock: (id) =>
      set((state) => {
        const layer = state.layers.find((l) => l.id === id);
        if (layer) {
          layer.locked = !layer.locked;
          state.isDirty = true;
        }
      }),

    setLayerOpacity: (id, opacity) =>
      set((state) => {
        const layer = state.layers.find((l) => l.id === id);
        if (layer) {
          layer.opacity = Math.max(0, Math.min(100, opacity));
          state.isDirty = true;
        }
      }),

    setLayerBlendMode: (id, blendMode) =>
      set((state) => {
        const layer = state.layers.find((l) => l.id === id);
        if (layer) {
          layer.blendMode = blendMode;
          state.isDirty = true;
        }
      }),

    renameLayer: (id, name) =>
      set((state) => {
        const layer = state.layers.find((l) => l.id === id);
        if (layer) {
          layer.name = name;
          state.isDirty = true;
        }
      }),

    updateLayerThumbnail: (id, thumbnail) =>
      set((state) => {
        const layer = state.layers.find((l) => l.id === id);
        if (layer) {
          layer.thumbnail = thumbnail;
        }
      }),

    moveLayer: (id, toIndex) =>
      set((state) => {
        const fromIndex = state.layers.findIndex((l) => l.id === id);
        if (fromIndex === -1 || fromIndex === toIndex) return;

        const [layer] = state.layers.splice(fromIndex, 1);
        if (layer) {
          state.layers.splice(toIndex, 0, layer);
          state.isDirty = true;
        }
      }),

    moveLayers: (ids, toIndex) =>
      set((state) => {
        const uniqueIds = Array.from(
          new Set(ids.filter((id) => state.layers.some((layer) => layer.id === id)))
        );
        if (uniqueIds.length === 0) return;

        const movingIndexList = uniqueIds
          .map((id) => state.layers.findIndex((layer) => layer.id === id))
          .filter((index) => index >= 0)
          .sort((a, b) => a - b);
        if (movingIndexList.length === 0) return;

        const firstIndex = movingIndexList[0]!;
        const lastIndex = movingIndexList[movingIndexList.length - 1]!;
        const clampedOriginalIndex = Math.max(0, Math.min(toIndex, state.layers.length));
        if (clampedOriginalIndex >= firstIndex && clampedOriginalIndex <= lastIndex + 1) return;

        const movingIdSet = new Set(movingIndexList.map((index) => state.layers[index]!.id));
        const movingLayers = state.layers.filter((layer) => movingIdSet.has(layer.id));
        const remainingLayers = state.layers.filter((layer) => !movingIdSet.has(layer.id));

        const removedBeforeTarget = movingIndexList.filter(
          (index) => index < clampedOriginalIndex
        ).length;
        const insertIndex = Math.max(
          0,
          Math.min(clampedOriginalIndex - removedBeforeTarget, remainingLayers.length)
        );

        remainingLayers.splice(insertIndex, 0, ...movingLayers);
        state.layers = remainingLayers;
        state.isDirty = true;
      }),

    // File management actions
    setFilePath: (path, format) =>
      set((state) => {
        state.filePath = path;
        state.fileFormat = format;
        if (path) {
          state.isDirty = false;
        }
      }),

    setDirty: (dirty) =>
      set((state) => {
        state.isDirty = dirty;
      }),

    markDirty: () =>
      set((state) => {
        state.isDirty = true;
      }),

    consumePendingHistoryLayerAdd: (id) => {
      const idx = get().pendingHistoryLayerAdds.indexOf(id);
      if (idx === -1) return false;
      set((state) => {
        state.pendingHistoryLayerAdds.splice(idx, 1);
      });
      return true;
    },
  }))
);
