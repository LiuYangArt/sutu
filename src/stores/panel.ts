import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

// Restore PanelGeometry definition
export interface PanelGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelAlignment {
  horizontal: 'left' | 'right';
  vertical: 'top' | 'bottom';
  offsetX: number; // Distance from horizontal edge
  offsetY: number; // Distance from vertical edge
}

export interface PanelState extends PanelGeometry {
  id: string;
  isOpen: boolean;
  isCollapsed: boolean;
  zIndex: number;
  alignment?: PanelAlignment;
}

export interface PanelConfig {
  id: string;
  title: string;
  defaultGeometry: PanelGeometry; // Keeping for backward compat or initial calc
  defaultAlignment?: PanelAlignment;
  minWidth?: number;
  minHeight?: number;
}

interface PanelStoreState {
  // Configs are static registry
  configs: Record<string, PanelConfig>;
  // States are dynamic and persisted
  panels: Record<string, PanelState>;
  activeId: string | null;
  maxZIndex: number;

  registerPanel: (config: PanelConfig) => void;
  openPanel: (id: string) => void;
  closePanel: (id: string) => void;
  togglePanel: (id: string) => void;
  minimizePanel: (id: string, isCollapsed?: boolean) => void;
  updateGeometry: (id: string, geometry: Partial<PanelGeometry>) => void;
  updateAlignment: (id: string, alignment: PanelAlignment) => void;
  bringToFront: (id: string) => void;
}

export const usePanelStore = create<PanelStoreState>()(
  persist(
    immer((set) => ({
      configs: {},
      panels: {},
      activeId: null,
      maxZIndex: 100,

      registerPanel: (config) =>
        set((state) => {
          state.configs[config.id] = config;
          // If state doesn't exist, initialize it
          if (!state.panels[config.id]) {
            state.panels[config.id] = {
              id: config.id,
              ...config.defaultGeometry,
              isOpen: true,
              isCollapsed: false,
              zIndex: state.maxZIndex + 1,
              alignment: config.defaultAlignment,
            };
            state.maxZIndex += 1;
          }
        }),

      openPanel: (id) =>
        set((state) => {
          if (state.panels[id]) {
            state.panels[id].isOpen = true;
            state.panels[id].zIndex = state.maxZIndex + 1;
            state.maxZIndex += 1;
            state.activeId = id;
          }
        }),

      closePanel: (id) =>
        set((state) => {
          if (state.panels[id]) {
            state.panels[id].isOpen = false;
          }
        }),

      togglePanel: (id) =>
        set((state) => {
          if (state.panels[id]) {
            const nextOpen = !state.panels[id].isOpen;
            state.panels[id].isOpen = nextOpen;
            if (nextOpen) {
              state.panels[id].zIndex = state.maxZIndex + 1;
              state.maxZIndex += 1;
              state.activeId = id;
            }
          }
        }),

      minimizePanel: (id, isCollapsed) =>
        set((state) => {
          if (state.panels[id]) {
            state.panels[id].isCollapsed = isCollapsed ?? !state.panels[id].isCollapsed;
          }
        }),

      updateGeometry: (id, geometry) =>
        set((state) => {
          if (state.panels[id]) {
            Object.assign(state.panels[id], geometry);
          }
        }),

      updateAlignment: (id, alignment) =>
        set((state) => {
          if (state.panels[id]) {
            state.panels[id].alignment = alignment;
          }
        }),

      bringToFront: (id) =>
        set((state) => {
          if (state.panels[id]) {
            state.panels[id].zIndex = state.maxZIndex + 1;
            state.maxZIndex += 1;
            state.activeId = id;
          }
        }),
    })),
    {
      name: 'paintboard-panels',
      // Only persist the panels state, not configs (which are code-defined)
      partialize: (state) => ({
        panels: state.panels,
        maxZIndex: state.maxZIndex,
      }),
    }
  )
);
