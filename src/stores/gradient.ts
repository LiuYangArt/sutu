import { BaseDirectory, exists, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { BlendMode } from './document';

const GRADIENT_FILE = 'gradients.json';
const GRADIENT_SCHEMA_VERSION = 2;
const MIDPOINT_MIN = 0.05;
const MIDPOINT_MAX = 0.95;

export type GradientShape = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
export type ColorStopSource = 'fixed' | 'foreground' | 'background';

export interface ColorStop {
  id: string;
  position: number;
  midpoint: number;
  source: ColorStopSource;
  color: string;
}

export interface OpacityStop {
  id: string;
  position: number;
  midpoint: number;
  opacity: number;
}

export interface AddColorStopOptions {
  source?: ColorStopSource;
  color?: string;
  midpoint?: number;
}

export interface AddOpacityStopOptions {
  opacity?: number;
  midpoint?: number;
}

export interface GradientPreset {
  id: string;
  name: string;
  colorStops: ColorStop[];
  opacityStops: OpacityStop[];
  smoothness: number;
}

export interface GradientToolSettings {
  activePresetId: string | null;
  customGradient: GradientPreset;
  shape: GradientShape;
  blendMode: BlendMode;
  opacity: number;
  reverse: boolean;
  dither: boolean;
  transparency: boolean;
}

interface GradientPersistedState {
  version: number;
  presets: GradientPreset[];
  settings: GradientToolSettings;
}

interface GradientState {
  isLoaded: boolean;
  presets: GradientPreset[];
  settings: GradientToolSettings;
  selectedColorStopId: string | null;
  selectedOpacityStopId: string | null;

  setShape: (shape: GradientShape) => void;
  setBlendMode: (blendMode: BlendMode) => void;
  setOpacity: (opacity: number) => void;
  setReverse: (reverse: boolean) => void;
  setDither: (dither: boolean) => void;
  setTransparency: (enabled: boolean) => void;

  setActivePreset: (presetId: string | null) => void;
  copyPresetToCustom: (presetId: string) => void;

  setCustomGradientName: (name: string) => void;
  selectColorStop: (id: string | null) => void;
  selectOpacityStop: (id: string | null) => void;
  addColorStop: (position: number, options?: AddColorStopOptions) => string;
  updateColorStop: (id: string, patch: Partial<ColorStop>) => void;
  removeColorStop: (id: string) => void;
  addOpacityStop: (position: number, options?: AddOpacityStopOptions) => string;
  updateOpacityStop: (id: string, patch: Partial<OpacityStop>) => void;
  removeOpacityStop: (id: string) => void;

  saveCustomAsPreset: (name: string) => string;
  renamePreset: (id: string, name: string) => void;
  deletePreset: (id: string) => void;

  loadFromDisk: () => Promise<void>;
  saveToDisk: () => Promise<void>;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clampSmoothness(value: number): number {
  if (!Number.isFinite(value)) return 100;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function clampPosition(value: number): number {
  return clamp01(value);
}

function clampMidpoint(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  if (value < MIDPOINT_MIN) return MIDPOINT_MIN;
  if (value > MIDPOINT_MAX) return MIDPOINT_MAX;
  return value;
}

function toHexColor(input: string | undefined, fallback: string): string {
  const raw = (input ?? '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    const r = raw[1];
    const g = raw[2];
    const b = raw[3];
    if (r && g && b) {
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
  }
  return fallback;
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cloneColorStop(stop: ColorStop): ColorStop {
  return { ...stop };
}

function cloneOpacityStop(stop: OpacityStop): OpacityStop {
  return { ...stop };
}

function clonePreset(preset: GradientPreset): GradientPreset {
  return {
    ...preset,
    colorStops: preset.colorStops.map(cloneColorStop),
    opacityStops: preset.opacityStops.map(cloneOpacityStop),
  };
}

function normalizeColorStop(stop: Partial<ColorStop>): ColorStop {
  const source: ColorStopSource =
    stop.source === 'foreground' || stop.source === 'background' ? stop.source : 'fixed';
  return {
    id: typeof stop.id === 'string' && stop.id.length > 0 ? stop.id : createId('color'),
    position: clampPosition(typeof stop.position === 'number' ? stop.position : 0),
    midpoint: clampMidpoint(typeof stop.midpoint === 'number' ? stop.midpoint : 0.5),
    source,
    color: toHexColor(stop.color, source === 'background' ? '#ffffff' : '#000000'),
  };
}

function normalizeOpacityStop(stop: Partial<OpacityStop>): OpacityStop {
  return {
    id: typeof stop.id === 'string' && stop.id.length > 0 ? stop.id : createId('opacity'),
    position: clampPosition(typeof stop.position === 'number' ? stop.position : 0),
    midpoint: clampMidpoint(typeof stop.midpoint === 'number' ? stop.midpoint : 0.5),
    opacity: clamp01(typeof stop.opacity === 'number' ? stop.opacity : 1),
  };
}

function normalizeColorStops(stops: ColorStop[] | undefined): ColorStop[] {
  const normalized = (stops ?? []).map((stop) => normalizeColorStop(stop));
  normalized.sort((a, b) => a.position - b.position);
  if (normalized.length >= 2) return normalized;
  return [
    { id: createId('color'), position: 0, midpoint: 0.5, source: 'foreground', color: '#000000' },
    { id: createId('color'), position: 1, midpoint: 0.5, source: 'background', color: '#ffffff' },
  ];
}

function normalizeOpacityStops(stops: OpacityStop[] | undefined): OpacityStop[] {
  const normalized = (stops ?? []).map((stop) => normalizeOpacityStop(stop));
  normalized.sort((a, b) => a.position - b.position);
  if (normalized.length >= 2) return normalized;
  return [
    { id: createId('opacity'), position: 0, midpoint: 0.5, opacity: 1 },
    { id: createId('opacity'), position: 1, midpoint: 0.5, opacity: 1 },
  ];
}

function normalizePreset(input: Partial<GradientPreset>): GradientPreset {
  return {
    id: typeof input.id === 'string' && input.id.length > 0 ? input.id : createId('preset'),
    name:
      typeof input.name === 'string' && input.name.trim().length > 0
        ? input.name.trim()
        : 'Untitled Gradient',
    colorStops: normalizeColorStops(input.colorStops),
    opacityStops: normalizeOpacityStops(input.opacityStops),
    smoothness: clampSmoothness(typeof input.smoothness === 'number' ? input.smoothness : 100),
  };
}

function createDefaultPresets(): GradientPreset[] {
  return [
    normalizePreset({
      id: 'preset_fg_bg',
      name: 'Foreground to Background',
      colorStops: [
        { id: 'fgbg_c0', position: 0, midpoint: 0.5, source: 'foreground', color: '#000000' },
        { id: 'fgbg_c1', position: 1, midpoint: 0.5, source: 'background', color: '#ffffff' },
      ],
      opacityStops: [
        { id: 'fgbg_o0', position: 0, midpoint: 0.5, opacity: 1 },
        { id: 'fgbg_o1', position: 1, midpoint: 0.5, opacity: 1 },
      ],
      smoothness: 100,
    }),
    normalizePreset({
      id: 'preset_fg_transparent',
      name: 'Foreground to Transparent',
      colorStops: [
        { id: 'fgt_c0', position: 0, midpoint: 0.5, source: 'foreground', color: '#000000' },
        { id: 'fgt_c1', position: 1, midpoint: 0.5, source: 'foreground', color: '#000000' },
      ],
      opacityStops: [
        { id: 'fgt_o0', position: 0, midpoint: 0.5, opacity: 1 },
        { id: 'fgt_o1', position: 1, midpoint: 0.5, opacity: 0 },
      ],
      smoothness: 100,
    }),
    normalizePreset({
      id: 'preset_bw',
      name: 'Black and White',
      colorStops: [
        { id: 'bw_c0', position: 0, midpoint: 0.5, source: 'fixed', color: '#000000' },
        { id: 'bw_c1', position: 1, midpoint: 0.5, source: 'fixed', color: '#ffffff' },
      ],
      opacityStops: [
        { id: 'bw_o0', position: 0, midpoint: 0.5, opacity: 1 },
        { id: 'bw_o1', position: 1, midpoint: 0.5, opacity: 1 },
      ],
      smoothness: 100,
    }),
    normalizePreset({
      id: 'preset_rainbow',
      name: 'Rainbow',
      colorStops: [
        { id: 'rb_c0', position: 0, midpoint: 0.5, source: 'fixed', color: '#ff0000' },
        { id: 'rb_c1', position: 0.17, midpoint: 0.5, source: 'fixed', color: '#ff7f00' },
        { id: 'rb_c2', position: 0.33, midpoint: 0.5, source: 'fixed', color: '#ffff00' },
        { id: 'rb_c3', position: 0.5, midpoint: 0.5, source: 'fixed', color: '#00ff00' },
        { id: 'rb_c4', position: 0.67, midpoint: 0.5, source: 'fixed', color: '#0000ff' },
        { id: 'rb_c5', position: 0.83, midpoint: 0.5, source: 'fixed', color: '#4b0082' },
        { id: 'rb_c6', position: 1, midpoint: 0.5, source: 'fixed', color: '#9400d3' },
      ],
      opacityStops: [
        { id: 'rb_o0', position: 0, midpoint: 0.5, opacity: 1 },
        { id: 'rb_o1', position: 1, midpoint: 0.5, opacity: 1 },
      ],
      smoothness: 100,
    }),
  ];
}

function createDefaultSettings(defaultPreset: GradientPreset): GradientToolSettings {
  return {
    activePresetId: defaultPreset.id,
    customGradient: clonePreset(defaultPreset),
    shape: 'linear',
    blendMode: 'normal',
    opacity: 1,
    reverse: false,
    dither: false,
    transparency: true,
  };
}

const BLEND_MODES = new Set<BlendMode>([
  'normal',
  'dissolve',
  'darken',
  'multiply',
  'color-burn',
  'linear-burn',
  'darker-color',
  'lighten',
  'screen',
  'color-dodge',
  'linear-dodge',
  'lighter-color',
  'overlay',
  'soft-light',
  'hard-light',
  'vivid-light',
  'linear-light',
  'pin-light',
  'hard-mix',
  'difference',
  'exclusion',
  'subtract',
  'divide',
  'hue',
  'saturation',
  'color',
  'luminosity',
]);

function normalizeShape(value: GradientShape | undefined): GradientShape {
  if (value === 'radial' || value === 'angle' || value === 'reflected' || value === 'diamond') {
    return value;
  }
  return 'linear';
}

function normalizeSettings(
  input: Partial<GradientToolSettings> | undefined,
  fallbackPreset: GradientPreset
): GradientToolSettings {
  return {
    activePresetId:
      typeof input?.activePresetId === 'string' && input.activePresetId.length > 0
        ? input.activePresetId
        : fallbackPreset.id,
    customGradient: normalizePreset(input?.customGradient ?? fallbackPreset),
    shape: normalizeShape(input?.shape),
    blendMode: BLEND_MODES.has(input?.blendMode as BlendMode)
      ? (input?.blendMode as BlendMode)
      : 'normal',
    opacity: clamp01(typeof input?.opacity === 'number' ? input.opacity : 1),
    reverse: input?.reverse === true,
    dither: input?.dither === true,
    transparency: input?.transparency !== false,
  };
}

function resolvePresetOrFallback(
  presets: GradientPreset[],
  presetId: string | null,
  fallback: GradientPreset
): GradientPreset {
  if (!presetId) return fallback;
  return presets.find((item) => item.id === presetId) ?? fallback;
}

function presetUsesTransparencyStops(preset: GradientPreset): boolean {
  return preset.opacityStops.some((stop) => stop.opacity < 0.999);
}

function sortByPosition<T extends { position: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.position - b.position);
}

type GradientSelectionState = Pick<
  GradientState,
  'settings' | 'selectedColorStopId' | 'selectedOpacityStopId'
>;

function syncSelectedStopsWithCustomGradient(state: GradientSelectionState): void {
  state.selectedColorStopId = state.settings.customGradient.colorStops[0]?.id ?? null;
  state.selectedOpacityStopId = state.settings.customGradient.opacityStops[0]?.id ?? null;
}

function applyPresetToCustomGradient(
  state: GradientSelectionState,
  preset: GradientPreset,
  options?: { setActivePresetId?: boolean }
): void {
  if (options?.setActivePresetId === true) {
    state.settings.activePresetId = preset.id;
  }
  state.settings.customGradient = clonePreset(preset);
  if (presetUsesTransparencyStops(preset)) {
    state.settings.transparency = true;
  }
  syncSelectedStopsWithCustomGradient(state);
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

export const useGradientStore = create<GradientState>()(
  immer((set, get) => {
    const defaults = createDefaultPresets();
    const defaultPreset = defaults[0]!;
    const defaultSettings = createDefaultSettings(defaultPreset);

    const schedulePersist = (): void => {
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
      }
      persistTimer = setTimeout(() => {
        persistTimer = null;
        void get().saveToDisk();
      }, 120);
    };

    const updateAndPersist = (updater: (state: GradientState) => void): void => {
      set(updater);
      schedulePersist();
    };

    return {
      isLoaded: false,
      presets: defaults,
      settings: defaultSettings,
      selectedColorStopId: defaultSettings.customGradient.colorStops[0]?.id ?? null,
      selectedOpacityStopId: defaultSettings.customGradient.opacityStops[0]?.id ?? null,

      setShape: (shape) => {
        updateAndPersist((state) => {
          state.settings.shape = normalizeShape(shape);
        });
      },

      setBlendMode: (blendMode) => {
        updateAndPersist((state) => {
          state.settings.blendMode = BLEND_MODES.has(blendMode) ? blendMode : 'normal';
        });
      },

      setOpacity: (opacity) => {
        updateAndPersist((state) => {
          state.settings.opacity = clamp01(opacity);
        });
      },

      setReverse: (reverse) => {
        updateAndPersist((state) => {
          state.settings.reverse = reverse;
        });
      },

      setDither: (dither) => {
        updateAndPersist((state) => {
          state.settings.dither = dither;
        });
      },

      setTransparency: (enabled) => {
        updateAndPersist((state) => {
          state.settings.transparency = enabled;
        });
      },

      setActivePreset: (presetId) => {
        updateAndPersist((state) => {
          const fallback = state.presets[0] ?? defaultPreset;
          const preset = resolvePresetOrFallback(state.presets, presetId, fallback);
          applyPresetToCustomGradient(state, preset, { setActivePresetId: true });
        });
      },

      copyPresetToCustom: (presetId) => {
        updateAndPersist((state) => {
          const fallback = state.presets[0] ?? defaultPreset;
          const preset = resolvePresetOrFallback(state.presets, presetId, fallback);
          applyPresetToCustomGradient(state, preset);
        });
      },

      setCustomGradientName: (name) => {
        updateAndPersist((state) => {
          const trimmed = name.trim();
          state.settings.customGradient.name = trimmed.length > 0 ? trimmed : 'Untitled Gradient';
        });
      },

      selectColorStop: (id) => {
        set((state) => {
          state.selectedColorStopId = id;
        });
      },

      selectOpacityStop: (id) => {
        set((state) => {
          state.selectedOpacityStopId = id;
        });
      },

      addColorStop: (position, options) => {
        const id = createId('color');
        updateAndPersist((state) => {
          const source: ColorStopSource =
            options?.source === 'foreground' || options?.source === 'background'
              ? options.source
              : options?.source === 'fixed'
                ? 'fixed'
                : 'fixed';
          const nextStop: ColorStop = {
            id,
            position: clampPosition(position),
            midpoint: clampMidpoint(options?.midpoint ?? 0.5),
            source,
            color: toHexColor(options?.color ?? '#ffffff', '#ffffff'),
          };
          state.settings.customGradient.colorStops = sortByPosition([
            ...state.settings.customGradient.colorStops,
            nextStop,
          ]);
          state.selectedColorStopId = id;
        });
        return id;
      },

      updateColorStop: (id, patch) => {
        updateAndPersist((state) => {
          const nextStops = state.settings.customGradient.colorStops.map((stop) => {
            if (stop.id !== id) return stop;
            const source: ColorStopSource =
              patch.source === 'foreground' || patch.source === 'background'
                ? patch.source
                : patch.source === 'fixed'
                  ? 'fixed'
                  : stop.source;
            return {
              ...stop,
              source,
              color: toHexColor(patch.color ?? stop.color, stop.color),
              position:
                typeof patch.position === 'number' ? clampPosition(patch.position) : stop.position,
              midpoint:
                typeof patch.midpoint === 'number' ? clampMidpoint(patch.midpoint) : stop.midpoint,
            };
          });
          state.settings.customGradient.colorStops = sortByPosition(nextStops);
        });
      },

      removeColorStop: (id) => {
        updateAndPersist((state) => {
          if (state.settings.customGradient.colorStops.length <= 2) return;
          const filtered = state.settings.customGradient.colorStops.filter(
            (stop) => stop.id !== id
          );
          state.settings.customGradient.colorStops = normalizeColorStops(filtered);
          if (state.selectedColorStopId === id) {
            state.selectedColorStopId = state.settings.customGradient.colorStops[0]?.id ?? null;
          }
        });
      },

      addOpacityStop: (position, options) => {
        const id = createId('opacity');
        updateAndPersist((state) => {
          const nextStop: OpacityStop = {
            id,
            position: clampPosition(position),
            midpoint: clampMidpoint(options?.midpoint ?? 0.5),
            opacity: clamp01(options?.opacity ?? 1),
          };
          state.settings.customGradient.opacityStops = sortByPosition([
            ...state.settings.customGradient.opacityStops,
            nextStop,
          ]);
          state.selectedOpacityStopId = id;
        });
        return id;
      },

      updateOpacityStop: (id, patch) => {
        updateAndPersist((state) => {
          const nextStops = state.settings.customGradient.opacityStops.map((stop) => {
            if (stop.id !== id) return stop;
            return {
              ...stop,
              position:
                typeof patch.position === 'number' ? clampPosition(patch.position) : stop.position,
              midpoint:
                typeof patch.midpoint === 'number' ? clampMidpoint(patch.midpoint) : stop.midpoint,
              opacity: typeof patch.opacity === 'number' ? clamp01(patch.opacity) : stop.opacity,
            };
          });
          state.settings.customGradient.opacityStops = sortByPosition(nextStops);
        });
      },

      removeOpacityStop: (id) => {
        updateAndPersist((state) => {
          if (state.settings.customGradient.opacityStops.length <= 2) return;
          const filtered = state.settings.customGradient.opacityStops.filter(
            (stop) => stop.id !== id
          );
          state.settings.customGradient.opacityStops = normalizeOpacityStops(filtered);
          if (state.selectedOpacityStopId === id) {
            state.selectedOpacityStopId = state.settings.customGradient.opacityStops[0]?.id ?? null;
          }
        });
      },

      saveCustomAsPreset: (name) => {
        const presetId = createId('preset');
        updateAndPersist((state) => {
          const preset = normalizePreset({
            ...clonePreset(state.settings.customGradient),
            id: presetId,
            name: name.trim() || `Custom ${state.presets.length + 1}`,
          });
          state.presets.push(preset);
          state.settings.activePresetId = preset.id;
          state.settings.customGradient = clonePreset(preset);
        });
        return presetId;
      },

      renamePreset: (id, name) => {
        updateAndPersist((state) => {
          const target = state.presets.find((preset) => preset.id === id);
          if (!target) return;
          const trimmed = name.trim();
          if (trimmed.length === 0) return;
          target.name = trimmed;
          if (state.settings.activePresetId === id) {
            state.settings.customGradient.name = trimmed;
          }
        });
      },

      deletePreset: (id) => {
        updateAndPersist((state) => {
          state.presets = state.presets.filter((preset) => preset.id !== id);
          if (state.presets.length === 0) {
            state.presets = createDefaultPresets();
          }

          if (state.settings.activePresetId === id) {
            const fallback = state.presets[0]!;
            applyPresetToCustomGradient(state, fallback, { setActivePresetId: true });
          }
        });
      },

      loadFromDisk: async () => {
        try {
          const present = await exists(GRADIENT_FILE, { baseDir: BaseDirectory.AppConfig });
          if (!present) {
            set((state) => {
              state.isLoaded = true;
            });
            await get().saveToDisk();
            return;
          }

          const raw = await readTextFile(GRADIENT_FILE, { baseDir: BaseDirectory.AppConfig });
          const parsed = JSON.parse(raw) as Partial<GradientPersistedState>;
          const presets = Array.isArray(parsed.presets)
            ? parsed.presets.map((item) => normalizePreset(item))
            : createDefaultPresets();
          const fallback = presets[0] ?? createDefaultPresets()[0]!;
          const settings = normalizeSettings(parsed.settings, fallback);
          const activePreset = resolvePresetOrFallback(presets, settings.activePresetId, fallback);

          set((state) => {
            state.presets = presets;
            state.settings = {
              ...settings,
              activePresetId: activePreset.id,
              customGradient: normalizePreset(settings.customGradient),
            };
            syncSelectedStopsWithCustomGradient(state);
            state.isLoaded = true;
          });

          const shouldResave = parsed.version !== GRADIENT_SCHEMA_VERSION;
          if (shouldResave) {
            await get().saveToDisk();
          }
        } catch {
          set((state) => {
            state.isLoaded = true;
          });
        }
      },

      saveToDisk: async () => {
        try {
          const state = get();
          const payload: GradientPersistedState = {
            version: GRADIENT_SCHEMA_VERSION,
            presets: state.presets.map((preset) => clonePreset(preset)),
            settings: {
              ...state.settings,
              customGradient: clonePreset(state.settings.customGradient),
            },
          };
          await writeTextFile(GRADIENT_FILE, JSON.stringify(payload, null, 2), {
            baseDir: BaseDirectory.AppConfig,
          });
        } catch {
          // best effort
        }
      },
    };
  })
);

let initializePromise: Promise<void> | null = null;

export async function initializeGradientStore(): Promise<void> {
  if (!initializePromise) {
    initializePromise = useGradientStore.getState().loadFromDisk();
  }
  await initializePromise;
}
