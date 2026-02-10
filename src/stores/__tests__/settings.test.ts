import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  exists: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppConfig: 'AppConfig' },
  exists: fsMocks.exists,
  readTextFile: fsMocks.readTextFile,
  writeTextFile: fsMocks.writeTextFile,
  mkdir: fsMocks.mkdir,
}));

import {
  DEFAULT_NEW_FILE_SETTINGS,
  DEFAULT_QUICK_EXPORT_SETTINGS,
  useSettingsStore,
} from '../settings';

describe('settings store newFile persistence', () => {
  beforeEach(() => {
    fsMocks.exists.mockReset();
    fsMocks.readTextFile.mockReset();
    fsMocks.writeTextFile.mockReset();
    fsMocks.mkdir.mockReset();

    useSettingsStore.setState((state) => ({
      ...state,
      isLoaded: false,
      appearance: {
        accentColor: 'blue',
        panelBgColor: 'dark',
        canvasBgColor: 'dark-gray',
        enableBlur: true,
      },
      tablet: {
        backend: 'pointerevent',
        pollingRate: 200,
        pressureCurve: 'linear',
        backpressureMode: 'lossless',
        autoStart: true,
      },
      brush: {
        renderMode: 'gpu',
        gpuRenderScaleMode: 'off',
      },
      general: {
        autosaveIntervalMinutes: 10,
        openLastFileOnStartup: true,
      },
      newFile: {
        customSizePresets: [],
        lastUsed: { ...DEFAULT_NEW_FILE_SETTINGS.lastUsed },
      },
      quickExport: { ...DEFAULT_QUICK_EXPORT_SETTINGS },
      brushLibrary: {
        selectedPresetByTool: {
          brush: null,
          eraser: null,
        },
      },
    }));
  });

  it('merges legacy settings file without newFile section', async () => {
    fsMocks.exists.mockResolvedValue(true);
    fsMocks.readTextFile.mockResolvedValue(
      JSON.stringify({
        appearance: {
          accentColor: 'green',
          panelBgColor: 'dark',
          canvasBgColor: 'white',
          enableBlur: false,
        },
        tablet: {
          backend: 'pointerevent',
          pollingRate: 100,
          pressureCurve: 'hard',
          autoStart: false,
        },
        brush: {
          renderMode: 'cpu',
          colorBlendMode: 'srgb',
          gpuRenderScaleMode: 'auto',
        },
      })
    );

    await useSettingsStore.getState()._loadSettings();
    const state = useSettingsStore.getState();

    expect(state.isLoaded).toBe(true);
    expect(state.newFile.customSizePresets).toEqual([]);
    expect(state.newFile.lastUsed).toEqual(DEFAULT_NEW_FILE_SETTINGS.lastUsed);
    expect(state.brush.renderMode).toBe('cpu');
    expect(state.brush.gpuRenderScaleMode).toBe('auto');
    expect('colorBlendMode' in (state.brush as unknown as Record<string, unknown>)).toBe(false);
    expect(state.general.autosaveIntervalMinutes).toBe(10);
    expect(state.general.openLastFileOnStartup).toBe(true);
    expect(state.quickExport).toEqual(DEFAULT_QUICK_EXPORT_SETTINGS);
    expect(state.brushLibrary.selectedPresetByTool).toEqual({
      brush: null,
      eraser: null,
    });
  });

  it('persists general settings fields', async () => {
    fsMocks.exists.mockResolvedValue(false);
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.writeTextFile.mockResolvedValue(undefined);

    await useSettingsStore.getState()._loadSettings();
    useSettingsStore.getState().setAutosaveIntervalMinutes(15);
    useSettingsStore.getState().setOpenLastFileOnStartup(false);
    useSettingsStore.getState().setQuickExport({
      lastPath: 'D:\\exports\\sample.png',
      lastFormat: 'png',
      lastWidth: 1000,
      lastHeight: 500,
      transparentBackground: false,
      backgroundPreset: 'black',
    });
    useSettingsStore.getState().setBrushLibrarySelectedPreset('brush', 'preset-soft-round');
    useSettingsStore.getState().setBrushLibrarySelectedPreset('eraser', 'preset-hard-eraser');

    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(fsMocks.writeTextFile).toHaveBeenCalled();
    const lastCall = fsMocks.writeTextFile.mock.calls[fsMocks.writeTextFile.mock.calls.length - 1];
    expect(lastCall).toBeDefined();
    const content = String(lastCall?.[1] ?? '{}');
    const parsed = JSON.parse(content) as {
      general?: { autosaveIntervalMinutes?: number; openLastFileOnStartup?: boolean };
      quickExport?: {
        lastPath?: string;
        lastFormat?: string;
        lastWidth?: number;
        lastHeight?: number;
        transparentBackground?: boolean;
        backgroundPreset?: string;
      };
      brushLibrary?: {
        selectedPresetByTool?: {
          brush?: string | null;
          eraser?: string | null;
        };
      };
    };
    expect(parsed.general?.autosaveIntervalMinutes).toBe(15);
    expect(parsed.general?.openLastFileOnStartup).toBe(false);
    expect(parsed.quickExport?.lastPath).toBe('D:\\exports\\sample.png');
    expect(parsed.quickExport?.lastFormat).toBe('png');
    expect(parsed.quickExport?.lastWidth).toBe(1000);
    expect(parsed.quickExport?.lastHeight).toBe(500);
    expect(parsed.quickExport?.transparentBackground).toBe(false);
    expect(parsed.quickExport?.backgroundPreset).toBe('black');
    expect(parsed.brushLibrary?.selectedPresetByTool?.brush).toBe('preset-soft-round');
    expect(parsed.brushLibrary?.selectedPresetByTool?.eraser).toBe('preset-hard-eraser');
  });
});
