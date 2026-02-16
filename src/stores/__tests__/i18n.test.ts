import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  exists: vi.fn(),
  readDir: vi.fn(),
  readTextFile: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppConfig: 'AppConfig' },
  exists: fsMocks.exists,
  readDir: fsMocks.readDir,
  readTextFile: fsMocks.readTextFile,
}));

async function loadI18nModule() {
  vi.resetModules();
  return import('../i18n');
}

describe('i18n store', () => {
  beforeEach(() => {
    fsMocks.exists.mockReset();
    fsMocks.readDir.mockReset();
    fsMocks.readTextFile.mockReset();
    fsMocks.exists.mockResolvedValue(false);
    fsMocks.readDir.mockResolvedValue([]);
    fsMocks.readTextFile.mockResolvedValue('');
  });

  it('loads builtin locales successfully', async () => {
    const { initializeI18n, useI18nStore } = await loadI18nModule();
    const resolved = await initializeI18n('zh-CN');

    expect(resolved).toBe('zh-CN');
    const state = useI18nStore.getState();
    expect(state.availableLocales.some((item) => item.code === 'en-US')).toBe(true);
    expect(state.availableLocales.some((item) => item.code === 'zh-CN')).toBe(true);
    expect(state.translate('common.save')).toBe('保存');
  });

  it('scans external locale files and merges locale catalogs', async () => {
    fsMocks.exists.mockResolvedValue(true);
    fsMocks.readDir.mockResolvedValue([
      { isFile: true, name: 'ja-JP.json' },
      { isFile: true, name: 'en-US.json' },
    ]);
    fsMocks.readTextFile.mockImplementation(async (path: string) => {
      if (path === 'locales/ja-JP.json') {
        return JSON.stringify({
          meta: {
            code: 'ja-JP',
            displayName: 'Japanese',
            nativeName: '日本語',
          },
          messages: {
            'common.save': '保存する',
          },
        });
      }
      return JSON.stringify({
        meta: {
          code: 'en-US',
          displayName: 'English',
          nativeName: 'English',
        },
        messages: {
          'fileStore.error.unknownSaveError': 'External unknown save error',
        },
      });
    });

    const { initializeI18n, useI18nStore } = await loadI18nModule();
    const resolved = await initializeI18n('ja-JP');

    expect(resolved).toBe('ja-JP');
    const state = useI18nStore.getState();
    expect(state.availableLocales.some((item) => item.code === 'ja-JP')).toBe(true);
    expect(state.translate('common.save')).toBe('保存する');
    state.setLocale('en-US');
    expect(state.translate('fileStore.error.unknownSaveError')).toBe('External unknown save error');
  });

  it('allows external locale to override builtin keys', async () => {
    fsMocks.exists.mockResolvedValue(true);
    fsMocks.readDir.mockResolvedValue([{ isFile: true, name: 'en-US.json' }]);
    fsMocks.readTextFile.mockResolvedValue(
      JSON.stringify({
        meta: {
          code: 'en-US',
          displayName: 'English',
          nativeName: 'English',
        },
        messages: {
          'common.save': 'Save Project',
        },
      })
    );

    const { initializeI18n, useI18nStore } = await loadI18nModule();
    await initializeI18n('en-US');

    expect(useI18nStore.getState().translate('common.save')).toBe('Save Project');
  });

  it('uses fallback chain current locale -> en-US -> key', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { initializeI18n, useI18nStore } = await loadI18nModule();
    await initializeI18n('zh-CN');

    const state = useI18nStore.getState();
    expect(state.translate('i18n.test.onlyEnglish')).toBe('English-only fallback text');
    expect(state.translate('i18n.test.missing')).toBe('i18n.test.missing');
    warnSpy.mockRestore();
  });

  it('ignores invalid external JSON and does not block initialization', async () => {
    fsMocks.exists.mockResolvedValue(true);
    fsMocks.readDir.mockResolvedValue([{ isFile: true, name: 'broken.json' }]);
    fsMocks.readTextFile.mockResolvedValue('{ invalid json');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { initializeI18n, useI18nStore } = await loadI18nModule();
    const resolved = await initializeI18n('en-US');

    expect(resolved).toBe('en-US');
    expect(useI18nStore.getState().translate('common.save')).toBe('Save');
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
