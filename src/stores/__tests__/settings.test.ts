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
        backendMigratedToMacNativeAt: null,
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
        language: 'en-US',
        autosaveIntervalMinutes: 10,
        openLastFileOnStartup: true,
        recentFiles: [],
        selectionAutoFillEnabled: false,
        selectionPreviewTranslucent: true,
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
          backendMigratedToMacNativeAt: null,
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
    expect(state.general.language).toBe('en-US');
    expect(state.general.recentFiles).toEqual([]);
    expect(state.general.selectionAutoFillEnabled).toBe(false);
    expect(state.general.selectionPreviewTranslucent).toBe(true);
    expect(state.quickExport).toEqual(DEFAULT_QUICK_EXPORT_SETTINGS);
    expect(state.brushLibrary.selectedPresetByTool).toEqual({
      brush: null,
      eraser: null,
    });
  });

  it('normalizes loaded recent files and keeps max 10', async () => {
    fsMocks.exists.mockResolvedValue(true);
    fsMocks.readTextFile.mockResolvedValue(
      JSON.stringify({
        general: {
          language: 'en-US',
          autosaveIntervalMinutes: 8,
          openLastFileOnStartup: true,
          recentFiles: [
            'C:\\A.psd',
            'C:\\B.ora',
            '  ',
            'C:\\A.PSD',
            null,
            'C:\\C.psd',
            'C:\\D.psd',
            'C:\\E.psd',
            'C:\\F.psd',
            'C:\\G.psd',
            'C:\\H.psd',
            'C:\\I.psd',
            'C:\\J.psd',
            'C:\\K.psd',
          ],
        },
      })
    );

    await useSettingsStore.getState()._loadSettings();
    const state = useSettingsStore.getState();

    expect(state.general.recentFiles).toEqual([
      'C:\\A.psd',
      'C:\\B.ora',
      'C:\\C.psd',
      'C:\\D.psd',
      'C:\\E.psd',
      'C:\\F.psd',
      'C:\\G.psd',
      'C:\\H.psd',
      'C:\\I.psd',
      'C:\\J.psd',
    ]);
  });

  it('migrates legacy general settings without language to en-US', async () => {
    fsMocks.exists.mockResolvedValue(true);
    fsMocks.readTextFile.mockResolvedValue(
      JSON.stringify({
        general: {
          autosaveIntervalMinutes: 6,
          openLastFileOnStartup: false,
          recentFiles: ['C:\\legacy.psd'],
        },
      })
    );

    await useSettingsStore.getState()._loadSettings();
    const state = useSettingsStore.getState();

    expect(state.general.language).toBe('en-US');
    expect(state.general.autosaveIntervalMinutes).toBe(6);
    expect(state.general.openLastFileOnStartup).toBe(false);
    expect(state.general.recentFiles).toEqual(['C:\\legacy.psd']);
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
      maxSize: 1000,
      transparentBackground: false,
      backgroundPreset: 'black',
    });
    useSettingsStore.getState().addRecentFile('C:\\projects\\alpha.psd');
    useSettingsStore.getState().addRecentFile('C:\\projects\\beta.ora');
    useSettingsStore.getState().addRecentFile('C:\\projects\\ALPHA.psd');
    useSettingsStore.getState().setBrushLibrarySelectedPreset('brush', 'preset-soft-round');
    useSettingsStore.getState().setBrushLibrarySelectedPreset('eraser', 'preset-hard-eraser');

    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(fsMocks.writeTextFile).toHaveBeenCalled();
    const lastCall = fsMocks.writeTextFile.mock.calls[fsMocks.writeTextFile.mock.calls.length - 1];
    expect(lastCall).toBeDefined();
    const content = String(lastCall?.[1] ?? '{}');
    const parsed = JSON.parse(content) as {
      general?: {
        language?: string;
        autosaveIntervalMinutes?: number;
        openLastFileOnStartup?: boolean;
        recentFiles?: string[];
        selectionAutoFillEnabled?: boolean;
        selectionPreviewTranslucent?: boolean;
      };
      quickExport?: {
        lastPath?: string;
        lastFormat?: string;
        maxSize?: number;
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
    expect(parsed.general?.language).toBe('en-US');
    expect(parsed.general?.recentFiles).toEqual([
      'C:\\projects\\ALPHA.psd',
      'C:\\projects\\beta.ora',
    ]);
    expect(parsed.general?.selectionAutoFillEnabled).toBe(false);
    expect(parsed.general?.selectionPreviewTranslucent).toBe(true);
    expect(parsed.quickExport?.lastPath).toBe('D:\\exports\\sample.png');
    expect(parsed.quickExport?.lastFormat).toBe('png');
    expect(parsed.quickExport?.maxSize).toBe(1000);
    expect(parsed.quickExport?.transparentBackground).toBe(false);
    expect(parsed.quickExport?.backgroundPreset).toBe('black');
    expect(parsed.brushLibrary?.selectedPresetByTool?.brush).toBe('preset-soft-round');
    expect(parsed.brushLibrary?.selectedPresetByTool?.eraser).toBe('preset-hard-eraser');
  });

  it('persists language changes', async () => {
    fsMocks.exists.mockResolvedValue(false);
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.writeTextFile.mockResolvedValue(undefined);

    await useSettingsStore.getState()._loadSettings();
    useSettingsStore.getState().setLanguage('zh-CN');
    await new Promise((resolve) => setTimeout(resolve, 600));

    const lastCall = fsMocks.writeTextFile.mock.calls[fsMocks.writeTextFile.mock.calls.length - 1];
    const content = String(lastCall?.[1] ?? '{}');
    const parsed = JSON.parse(content) as { general?: { language?: string } };

    expect(parsed.general?.language).toBe('zh-CN');
  });

  it('migrates legacy quickExport width/height into maxSize', async () => {
    fsMocks.exists.mockResolvedValue(true);
    fsMocks.readTextFile.mockResolvedValue(
      JSON.stringify({
        quickExport: {
          lastPath: 'D:\\exports\\legacy.png',
          lastFormat: 'png',
          lastWidth: 960,
          lastHeight: 540,
          transparentBackground: true,
          backgroundPreset: 'current-bg',
        },
      })
    );

    await useSettingsStore.getState()._loadSettings();
    const state = useSettingsStore.getState();

    expect(state.quickExport.maxSize).toBe(960);
  });

  it('loads and persists selection preview toggles', async () => {
    fsMocks.exists.mockResolvedValue(true);
    fsMocks.readTextFile.mockResolvedValue(
      JSON.stringify({
        general: {
          language: 'en-US',
          autosaveIntervalMinutes: 12,
          openLastFileOnStartup: true,
          recentFiles: [],
          selectionAutoFillEnabled: true,
          selectionPreviewTranslucent: false,
        },
      })
    );
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.writeTextFile.mockResolvedValue(undefined);

    await useSettingsStore.getState()._loadSettings();
    expect(useSettingsStore.getState().general.language).toBe('en-US');
    expect(useSettingsStore.getState().general.selectionAutoFillEnabled).toBe(true);
    expect(useSettingsStore.getState().general.selectionPreviewTranslucent).toBe(false);

    useSettingsStore.getState().setSelectionAutoFillEnabled(false);
    useSettingsStore.getState().setSelectionPreviewTranslucent(true);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const lastCall = fsMocks.writeTextFile.mock.calls[fsMocks.writeTextFile.mock.calls.length - 1];
    const content = String(lastCall?.[1] ?? '{}');
    const parsed = JSON.parse(content) as {
      general?: {
        language?: string;
        selectionAutoFillEnabled?: boolean;
        selectionPreviewTranslucent?: boolean;
      };
    };
    expect(parsed.general?.language).toBe('en-US');
    expect(parsed.general?.selectionAutoFillEnabled).toBe(false);
    expect(parsed.general?.selectionPreviewTranslucent).toBe(true);
  });

  it('auto-migrates legacy macOS pointerevent backend to macnative once', async () => {
    fsMocks.exists.mockResolvedValue(true);
    fsMocks.readTextFile.mockResolvedValue(
      JSON.stringify({
        tablet: {
          backend: 'pointerevent',
          pollingRate: 200,
          pressureCurve: 'linear',
          backpressureMode: 'lossless',
          autoStart: true,
        },
      })
    );

    const originalPlatform = navigator.platform;
    Object.defineProperty(window.navigator, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });

    try {
      await useSettingsStore.getState()._loadSettings();
      const state = useSettingsStore.getState();
      expect(state.tablet.backend).toBe('macnative');
      expect(typeof state.tablet.backendMigratedToMacNativeAt).toBe('string');
      expect(state.tablet.backendMigratedToMacNativeAt).toBeTruthy();
    } finally {
      Object.defineProperty(window.navigator, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('does not remigrate macOS backend when migration marker exists', async () => {
    const migratedAt = '2026-02-14T00:00:00.000Z';
    fsMocks.exists.mockResolvedValue(true);
    fsMocks.readTextFile.mockResolvedValue(
      JSON.stringify({
        tablet: {
          backend: 'pointerevent',
          backendMigratedToMacNativeAt: migratedAt,
          pollingRate: 200,
          pressureCurve: 'linear',
          backpressureMode: 'lossless',
          autoStart: true,
        },
      })
    );

    const originalPlatform = navigator.platform;
    Object.defineProperty(window.navigator, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });

    try {
      await useSettingsStore.getState()._loadSettings();
      const state = useSettingsStore.getState();
      expect(state.tablet.backend).toBe('pointerevent');
      expect(state.tablet.backendMigratedToMacNativeAt).toBe(migratedAt);
    } finally {
      Object.defineProperty(window.navigator, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });
});
