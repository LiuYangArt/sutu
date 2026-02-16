import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SettingsPanel } from '../index';
import { useSettingsStore } from '@/stores/settings';
import { useI18nStore } from '@/stores/i18n';

function seedI18nState(): void {
  useI18nStore.setState((state) => ({
    ...state,
    catalogs: {
      'en-US': {
        meta: { code: 'en-US', displayName: 'English', nativeName: 'English' },
        source: 'builtin',
        messages: {
          'settings.title': 'Settings',
          'settings.tab.appearance': 'Appearance',
          'settings.tab.general': 'General',
          'settings.tab.brush': 'Brush',
          'settings.tab.tablet': 'Tablet',
          'settings.general.language': 'Language',
          'settings.general.languageDesc': 'UI language',
          'settings.general.autoSave': 'Autosave',
          'settings.general.autoSaveDesc': 'Save every N minutes',
          'settings.general.startup': 'Startup',
          'settings.general.openLastFileOnStartup': 'Open last file on startup',
        },
      },
      'zh-CN': {
        meta: { code: 'zh-CN', displayName: '简体中文', nativeName: '简体中文' },
        source: 'builtin',
        messages: {
          'settings.title': '设置',
          'settings.tab.appearance': '外观',
          'settings.tab.general': '通用',
          'settings.tab.brush': '画笔',
          'settings.tab.tablet': '数位板',
          'settings.general.language': '语言',
          'settings.general.languageDesc': '界面语言',
          'settings.general.autoSave': '自动保存',
          'settings.general.autoSaveDesc': '每 N 分钟保存',
          'settings.general.startup': '启动',
          'settings.general.openLastFileOnStartup': '启动时打开最近文件',
        },
      },
      'ja-JP': {
        meta: { code: 'ja-JP', displayName: '日本語', nativeName: '日本語' },
        source: 'external',
        messages: {
          'settings.title': '設定',
        },
      },
    },
    availableLocales: [
      { code: 'en-US', displayName: 'English', nativeName: 'English' },
      { code: 'zh-CN', displayName: '简体中文', nativeName: '简体中文' },
      { code: 'ja-JP', displayName: '日本語', nativeName: '日本語' },
    ],
    currentLocale: 'en-US',
    initialized: true,
  }));
}

describe('SettingsPanel language selector', () => {
  let consoleErrorSpy: any;

  beforeEach(() => {
    vi.useFakeTimers();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    seedI18nState();
    useSettingsStore.setState((state) => ({
      ...state,
      isOpen: true,
      activeTab: 'general',
      general: {
        ...state.general,
        language: 'en-US',
      },
    }));
  });

  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
    consoleErrorSpy.mockRestore();
    useSettingsStore.setState((state) => ({
      ...state,
      isOpen: false,
      activeTab: 'appearance',
    }));
  });

  it('renders dynamic locale options from i18n store and syncs selected language', () => {
    render(<SettingsPanel />);

    const languageSelect = screen.getByLabelText('Language');
    expect(screen.getByRole('option', { name: 'English (English)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '简体中文 (简体中文)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '日本語 (日本語)' })).toBeInTheDocument();

    act(() => {
      fireEvent.change(languageSelect, { target: { value: 'zh-CN' } });
      vi.runOnlyPendingTimers();
    });

    expect(useSettingsStore.getState().general.language).toBe('zh-CN');
    expect(useI18nStore.getState().currentLocale).toBe('zh-CN');
  });
});
