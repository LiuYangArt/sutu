import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import { useSelectionStore } from '@/stores/selection';
import { useHistoryStore } from '@/stores/history';
import type { ToolType } from '@/stores/tool';
import type { SelectionSnapshot } from '@/stores/selection';

function dispatchWindowKeyDown(init: KeyboardEventInit & { code: string }): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ...init,
    })
  );
}

function dispatchWindowKeyUp(init: KeyboardEventInit & { code: string }): void {
  window.dispatchEvent(
    new KeyboardEvent('keyup', {
      bubbles: true,
      cancelable: true,
      ...init,
    })
  );
}

function dispatchInputKeyDown(
  target: HTMLInputElement | HTMLTextAreaElement,
  init: KeyboardEventInit & { code: string }
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    // Ensure selection store starts in a stable state
    useSelectionStore.setState({ isMoving: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y', () => {
    const handleUndo = vi.fn();
    const handleRedo = vi.fn();

    renderHook(() =>
      useKeyboardShortcuts({
        currentTool: 'brush',
        currentSize: 50,
        setTool: vi.fn(),
        setCurrentSize: vi.fn(),
        handleUndo,
        handleRedo,
        selectAll: vi.fn(),
        deselectAll: vi.fn(),
        cancelSelection: vi.fn(),
        width: 100,
        height: 100,
        setIsPanning: vi.fn(),
        panStartRef: { current: null },
      })
    );

    act(() => {
      dispatchWindowKeyDown({ code: 'KeyZ', ctrlKey: true });
      dispatchWindowKeyDown({ code: 'KeyZ', ctrlKey: true, shiftKey: true });
      dispatchWindowKeyDown({ code: 'KeyY', ctrlKey: true });
    });

    expect(handleUndo).toHaveBeenCalledTimes(1);
    expect(handleRedo).toHaveBeenCalledTimes(2);
  });

  it('handles Ctrl+J: duplicate active layer', () => {
    const handleDuplicateActiveLayer = vi.fn();

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
        handleDuplicateActiveLayer,
      })
    );

    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyJ',
      ctrlKey: true,
    });

    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(handleDuplicateActiveLayer).toHaveBeenCalledTimes(1);
  });

  it('handles tool switching keys and ignores repeats (except brackets)', () => {
    const setTool = vi.fn<[ToolType], void>();
    const setCurrentSize = vi.fn<[number], void>();

    renderHook(() =>
      useKeyboardShortcuts({
        currentTool: 'brush',
        currentSize: 50,
        setTool,
        setCurrentSize,
        handleUndo: vi.fn(),
        handleRedo: vi.fn(),
        selectAll: vi.fn(),
        deselectAll: vi.fn(),
        cancelSelection: vi.fn(),
        width: 100,
        height: 100,
        setIsPanning: vi.fn(),
        panStartRef: { current: null },
      })
    );

    act(() => {
      dispatchWindowKeyDown({ code: 'KeyB' });
      dispatchWindowKeyDown({ code: 'KeyE' });
      dispatchWindowKeyDown({ code: 'KeyM' });
      dispatchWindowKeyDown({ code: 'KeyS' });
      dispatchWindowKeyDown({ code: 'KeyV' });
      dispatchWindowKeyDown({ code: 'KeyZ' });
      dispatchWindowKeyDown({ code: 'KeyV', ctrlKey: true });
    });

    expect(setTool).toHaveBeenCalledWith('brush');
    expect(setTool).toHaveBeenCalledWith('eraser');
    expect(setTool).toHaveBeenCalledWith('select');
    expect(setTool).toHaveBeenCalledWith('lasso');
    expect(setTool).toHaveBeenCalledWith('move');
    expect(setTool).toHaveBeenCalledWith('zoom');
    expect(setTool).toHaveBeenCalledTimes(6);

    setTool.mockClear();
    setCurrentSize.mockClear();

    act(() => {
      dispatchWindowKeyDown({ code: 'KeyB', repeat: true });
      dispatchWindowKeyDown({ code: 'BracketLeft', repeat: true });
      dispatchWindowKeyDown({ code: 'BracketRight', repeat: true });
    });

    expect(setTool).not.toHaveBeenCalled();
    // Bracket keys should trigger setCurrentSize with non-linear stepped values
    // From 50px: BracketLeft decreases, BracketRight increases
    // We don't assert exact values since they depend on non-linear mapping,
    // but verify the calls were made
    expect(setCurrentSize).toHaveBeenCalledTimes(2);
    const calls = setCurrentSize.mock.calls;
    expect(calls[0]?.[0]).toBeLessThan(50); // BracketLeft decreased
    expect(calls[1]?.[0]).toBeGreaterThan(50); // BracketRight increased
  });

  it('does not intercept Ctrl+A/Z/Y/X/C/V/J in input/textarea', () => {
    const setTool = vi.fn<[ToolType], void>();
    const handleUndo = vi.fn();
    const handleRedo = vi.fn();
    const selectAll = vi.fn();
    const handleDuplicateActiveLayer = vi.fn();

    renderHook(() =>
      useKeyboardShortcuts({
        currentTool: 'brush',
        currentSize: 50,
        setTool,
        setCurrentSize: vi.fn(),
        handleUndo,
        handleRedo,
        selectAll,
        deselectAll: vi.fn(),
        cancelSelection: vi.fn(),
        width: 100,
        height: 100,
        setIsPanning: vi.fn(),
        panStartRef: { current: null },
        handleDuplicateActiveLayer,
      })
    );

    const input = document.createElement('input');
    document.body.appendChild(input);

    let events: KeyboardEvent[] = [];
    act(() => {
      dispatchInputKeyDown(input, { code: 'KeyB' });
      events = [
        dispatchInputKeyDown(input, { code: 'KeyA', ctrlKey: true }),
        dispatchInputKeyDown(input, { code: 'KeyZ', ctrlKey: true }),
        dispatchInputKeyDown(input, { code: 'KeyY', ctrlKey: true }),
        dispatchInputKeyDown(input, { code: 'KeyC', ctrlKey: true }),
        dispatchInputKeyDown(input, { code: 'KeyV', ctrlKey: true }),
        dispatchInputKeyDown(input, { code: 'KeyX', ctrlKey: true }),
        dispatchInputKeyDown(input, { code: 'KeyJ', ctrlKey: true }),
      ];
    });

    for (const event of events) {
      expect(event.defaultPrevented).toBe(false);
    }
    expect(setTool).not.toHaveBeenCalled();
    expect(handleUndo).not.toHaveBeenCalled();
    expect(handleRedo).not.toHaveBeenCalled();
    expect(selectAll).not.toHaveBeenCalled();
    expect(handleDuplicateActiveLayer).not.toHaveBeenCalled();

    input.remove();
  });

  it('handles Ctrl+A on window: selectAll + preventDefault', () => {
    const selectAll = vi.fn();

    renderHook(() =>
      useKeyboardShortcuts({
        currentTool: 'brush',
        currentSize: 50,
        setTool: vi.fn(),
        setCurrentSize: vi.fn(),
        handleUndo: vi.fn(),
        handleRedo: vi.fn(),
        selectAll,
        deselectAll: vi.fn(),
        cancelSelection: vi.fn(),
        width: 100,
        height: 100,
        setIsPanning: vi.fn(),
        panStartRef: { current: null },
      })
    );

    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyA',
      ctrlKey: true,
    });

    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(selectAll).toHaveBeenCalledWith(100, 100);
  });

  it('records selection history on Ctrl+A / Ctrl+D when selection changes', () => {
    useHistoryStore.getState().clear();

    const pushSelectionSpy = vi.fn();
    const originalPushSelection = useHistoryStore.getState().pushSelection;

    const originalCreateSnapshot = useSelectionStore.getState().createSnapshot;
    const createSnapshotSpy = vi.fn<[], SelectionSnapshot>();

    const beforeA: SelectionSnapshot = {
      hasSelection: false,
      selectionMask: null,
      selectionMaskPending: false,
      selectionPath: [],
      bounds: null,
    };
    const afterMaskA = new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1);
    const afterA: SelectionSnapshot = {
      hasSelection: true,
      selectionMask: afterMaskA,
      selectionMaskPending: false,
      selectionPath: [[{ x: 0, y: 0, type: 'polygonal' }]],
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    };

    const beforeD: SelectionSnapshot = afterA;
    const afterD: SelectionSnapshot = {
      hasSelection: false,
      selectionMask: null,
      selectionMaskPending: false,
      selectionPath: [],
      bounds: null,
    };

    createSnapshotSpy
      .mockReturnValueOnce(beforeA)
      .mockReturnValueOnce(afterA)
      .mockReturnValueOnce(beforeD)
      .mockReturnValueOnce(afterD);

    useHistoryStore.setState({ pushSelection: pushSelectionSpy });
    useSelectionStore.setState({ createSnapshot: createSnapshotSpy });

    let unmount: (() => void) | null = null;
    try {
      const hook = renderHook(() =>
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
        })
      );
      unmount = hook.unmount;

      act(() => {
        dispatchWindowKeyDown({ code: 'KeyA', ctrlKey: true });
        dispatchWindowKeyDown({ code: 'KeyD', ctrlKey: true });
      });

      expect(pushSelectionSpy).toHaveBeenCalledTimes(2);
      expect(pushSelectionSpy).toHaveBeenNthCalledWith(1, beforeA);
      expect(pushSelectionSpy).toHaveBeenNthCalledWith(2, beforeD);
    } finally {
      unmount?.();
      act(() => {
        useHistoryStore.setState({ pushSelection: originalPushSelection });
        useSelectionStore.setState({ createSnapshot: originalCreateSnapshot });
      });
    }
  });

  it('handles Escape: cancelMove when moving, otherwise cancelSelection', () => {
    const cancelSelection = vi.fn();
    const cancelMoveSpy = vi.spyOn(useSelectionStore.getState(), 'cancelMove');

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
        cancelSelection,
        width: 100,
        height: 100,
        setIsPanning: vi.fn(),
        panStartRef: { current: null },
      })
    );

    act(() => {
      useSelectionStore.setState({ isMoving: true });
      dispatchWindowKeyDown({ code: 'Escape' });
    });

    expect(cancelMoveSpy).toHaveBeenCalledTimes(1);
    expect(cancelSelection).not.toHaveBeenCalled();

    cancelMoveSpy.mockClear();
    cancelSelection.mockClear();

    act(() => {
      useSelectionStore.setState({ isMoving: false });
      dispatchWindowKeyDown({ code: 'Escape' });
    });

    expect(cancelMoveSpy).not.toHaveBeenCalled();
    expect(cancelSelection).toHaveBeenCalledTimes(1);
  });

  it('tracks Space pressed and resets panning state on keyup', () => {
    const setIsPanning = vi.fn();
    const panStartRef = { current: { x: 1, y: 2 } as { x: number; y: number } | null };

    const { result } = renderHook(() =>
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
        setIsPanning,
        panStartRef,
      })
    );

    act(() => {
      dispatchWindowKeyDown({ code: 'Space' });
    });
    expect(result.current.spacePressed).toBe(true);

    act(() => {
      dispatchWindowKeyUp({ code: 'Space' });
    });

    expect(result.current.spacePressed).toBe(false);
    expect(setIsPanning).toHaveBeenCalledWith(false);
    expect(panStartRef.current).toBeNull();
  });
});
