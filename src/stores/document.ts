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
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

interface DocumentState {
  // Document properties
  width: number;
  height: number;
  dpi: number;

  // Layers
  layers: Layer[];
  activeLayerId: string | null;

  // Actions
  initDocument: (config: { width: number; height: number; dpi: number }) => void;
  reset: () => void;

  // Layer actions
  addLayer: (config: { name: string; type: Layer['type'] }) => void;
  removeLayer: (id: string) => void;
  duplicateLayer: (id: string) => string | null; // Returns new layer ID
  setActiveLayer: (id: string) => void;
  toggleLayerVisibility: (id: string) => void;
  toggleLayerLock: (id: string) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  setLayerBlendMode: (id: string, blendMode: BlendMode) => void;
  renameLayer: (id: string, name: string) => void;
  updateLayerThumbnail: (id: string, thumbnail: string) => void;
  moveLayer: (id: string, toIndex: number) => void;
}

// Helper to generate unique IDs
const generateId = () => `layer_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

// Initial state
const initialState = {
  width: 1920,
  height: 1080,
  dpi: 72,
  layers: [] as Layer[],
  activeLayerId: null as string | null,
};

export const useDocumentStore = create<DocumentState>()(
  immer((set) => ({
    ...initialState,

    initDocument: (config) =>
      set((state) => {
        state.width = config.width;
        state.height = config.height;
        state.dpi = config.dpi;

        // Create default background layer
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
      }),

    reset: () => set(initialState),

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
          name: `${original.name} Copy`,
          isBackground: false, // Duplicated layer is never a background layer
          thumbnail: original.thumbnail,
        };

        // Insert after the original layer
        state.layers.splice(index + 1, 0, duplicated);
        state.activeLayerId = newLayerId;
      });
      return newLayerId;
    },

    setActiveLayer: (id) =>
      set((state) => {
        state.activeLayerId = id;
      }),

    toggleLayerVisibility: (id) =>
      set((state) => {
        const layer = state.layers.find((l) => l.id === id);
        if (layer) {
          layer.visible = !layer.visible;
        }
      }),

    toggleLayerLock: (id) =>
      set((state) => {
        const layer = state.layers.find((l) => l.id === id);
        if (layer) {
          layer.locked = !layer.locked;
        }
      }),

    setLayerOpacity: (id, opacity) =>
      set((state) => {
        const layer = state.layers.find((l) => l.id === id);
        if (layer) {
          layer.opacity = Math.max(0, Math.min(100, opacity));
        }
      }),

    setLayerBlendMode: (id, blendMode) =>
      set((state) => {
        const layer = state.layers.find((l) => l.id === id);
        if (layer) {
          layer.blendMode = blendMode;
        }
      }),

    renameLayer: (id, name) =>
      set((state) => {
        const layer = state.layers.find((l) => l.id === id);
        if (layer) {
          layer.name = name;
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
        }
      }),
  }))
);
