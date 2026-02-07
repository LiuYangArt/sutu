import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NewFilePanel } from '../NewFilePanel';
import { DEFAULT_NEW_FILE_SETTINGS, useSettingsStore } from '@/stores/settings';
import { useToastStore } from '@/stores/toast';

function resetStores(): void {
  useSettingsStore.setState((state) => ({
    ...state,
    newFile: {
      customSizePresets: [],
      lastUsed: { ...DEFAULT_NEW_FILE_SETTINGS.lastUsed },
    },
  }));
  useToastStore.setState({ toasts: [] });
}

describe('NewFilePanel', () => {
  beforeEach(() => {
    resetStores();
    vi.spyOn(window, 'confirm').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fills width and height after selecting a preset and changing orientation', () => {
    render(
      <NewFilePanel
        isOpen
        onClose={() => {}}
        defaultValues={{ width: 1000, height: 1000 }}
        onCreate={() => {}}
      />
    );

    const selects = screen.getAllByRole('combobox');
    const presetSelect = selects[0];
    expect(presetSelect).toBeDefined();

    const spinButtons = screen.getAllByRole('spinbutton');
    const widthInput = spinButtons[0];
    const heightInput = spinButtons[1];
    expect(widthInput).toBeDefined();
    expect(heightInput).toBeDefined();

    fireEvent.change(presetSelect!, { target: { value: 'paper-a4' } });
    expect(widthInput!).toHaveValue(3508);
    expect(heightInput!).toHaveValue(2480);

    fireEvent.click(screen.getByRole('button', { name: 'Portrait' }));
    expect(widthInput!).toHaveValue(2480);
    expect(heightInput!).toHaveValue(3508);
  });

  it('blocks duplicated preset names ignoring case', () => {
    render(
      <NewFilePanel
        isOpen
        onClose={() => {}}
        defaultValues={{ width: 1000, height: 1000 }}
        onCreate={() => {}}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Preset name'), { target: { value: 'a4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Preset' }));

    expect(useSettingsStore.getState().newFile.customSizePresets).toHaveLength(0);
    const toasts = useToastStore.getState().toasts;
    const latestToast = toasts[toasts.length - 1];
    expect(latestToast?.message).toContain('already exists');
  });

  it('disables delete for default presets', () => {
    render(
      <NewFilePanel
        isOpen
        onClose={() => {}}
        defaultValues={{ width: 1000, height: 1000 }}
        onCreate={() => {}}
      />
    );

    const presetSelect = screen.getAllByRole('combobox')[0];
    expect(presetSelect).toBeDefined();
    fireEvent.change(presetSelect!, { target: { value: 'paper-a4' } });

    const deleteButton = screen.getByRole('button', { name: 'Delete Selected' });
    expect(deleteButton).toBeDisabled();
  });

  it('deletes custom preset after confirm', () => {
    useSettingsStore.setState((state) => ({
      ...state,
      newFile: {
        customSizePresets: [{ id: 'custom-card', name: 'Card', width: 1200, height: 1600 }],
        lastUsed: {
          width: 1200,
          height: 1600,
          backgroundPreset: 'white',
          presetId: 'custom-card',
          orientation: 'portrait',
        },
      },
    }));

    render(
      <NewFilePanel
        isOpen
        onClose={() => {}}
        defaultValues={{ width: 1000, height: 1000 }}
        onCreate={() => {}}
      />
    );

    const deleteButton = screen.getByRole('button', { name: 'Delete Selected' });
    expect(deleteButton).toBeEnabled();

    fireEvent.click(deleteButton);

    expect(window.confirm).toHaveBeenCalled();
    expect(useSettingsStore.getState().newFile.customSizePresets).toHaveLength(0);
  });
});
