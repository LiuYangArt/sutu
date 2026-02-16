import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Toolbar } from '../index';
import { useI18nStore } from '@/stores/i18n';
import { useSettingsStore } from '@/stores/settings';
import { useFileStore } from '@/stores/file';
import { useDocumentStore } from '@/stores/document';

function seedI18n(): void {
  useI18nStore.setState((state) => ({
    ...state,
    catalogs: {
      'en-US': {
        meta: { code: 'en-US', displayName: 'English', nativeName: 'English' },
        source: 'builtin',
        messages: {
          'toolbar.menu.title': 'Menu',
          'toolbar.menu.new': 'New',
          'toolbar.menu.open': 'Open',
          'toolbar.menu.openRecent': 'Open Recent',
          'toolbar.menu.noRecentFiles': 'No recent files',
          'toolbar.menu.save': 'Save',
          'toolbar.menu.saveAs': 'Save As',
          'toolbar.menu.export': 'Quick Export',
          'toolbar.menu.settings': 'Settings',
          'toolbar.menu.panels': 'Panels',
          'toolbar.menu.panels.brushSettings': 'Brush Settings',
          'toolbar.menu.panels.gradientEditor': 'Gradient Editor',
          'toolbar.menu.panels.history': 'History',
          'toolbar.menu.panels.patternLibrary': 'Pattern Library',
          'toolbar.menu.panels.brushLibrary': 'Brush Library',
          'toolbar.menu.exit': 'Exit',
          'toolbar.canvasSize': 'Canvas Size',
          'toolbar.quickExportShortcutTitle': 'Quick Export (Ctrl+Shift+E)',
          'toolbar.zoomOut': 'Zoom Out',
          'toolbar.zoomIn': 'Zoom In',
          'toolbar.resetZoom': 'Reset Zoom',
          'toolbar.undo': 'Undo',
          'toolbar.redo': 'Redo',
        },
      },
    },
    availableLocales: [{ code: 'en-US', displayName: 'English', nativeName: 'English' }],
    currentLocale: 'en-US',
    initialized: true,
  }));
}

describe('Toolbar i18n rendering', () => {
  beforeEach(() => {
    seedI18n();
    useSettingsStore.setState((state) => ({
      ...state,
      general: {
        ...state.general,
        recentFiles: [],
      },
    }));
    useFileStore.setState((state) => ({
      ...state,
      isSaving: false,
      isLoading: false,
    }));
    useDocumentStore.setState((state) => ({
      ...state,
      isDirty: false,
      filePath: null,
    }));
  });

  it('renders translated menu labels', () => {
    render(<Toolbar />);

    fireEvent.click(screen.getByTitle('Menu'));

    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Quick Export')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });
});
