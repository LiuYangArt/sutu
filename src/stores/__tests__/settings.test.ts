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
  });
});
