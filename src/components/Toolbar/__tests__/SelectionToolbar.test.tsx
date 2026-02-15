import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SelectionToolbar } from '../SelectionToolbar';
import { useSettingsStore } from '@/stores/settings';

function resetSelectionToolbarSettings(): void {
  useSettingsStore.setState((state) => ({
    ...state,
    general: {
      ...state.general,
      selectionAutoFillEnabled: false,
      selectionPreviewTranslucent: true,
    },
  }));
}

describe('SelectionToolbar', () => {
  beforeEach(() => {
    resetSelectionToolbarSettings();
  });

  it('disables translucent preview toggle when auto fill is off', () => {
    render(<SelectionToolbar />);

    const previewToggle = screen.getByRole('button', { name: 'Translucent Preview' });
    expect(previewToggle).toBeDisabled();
  });

  it('enables translucent preview toggle after turning on auto fill', () => {
    render(<SelectionToolbar />);

    const autoFillToggle = screen.getByRole('button', { name: 'Auto Fill Selection' });
    const previewToggle = screen.getByRole('button', { name: 'Translucent Preview' });

    expect(previewToggle).toBeDisabled();
    fireEvent.click(autoFillToggle);

    expect(useSettingsStore.getState().general.selectionAutoFillEnabled).toBe(true);
    expect(previewToggle).not.toBeDisabled();
  });

  it('toggles translucent preview setting and active style', () => {
    useSettingsStore.setState((state) => ({
      ...state,
      general: {
        ...state.general,
        selectionAutoFillEnabled: true,
        selectionPreviewTranslucent: true,
      },
    }));

    render(<SelectionToolbar />);

    const previewToggle = screen.getByRole('button', { name: 'Translucent Preview' });

    expect(previewToggle).toHaveAttribute('aria-pressed', 'true');
    expect(previewToggle).toHaveClass('active');

    fireEvent.click(previewToggle);

    expect(useSettingsStore.getState().general.selectionPreviewTranslucent).toBe(false);
    expect(previewToggle).toHaveAttribute('aria-pressed', 'false');
    expect(previewToggle).not.toHaveClass('active');
  });
});
