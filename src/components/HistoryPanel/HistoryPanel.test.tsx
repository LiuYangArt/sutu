import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Layer } from '@/stores/document';
import type { SelectionSnapshot } from '@/stores/selection';
import { useHistoryStore } from '@/stores/history';
import { HistoryPanel } from './index';

type HistoryPanelWindow = Window & {
  __canvasHistoryJumpTo?: (targetIndex: number) => Promise<boolean>;
};

function createLayer(id: string, name: string): Layer {
  return {
    id,
    name,
    type: 'raster',
    visible: true,
    locked: false,
    opacity: 100,
    blendMode: 'normal',
    isBackground: false,
  };
}

function createSelectionSnapshot(hasSelection: boolean): SelectionSnapshot {
  return {
    hasSelection,
    selectionMask: hasSelection ? new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1) : null,
    selectionMaskPending: false,
    selectionPath: hasSelection ? [[{ x: 0, y: 0, type: 'polygonal' }]] : [],
    bounds: hasSelection ? { x: 0, y: 0, width: 1, height: 1 } : null,
  };
}

function seedMixedTimeline(): void {
  const store = useHistoryStore.getState();
  const layer = createLayer('layer_a', 'Layer A');
  store.pushAddLayer(layer.id, layer, 0);
  store.pushSelection(createSelectionSnapshot(false));
  store.pushLayerProps([
    {
      layerId: layer.id,
      beforeOpacity: 100,
      beforeBlendMode: 'normal',
      afterOpacity: 75,
      afterBlendMode: 'normal',
    },
  ]);
  store.undo();
}

describe('HistoryPanel', () => {
  beforeEach(() => {
    useHistoryStore.getState().clear();
    delete (window as HistoryPanelWindow).__canvasHistoryJumpTo;
  });

  it('renders empty state when there is no history', () => {
    render(<HistoryPanel />);
    expect(screen.getByText('No history yet.')).toBeInTheDocument();
  });

  it('renders mixed undo/redo timeline with current and future styles', () => {
    seedMixedTimeline();

    render(<HistoryPanel />);

    expect(screen.getByText('Add Layer')).toBeInTheDocument();
    expect(screen.getByText('Selection Change')).toBeInTheDocument();
    expect(screen.getByText('Layer Properties')).toBeInTheDocument();

    const currentItem = screen.getByText('Selection Change').closest('li');
    const futureItem = screen.getByText('Layer Properties').closest('li');
    expect(currentItem).toHaveClass('history-panel__item--current');
    expect(futureItem).toHaveClass('history-panel__item--future');
  });

  it('calls __canvasHistoryJumpTo with correct timeline index on click', async () => {
    seedMixedTimeline();
    const jumpToSpy = vi.fn(async () => true);
    (window as HistoryPanelWindow).__canvasHistoryJumpTo = jumpToSpy;

    render(<HistoryPanel />);

    fireEvent.click(screen.getByRole('button', { name: /Layer Properties/i }));

    await waitFor(() => {
      expect(jumpToSpy).toHaveBeenCalledWith(2);
    });
  });

  it('prevents re-entry while history jump is pending', async () => {
    seedMixedTimeline();
    let resolveJump: ((value: boolean) => void) | null = null;
    const jumpToSpy = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveJump = resolve;
        })
    );
    (window as HistoryPanelWindow).__canvasHistoryJumpTo = jumpToSpy;

    render(<HistoryPanel />);
    const targetButton = screen.getByRole('button', { name: /Layer Properties/i });

    fireEvent.click(targetButton);
    fireEvent.click(targetButton);
    expect(jumpToSpy).toHaveBeenCalledTimes(1);

    resolveJump?.(true);
    await waitFor(() => {
      expect(targetButton).not.toBeDisabled();
    });
  });
});
