import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { BaseDirectory, readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import {
  type QuickExportBackgroundPreset,
  type QuickExportFormat,
  type QuickExportSettings,
} from '@/utils/quickExport';

// Settings file path (relative to app config directory)
const SETTINGS_FILE = 'settings.json';

// Accent color presets - add more colors here as needed
export const ACCENT_COLORS = [
  { id: 'blue', value: '#137fec', label: 'Blue' },
  { id: 'purple', value: '#8b5cf6', label: 'Purple' },
  { id: 'pink', value: '#ec4899', label: 'Pink' },
  { id: 'red', value: '#ef4444', label: 'Red' },
  { id: 'orange', value: '#f97316', label: 'Orange' },
  { id: 'yellow', value: '#eab308', label: 'Yellow' },
  { id: 'green', value: '#22c55e', label: 'Green' },
  { id: 'teal', value: '#14b8a6', label: 'Teal' },
  // Row 2 - Placeholder colors (customize as needed)
  { id: 'indigo', value: '#6366f1', label: 'Indigo' },
  { id: 'violet', value: '#a855f7', label: 'Violet' },
  { id: 'rose', value: '#f43f5e', label: 'Rose' },
  { id: 'amber', value: '#f59e0b', label: 'Amber' },
  { id: 'lime', value: '#84cc16', label: 'Lime' },
  { id: 'emerald', value: '#10b981', label: 'Emerald' },
  { id: 'cyan', value: '#06b6d4', label: 'Cyan' },
  { id: 'sky', value: '#0ea5e9', label: 'Sky' },
] as const;

// Panel background color presets - add more colors here as needed
export const PANEL_BG_COLORS = [
  { id: 'dark', value: 'rgba(20, 20, 25, 0.8)', solid: '#14141a', label: 'Dark' },
  { id: 'darker', value: 'rgba(10, 10, 15, 0.85)', solid: '#0a0a0f', label: 'Darker' },
  { id: 'charcoal', value: 'rgba(30, 30, 35, 0.75)', solid: '#1e1e23', label: 'Charcoal' },
  { id: 'slate', value: 'rgba(40, 45, 55, 0.7)', solid: '#282d37', label: 'Slate' },
  // Row 2 - Placeholder colors (customize as needed)
  { id: 'midnight', value: 'rgba(15, 23, 42, 0.85)', solid: '#0f172a', label: 'Midnight' },
  { id: 'graphite', value: 'rgba(55, 55, 60, 0.75)', solid: '#37373c', label: 'Graphite' },
  { id: 'neutral', value: 'rgba(45, 45, 50, 0.8)', solid: '#2d2d32', label: 'Neutral' },
  { id: 'warm', value: 'rgba(40, 35, 30, 0.8)', solid: '#28231e', label: 'Warm' },
] as const;

// Canvas background color presets
export const CANVAS_BG_COLORS = [
  { id: 'black', value: '#000000', label: 'Black' },
  { id: 'dark-gray', value: '#2e2e2e', label: 'Dark Gray' }, // 18% gray (approx)
  { id: 'gray', value: '#808080', label: 'Gray' }, // 50% gray
  { id: 'white', value: '#ffffff', label: 'White' },
] as const;

export type AccentColorId = (typeof ACCENT_COLORS)[number]['id'];
export type PanelBgColorId = (typeof PANEL_BG_COLORS)[number]['id'];
export type CanvasBgColorId = (typeof CANVAS_BG_COLORS)[number]['id'];

export interface AppearanceSettings {
  accentColor: AccentColorId;
  panelBgColor: PanelBgColorId;
  canvasBgColor: CanvasBgColorId;
  enableBlur: boolean;
}

export interface TabletSettings {
  backend: 'auto' | 'wintab' | 'pointerevent';
  pollingRate: number;
  pressureCurve: 'linear' | 'soft' | 'hard' | 'scurve';
  backpressureMode: 'lossless' | 'latency_capped';
  autoStart: boolean;
}

/**
 * Render mode - controls which backend to use for brush rendering
 */
export type RenderMode = 'gpu' | 'cpu';

/**
 * GPU render scale mode - controls dynamic downsampling
 */
export type GPURenderScaleMode = 'auto' | 'off';

export interface BrushSettings {
  renderMode: RenderMode;
  gpuRenderScaleMode: GPURenderScaleMode;
}

export type NewFileBackgroundPreset = 'transparent' | 'white' | 'black' | 'current-bg';
export type NewFileOrientation = 'portrait' | 'landscape';

export interface CustomSizePreset {
  id: string;
  name: string;
  width: number;
  height: number;
}

export interface NewFileLastUsedSettings {
  width: number;
  height: number;
  backgroundPreset: NewFileBackgroundPreset;
  presetId: string | null;
  orientation: NewFileOrientation;
}

export interface NewFileSettings {
  customSizePresets: CustomSizePreset[];
  lastUsed: NewFileLastUsedSettings;
}

export interface GeneralSettings {
  autosaveIntervalMinutes: number;
  openLastFileOnStartup: boolean;
}

export type BrushPresetSelectionTool = 'brush' | 'eraser';

export interface BrushPresetSelectionByTool {
  brush: string | null;
  eraser: string | null;
}

export interface BrushLibrarySettings {
  selectedPresetByTool: BrushPresetSelectionByTool;
}

interface PersistedSettings {
  appearance: AppearanceSettings;
  tablet: TabletSettings;
  brush: BrushSettings;
  newFile: NewFileSettings;
  general: GeneralSettings;
  quickExport: QuickExportSettings;
  brushLibrary: BrushLibrarySettings;
}

interface SettingsState extends PersistedSettings {
  // Settings panel visibility
  isOpen: boolean;
  activeTab: string;

  // Loading state
  isLoaded: boolean;

  // Actions
  openSettings: () => void;
  closeSettings: () => void;
  setActiveTab: (tab: string) => void;

  // Appearance actions
  setAccentColor: (color: AccentColorId) => void;
  setPanelBgColor: (color: PanelBgColorId) => void;
  setCanvasBgColor: (color: CanvasBgColorId) => void;
  setEnableBlur: (enabled: boolean) => void;

  // Tablet actions
  setTabletBackend: (backend: TabletSettings['backend']) => void;
  setPollingRate: (rate: number) => void;
  setPressureCurve: (curve: TabletSettings['pressureCurve']) => void;
  setBackpressureMode: (mode: TabletSettings['backpressureMode']) => void;
  setAutoStart: (enabled: boolean) => void;

  // Brush/Renderer actions
  setRenderMode: (mode: RenderMode) => void;
  setGpuRenderScaleMode: (mode: GPURenderScaleMode) => void;

  // New file preset actions
  addCustomSizePreset: (preset: { name: string; width: number; height: number }) => string;
  removeCustomSizePreset: (id: string) => void;
  setNewFileLastUsed: (lastUsed: NewFileLastUsedSettings) => void;

  // General actions
  setAutosaveIntervalMinutes: (minutes: number) => void;
  setOpenLastFileOnStartup: (enabled: boolean) => void;

  // Quick export actions
  setQuickExport: (patch: Partial<QuickExportSettings>) => void;
  setBrushLibrarySelectedPreset: (tool: BrushPresetSelectionTool, id: string | null) => void;
  setBrushLibrarySelection: (selection: BrushPresetSelectionByTool) => void;

  // Persistence
  _loadSettings: () => Promise<void>;
  _saveSettings: () => Promise<void>;
}

export const DEFAULT_NEW_FILE_SETTINGS: NewFileSettings = {
  customSizePresets: [],
  lastUsed: {
    width: 1920,
    height: 1080,
    backgroundPreset: 'white',
    presetId: 'device-1080p',
    orientation: 'landscape',
  },
};

export const DEFAULT_QUICK_EXPORT_SETTINGS: QuickExportSettings = {
  lastPath: '',
  lastFormat: 'png',
  lastWidth: 0,
  lastHeight: 0,
  transparentBackground: true,
  backgroundPreset: 'current-bg',
};

function cloneDefaultNewFileSettings(): NewFileSettings {
  return {
    customSizePresets: [...DEFAULT_NEW_FILE_SETTINGS.customSizePresets],
    lastUsed: { ...DEFAULT_NEW_FILE_SETTINGS.lastUsed },
  };
}

function mergeLoadedNewFileSettings(loadedNewFile: unknown): NewFileSettings {
  const defaults = cloneDefaultNewFileSettings();
  if (!loadedNewFile || typeof loadedNewFile !== 'object') {
    return defaults;
  }

  const partial = loadedNewFile as Partial<NewFileSettings>;
  return {
    customSizePresets: Array.isArray(partial.customSizePresets)
      ? partial.customSizePresets
      : defaults.customSizePresets,
    lastUsed: {
      ...defaults.lastUsed,
      ...(partial.lastUsed ?? {}),
    },
  };
}

function normalizeQuickExportFormat(value: unknown): QuickExportFormat {
  if (value === 'jpg' || value === 'webp') return value;
  return 'png';
}

function normalizeQuickExportBackgroundPreset(value: unknown): QuickExportBackgroundPreset {
  if (value === 'white' || value === 'black' || value === 'current-bg') {
    return value;
  }
  return 'current-bg';
}

function normalizePositiveDimension(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return fallback;
}

function mergeLoadedQuickExportSettings(loadedQuickExport: unknown): QuickExportSettings {
  const defaults = { ...DEFAULT_QUICK_EXPORT_SETTINGS };
  if (!loadedQuickExport || typeof loadedQuickExport !== 'object') {
    return defaults;
  }

  const partial = loadedQuickExport as Partial<QuickExportSettings>;

  return {
    lastPath: typeof partial.lastPath === 'string' ? partial.lastPath : defaults.lastPath,
    lastFormat: normalizeQuickExportFormat(partial.lastFormat),
    lastWidth: normalizePositiveDimension(partial.lastWidth, defaults.lastWidth),
    lastHeight: normalizePositiveDimension(partial.lastHeight, defaults.lastHeight),
    transparentBackground:
      typeof partial.transparentBackground === 'boolean'
        ? partial.transparentBackground
        : defaults.transparentBackground,
    backgroundPreset: normalizeQuickExportBackgroundPreset(partial.backgroundPreset),
  };
}

function normalizePresetId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function mergeLoadedBrushLibrarySettings(loadedBrushLibrary: unknown): BrushLibrarySettings {
  const defaults = defaultSettings.brushLibrary;
  if (!loadedBrushLibrary || typeof loadedBrushLibrary !== 'object') {
    return {
      selectedPresetByTool: { ...defaults.selectedPresetByTool },
    };
  }

  const partial = loadedBrushLibrary as Partial<BrushLibrarySettings>;
  const selected = partial.selectedPresetByTool;

  return {
    selectedPresetByTool: {
      brush: normalizePresetId(selected?.brush),
      eraser: normalizePresetId(selected?.eraser),
    },
  };
}

function clampAutosaveIntervalMinutes(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.max(1, Math.floor(value));
}

// Default settings
const defaultSettings: PersistedSettings = {
  appearance: {
    accentColor: 'blue',
    panelBgColor: 'dark',
    canvasBgColor: 'dark-gray',
    enableBlur: true,
  },
  tablet: {
    backend: 'wintab',
    pollingRate: 200,
    pressureCurve: 'linear',
    backpressureMode: 'lossless',
    autoStart: true,
  },
  brush: {
    renderMode: 'gpu',
    gpuRenderScaleMode: 'off',
  },
  newFile: cloneDefaultNewFileSettings(),
  general: {
    autosaveIntervalMinutes: 10,
    openLastFileOnStartup: true,
  },
  quickExport: { ...DEFAULT_QUICK_EXPORT_SETTINGS },
  brushLibrary: {
    selectedPresetByTool: {
      brush: null,
      eraser: null,
    },
  },
};

function createCustomSizePresetId(): string {
  return `custom_size_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

  // Find canvas background
  const canvasBg = CANVAS_BG_COLORS.find((c) => c.id === appearance.canvasBgColor);
  if (canvasBg) {
    root.style.setProperty('--app-bg', canvasBg.value);
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

// Debounce save to avoid too frequent writes
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
function debouncedSave(saveFn: () => Promise<void>): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(() => {
    saveFn();
    saveTimeout = null;
  }, 500);
}

export const useSettingsStore = create<SettingsState>()(
  immer((set, get) => ({
    // Initial state
    isOpen: false,
    activeTab: 'appearance',
    isLoaded: false,

    ...defaultSettings,

    // Panel actions
    openSettings: () => set({ isOpen: true }),
    closeSettings: () => set({ isOpen: false }),
    setActiveTab: (tab) => set({ activeTab: tab }),

    // Appearance actions
    setAccentColor: (color) => {
      set((state) => {
        state.appearance.accentColor = color;
      });
      applyAppearanceSettings(get().appearance);
      debouncedSave(() => get()._saveSettings());
    },

    setPanelBgColor: (color) => {
      set((state) => {
        state.appearance.panelBgColor = color;
      });
      applyAppearanceSettings(get().appearance);
      debouncedSave(() => get()._saveSettings());
    },

    setCanvasBgColor: (color) => {
      set((state) => {
        state.appearance.canvasBgColor = color;
      });
      applyAppearanceSettings(get().appearance);
      debouncedSave(() => get()._saveSettings());
    },

    setEnableBlur: (enabled) => {
      set((state) => {
        state.appearance.enableBlur = enabled;
      });
      applyAppearanceSettings(get().appearance);
      debouncedSave(() => get()._saveSettings());
    },

    // Tablet actions
    setTabletBackend: (backend) => {
      set((state) => {
        state.tablet.backend = backend;
      });
      debouncedSave(() => get()._saveSettings());
    },

    setPollingRate: (rate) => {
      set((state) => {
        state.tablet.pollingRate = rate;
      });
      debouncedSave(() => get()._saveSettings());
    },

    setPressureCurve: (curve) => {
      set((state) => {
        state.tablet.pressureCurve = curve;
      });
      debouncedSave(() => get()._saveSettings());
    },

    setBackpressureMode: (mode) => {
      set((state) => {
        state.tablet.backpressureMode = mode;
      });
      debouncedSave(() => get()._saveSettings());
    },

    setAutoStart: (enabled) => {
      set((state) => {
        state.tablet.autoStart = enabled;
      });
      debouncedSave(() => get()._saveSettings());
    },

    // Brush/Renderer actions
    setRenderMode: (mode) => {
      set((state) => {
        state.brush.renderMode = mode;
      });
      debouncedSave(() => get()._saveSettings());
    },

    setGpuRenderScaleMode: (mode) => {
      set((state) => {
        state.brush.gpuRenderScaleMode = mode;
      });
      debouncedSave(() => get()._saveSettings());
    },

    addCustomSizePreset: ({ name, width, height }) => {
      const id = createCustomSizePresetId();
      set((state) => {
        state.newFile.customSizePresets.push({
          id,
          name,
          width,
          height,
        });
      });
      debouncedSave(() => get()._saveSettings());
      return id;
    },

    removeCustomSizePreset: (id) => {
      set((state) => {
        state.newFile.customSizePresets = state.newFile.customSizePresets.filter(
          (preset) => preset.id !== id
        );
      });
      debouncedSave(() => get()._saveSettings());
    },

    setNewFileLastUsed: (lastUsed) => {
      set((state) => {
        state.newFile.lastUsed = lastUsed;
      });
      debouncedSave(() => get()._saveSettings());
    },

    setAutosaveIntervalMinutes: (minutes) => {
      const normalized = clampAutosaveIntervalMinutes(minutes);
      set((state) => {
        state.general.autosaveIntervalMinutes = normalized;
      });
      debouncedSave(() => get()._saveSettings());
    },

    setOpenLastFileOnStartup: (enabled) => {
      set((state) => {
        state.general.openLastFileOnStartup = enabled;
      });
      debouncedSave(() => get()._saveSettings());
    },

    setQuickExport: (patch) => {
      set((state) => {
        state.quickExport = { ...state.quickExport, ...patch };
      });
      debouncedSave(() => get()._saveSettings());
    },

    setBrushLibrarySelectedPreset: (tool, id) => {
      set((state) => {
        state.brushLibrary.selectedPresetByTool[tool] = id;
      });
      debouncedSave(() => get()._saveSettings());
    },

    setBrushLibrarySelection: (selection) => {
      set((state) => {
        state.brushLibrary.selectedPresetByTool = {
          brush: normalizePresetId(selection.brush),
          eraser: normalizePresetId(selection.eraser),
        };
      });
      debouncedSave(() => get()._saveSettings());
    },

    // Load settings from file
    _loadSettings: async () => {
      try {
        const fileExists = await exists(SETTINGS_FILE, { baseDir: BaseDirectory.AppConfig });

        if (fileExists) {
          const content = await readTextFile(SETTINGS_FILE, { baseDir: BaseDirectory.AppConfig });
          const loaded = JSON.parse(content) as Partial<PersistedSettings>;

          set((state) => {
            // Merge with defaults to handle missing fields
            if (loaded.appearance) {
              state.appearance = { ...defaultSettings.appearance, ...loaded.appearance };
            }
            if (loaded.tablet) {
              state.tablet = { ...defaultSettings.tablet, ...loaded.tablet };
            }
            if (loaded.brush) {
              state.brush = {
                renderMode: loaded.brush.renderMode ?? defaultSettings.brush.renderMode,
                gpuRenderScaleMode:
                  loaded.brush.gpuRenderScaleMode ?? defaultSettings.brush.gpuRenderScaleMode,
              };
            }
            state.newFile = mergeLoadedNewFileSettings(loaded.newFile);
            if (loaded.general) {
              state.general = {
                ...defaultSettings.general,
                ...loaded.general,
                autosaveIntervalMinutes: clampAutosaveIntervalMinutes(
                  loaded.general.autosaveIntervalMinutes ??
                    defaultSettings.general.autosaveIntervalMinutes
                ),
              };
            } else {
              state.general = { ...defaultSettings.general };
            }
            state.quickExport = mergeLoadedQuickExportSettings(
              (loaded as Partial<PersistedSettings>).quickExport
            );
            state.brushLibrary = mergeLoadedBrushLibrarySettings(
              (loaded as Partial<PersistedSettings>).brushLibrary
            );
            state.isLoaded = true;
          });
        } else {
          // No settings file, use defaults and save
          set({ isLoaded: true });
          await get()._saveSettings();
        }
      } catch {
        // Load failed - use defaults (non-critical, app works fine with defaults)
        set({ isLoaded: true });
      }

      // Apply appearance after loading
      applyAppearanceSettings(get().appearance);
    },

    // Save settings to file
    _saveSettings: async () => {
      try {
        // Ensure AppConfig directory exists
        await mkdir('', { baseDir: BaseDirectory.AppConfig, recursive: true });

        const state = get();
        const data: PersistedSettings = {
          appearance: state.appearance,
          tablet: state.tablet,
          brush: state.brush,
          newFile: state.newFile,
          general: state.general,
          quickExport: state.quickExport,
          brushLibrary: state.brushLibrary,
        };

        await writeTextFile(SETTINGS_FILE, JSON.stringify(data, null, 2), {
          baseDir: BaseDirectory.AppConfig,
        });
      } catch {
        // Settings save failed - silent failure, non-critical operation
      }
    },
  }))
);

// Initialize settings on load
export async function initializeSettings(): Promise<void> {
  await useSettingsStore.getState()._loadSettings();
}
