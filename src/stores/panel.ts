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
  // Dynamic overrides or copies from config
  minWidth?: number;
  minHeight?: number;
  resizable?: boolean;
  closable?: boolean;
  minimizable?: boolean;
  maxWidth?: number;
  maxHeight?: number;
}

export interface PanelConfig {
  id: string;
  title: string;
  defaultGeometry: PanelGeometry;
  defaultAlignment?: PanelAlignment;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  resizable?: boolean;
  closable?: boolean;
  minimizable?: boolean;
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

// Helper to extract code-driven capabilities from config
function extractCapabilities(config: PanelConfig) {
  return {
    alignment: config.defaultAlignment,
    resizable: config.resizable ?? true,
    closable: config.closable ?? true,
    minimizable: config.minimizable ?? true,
    minWidth: config.minWidth,
    minHeight: config.minHeight,
    maxWidth: config.maxWidth,
    maxHeight: config.maxHeight,
  };
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

          // Helper to extract capabilities
          const capabilities = extractCapabilities(config);

          // If state doesn't exist, initialize it
          if (!state.panels[config.id]) {
            state.panels[config.id] = {
              id: config.id,
              ...config.defaultGeometry,
              isOpen: true,
              isCollapsed: false,
              zIndex: state.maxZIndex + 1,
              ...capabilities,
            };
            state.maxZIndex += 1;
          } else {
            // Panel exists, but we MUST update capabilities that are code-defined rules
            const existingPanel = state.panels[config.id];
            if (existingPanel) {
              Object.assign(existingPanel, capabilities);

              // Force reset dimensions if not resizable (fix for stale persisted state)
              if (capabilities.resizable === false) {
                existingPanel.width = config.defaultGeometry.width;
                existingPanel.height = config.defaultGeometry.height;
              }
            }
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
