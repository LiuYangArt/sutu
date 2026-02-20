import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SelectionToolbar } from '../SelectionToolbar';
import { useSettingsStore } from '@/stores/settings';
import { useSelectionStore } from '@/stores/selection';
import { useToolStore } from '@/stores/tool';

function resetSelectionToolbarSettings(): void {
  useSettingsStore.setState((state) => ({
    ...state,
    general: {
      ...state.general,
      selectionAutoFillEnabled: false,
      selectionPreviewTranslucent: true,
    },
  }));

  useSelectionStore.getState().setSelectionShape('rect');
  useToolStore.setState((state) => ({
    ...state,
    currentTool: 'select',
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

  it('toggles marquee shape between rect and circle', () => {
    render(<SelectionToolbar />);

    const rectButton = screen.getByRole('button', { name: 'Rectangular Marquee' });
    const circleButton = screen.getByRole('button', { name: 'Elliptical Marquee' });

    expect(rectButton).toHaveAttribute('aria-pressed', 'true');
    expect(circleButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(circleButton);

    expect(useSelectionStore.getState().selectionShape).toBe('circle');
    expect(circleButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(rectButton);

    expect(useSelectionStore.getState().selectionShape).toBe('rect');
    expect(rectButton).toHaveAttribute('aria-pressed', 'true');
  });
});
