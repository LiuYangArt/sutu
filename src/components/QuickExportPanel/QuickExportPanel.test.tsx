import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QuickExportPanel } from './QuickExportPanel';
import { useDocumentStore } from '@/stores/document';
import { DEFAULT_QUICK_EXPORT_SETTINGS, useSettingsStore } from '@/stores/settings';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  writeFile: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: mocks.save,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: mocks.writeFile,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

describe('QuickExportPanel', () => {
  beforeEach(() => {
    mocks.save.mockReset();
    mocks.writeFile.mockReset();
    mocks.invoke.mockReset();

    useDocumentStore.setState({
      width: 400,
      height: 200,
      filePath: 'D:\\Artwork\\sample.psd',
    });
    useSettingsStore.setState((state) => ({
      ...state,
      quickExport: {
        ...DEFAULT_QUICK_EXPORT_SETTINGS,
        lastPath: '',
        lastFormat: 'png',
        lastWidth: 400,
        lastHeight: 200,
        transparentBackground: true,
        backgroundPreset: 'current-bg',
      },
    }));
  });

  it('prefills export path from current document path when quick export path is empty', () => {
    render(<QuickExportPanel isOpen onClose={vi.fn()} />);
    expect(screen.getByLabelText('Export Path')).toHaveValue('D:\\Artwork\\sample.png');
  });

  it('keeps ratio locked when width changes', () => {
    render(<QuickExportPanel isOpen onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Export Width'), {
      target: { value: '800' },
    });

    expect(screen.getByLabelText('Export Height')).toHaveValue(400);
  });

  it('forces alpha off for JPG and updates path extension', () => {
    render(<QuickExportPanel isOpen onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Export Format'), {
      target: { value: 'jpg' },
    });

    expect(screen.getByLabelText('Transparent Background')).toBeDisabled();
    expect(screen.getByLabelText('Transparent Background')).not.toBeChecked();
    expect(screen.getByLabelText('Export Path')).toHaveValue('D:\\Artwork\\sample.jpg');
  });

  it('disables Export when no valid path is configured', () => {
    useDocumentStore.setState({ filePath: null });
    useSettingsStore.setState((state) => ({
      ...state,
      quickExport: {
        ...state.quickExport,
        lastPath: '',
      },
    }));

    render(<QuickExportPanel isOpen onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
  });
});
