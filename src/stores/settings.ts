import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

// Accent color presets
export const ACCENT_COLORS = [
  { id: 'blue', value: '#137fec', label: 'Blue' },
  { id: 'purple', value: '#8b5cf6', label: 'Purple' },
  { id: 'pink', value: '#ec4899', label: 'Pink' },
  { id: 'red', value: '#ef4444', label: 'Red' },
  { id: 'orange', value: '#f97316', label: 'Orange' },
  { id: 'yellow', value: '#eab308', label: 'Yellow' },
  { id: 'green', value: '#22c55e', label: 'Green' },
  { id: 'teal', value: '#14b8a6', label: 'Teal' },
] as const;

// Panel background color presets
export const PANEL_BG_COLORS = [
  { id: 'dark', value: 'rgba(20, 20, 25, 0.8)', solid: '#14141a', label: 'Dark' },
  { id: 'darker', value: 'rgba(10, 10, 15, 0.85)', solid: '#0a0a0f', label: 'Darker' },
  { id: 'charcoal', value: 'rgba(30, 30, 35, 0.75)', solid: '#1e1e23', label: 'Charcoal' },
  { id: 'slate', value: 'rgba(40, 45, 55, 0.7)', solid: '#282d37', label: 'Slate' },
] as const;

export type AccentColorId = (typeof ACCENT_COLORS)[number]['id'];
export type PanelBgColorId = (typeof PANEL_BG_COLORS)[number]['id'];

export interface AppearanceSettings {
  accentColor: AccentColorId;
  panelBgColor: PanelBgColorId;
  enableBlur: boolean;
}

export interface TabletSettings {
  backend: 'auto' | 'wintab' | 'pointerevent';
  pollingRate: number;
  pressureCurve: 'linear' | 'soft' | 'hard' | 'scurve';
  autoStart: boolean;
}

interface SettingsState {
  // Settings panel visibility
  isOpen: boolean;
  activeTab: string;

  // Appearance settings
  appearance: AppearanceSettings;

  // Tablet settings
  tablet: TabletSettings;

  // Actions
  openSettings: () => void;
  closeSettings: () => void;
  setActiveTab: (tab: string) => void;

  // Appearance actions
  setAccentColor: (color: AccentColorId) => void;
  setPanelBgColor: (color: PanelBgColorId) => void;
  setEnableBlur: (enabled: boolean) => void;

  // Tablet actions
  setTabletBackend: (backend: TabletSettings['backend']) => void;
  setPollingRate: (rate: number) => void;
  setPressureCurve: (curve: TabletSettings['pressureCurve']) => void;
  setAutoStart: (enabled: boolean) => void;
}

// Apply CSS variables based on settings
function applyAppearanceSettings(appearance: AppearanceSettings): void {
  const root = document.documentElement;

  // Find accent color
  const accent = ACCENT_COLORS.find((c) => c.id === appearance.accentColor);
  if (accent) {
    root.style.setProperty('--primary', accent.value);
    root.style.setProperty('--accent', accent.value);
    // Generate hover/active variants
    root.style.setProperty('--primary-hover', adjustBrightness(accent.value, 15));
    root.style.setProperty('--primary-active', adjustBrightness(accent.value, -15));
    root.style.setProperty('--primary-bg', hexToRgba(accent.value, 0.2));
    root.style.setProperty('--primary-border', hexToRgba(accent.value, 0.4));
  }

  // Find panel background
  const panelBg = PANEL_BG_COLORS.find((c) => c.id === appearance.panelBgColor);
  if (panelBg) {
    if (appearance.enableBlur) {
      root.style.setProperty('--mica-bg', panelBg.value);
      root.style.setProperty('--mica-blur', 'blur(20px) saturate(120%)');
    } else {
      root.style.setProperty('--mica-bg', panelBg.solid);
      root.style.setProperty('--mica-blur', 'none');
    }
    root.style.setProperty('--mica-bg-solid', panelBg.solid);
  }
}

// Helper: Adjust hex color brightness
function adjustBrightness(hex: string, percent: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const R = Math.min(255, Math.max(0, (num >> 16) + amt));
  const G = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + amt));
  const B = Math.min(255, Math.max(0, (num & 0x0000ff) + amt));
  return `#${((1 << 24) | (R << 16) | (G << 8) | B).toString(16).slice(1)}`;
}

// Helper: Convert hex to rgba
function hexToRgba(hex: string, alpha: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const R = (num >> 16) & 0xff;
  const G = (num >> 8) & 0xff;
  const B = num & 0xff;
  return `rgba(${R}, ${G}, ${B}, ${alpha})`;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    immer((set) => ({
      // Initial state
      isOpen: false,
      activeTab: 'appearance',

      appearance: {
        accentColor: 'blue',
        panelBgColor: 'dark',
        enableBlur: true,
      },

      tablet: {
        backend: 'auto',
        pollingRate: 200,
        pressureCurve: 'linear',
        autoStart: true,
      },

      // Panel actions
      openSettings: () => set({ isOpen: true }),
      closeSettings: () => set({ isOpen: false }),
      setActiveTab: (tab) => set({ activeTab: tab }),

      // Appearance actions
      setAccentColor: (color) =>
        set((state) => {
          state.appearance.accentColor = color;
          applyAppearanceSettings(state.appearance);
        }),

      setPanelBgColor: (color) =>
        set((state) => {
          state.appearance.panelBgColor = color;
          applyAppearanceSettings(state.appearance);
        }),

      setEnableBlur: (enabled) =>
        set((state) => {
          state.appearance.enableBlur = enabled;
          applyAppearanceSettings(state.appearance);
        }),

      // Tablet actions
      setTabletBackend: (backend) =>
        set((state) => {
          state.tablet.backend = backend;
        }),

      setPollingRate: (rate) =>
        set((state) => {
          state.tablet.pollingRate = rate;
        }),

      setPressureCurve: (curve) =>
        set((state) => {
          state.tablet.pressureCurve = curve;
        }),

      setAutoStart: (enabled) =>
        set((state) => {
          state.tablet.autoStart = enabled;
        }),
    })),
    {
      name: 'paintboard-settings',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        appearance: state.appearance,
        tablet: state.tablet,
      }),
      onRehydrateStorage: () => (state) => {
        // Apply settings after rehydration
        if (state) {
          applyAppearanceSettings(state.appearance);
        }
      },
    }
  )
);

// Initialize settings on load
export function initializeSettings(): void {
  const state = useSettingsStore.getState();
  applyAppearanceSettings(state.appearance);
}
