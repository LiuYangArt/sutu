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

import { DEFAULT_NEW_FILE_SETTINGS, useSettingsStore } from '../settings';

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
        autoStart: true,
      },
      brush: {
        renderMode: 'gpu',
        colorBlendMode: 'linear',
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
    expect(state.general.autosaveIntervalMinutes).toBe(10);
    expect(state.general.openLastFileOnStartup).toBe(true);
  });

  it('persists general settings fields', async () => {
    fsMocks.exists.mockResolvedValue(false);
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.writeTextFile.mockResolvedValue(undefined);

    await useSettingsStore.getState()._loadSettings();
    useSettingsStore.getState().setAutosaveIntervalMinutes(15);
    useSettingsStore.getState().setOpenLastFileOnStartup(false);

    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(fsMocks.writeTextFile).toHaveBeenCalled();
    const lastCall = fsMocks.writeTextFile.mock.calls[fsMocks.writeTextFile.mock.calls.length - 1];
    expect(lastCall).toBeDefined();
    const content = String(lastCall?.[1] ?? '{}');
    const parsed = JSON.parse(content) as {
      general?: { autosaveIntervalMinutes?: number; openLastFileOnStartup?: boolean };
    };
    expect(parsed.general?.autosaveIntervalMinutes).toBe(15);
    expect(parsed.general?.openLastFileOnStartup).toBe(false);
  });
});
