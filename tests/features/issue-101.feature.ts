/**
 * @description 功能测试: [Feature]: 增加历史记录面板
 * @issue #101
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, renderHook, act } from '@testing-library/react';
import React from 'react';
import type { Layer } from '@/stores/document';
import type { SelectionSnapshot } from '@/stores/selection';
import { useHistoryStore } from '@/stores/history';
import { HistoryPanel } from '@/components/HistoryPanel';
import { useKeyboardShortcuts } from '@/components/Canvas/useKeyboardShortcuts';

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

function dispatchWindowKeyDown(init: KeyboardEventInit & { code: string }): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ...init,
    })
  );
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

describe('[Feature]: 增加历史记录面板', () => {
  beforeEach(() => {
    useHistoryStore.getState().clear();
    delete (window as HistoryPanelWindow).__canvasHistoryJumpTo;
  });

  it('shows full timeline including redo entries and highlights current step', () => {
    seedMixedTimeline();
    render(React.createElement(HistoryPanel));

    expect(screen.getByText('Add Layer')).toBeInTheDocument();
    expect(screen.getByText('Selection Change')).toBeInTheDocument();
    expect(screen.getByText('Layer Properties')).toBeInTheDocument();
    expect(screen.getByText('Selection Change').closest('li')).toHaveClass('history-panel__item--current');
    expect(screen.getByText('Layer Properties').closest('li')).toHaveClass('history-panel__item--future');
  });

  it('jumps to selected timeline step when clicking an entry', async () => {
    seedMixedTimeline();
    const jumpToSpy = vi.fn(async () => true);
    (window as HistoryPanelWindow).__canvasHistoryJumpTo = jumpToSpy;

    render(React.createElement(HistoryPanel));
    fireEvent.click(screen.getByRole('button', { name: /Layer Properties/i }));

    await waitFor(() => {
      expect(jumpToSpy).toHaveBeenCalledWith(2);
    });
  });

  it('toggles history panel via Ctrl/Cmd+H shortcut callback', () => {
    const handleToggleHistoryPanel = vi.fn();

    renderHook(() =>
      useKeyboardShortcuts({
        currentTool: 'brush',
        currentSize: 50,
        setTool: vi.fn(),
        setCurrentSize: vi.fn(),
        handleUndo: vi.fn(),
        handleRedo: vi.fn(),
        selectAll: vi.fn(),
        deselectAll: vi.fn(),
        cancelSelection: vi.fn(),
        width: 100,
        height: 100,
        setIsPanning: vi.fn(),
        panStartRef: { current: null },
        handleToggleHistoryPanel,
      })
    );

    act(() => {
      dispatchWindowKeyDown({ code: 'KeyH', ctrlKey: true });
      dispatchWindowKeyDown({ code: 'KeyH', metaKey: true });
    });

    expect(handleToggleHistoryPanel).toHaveBeenCalledTimes(2);
  });
});
