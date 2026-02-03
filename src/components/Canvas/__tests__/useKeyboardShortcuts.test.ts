import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import { useSelectionStore } from '@/stores/selection';
import type { ToolType } from '@/stores/tool';

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
): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ...init,
    })
  );
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
      dispatchWindowKeyDown({ code: 'KeyZ' });
    });

    expect(setTool).toHaveBeenCalledWith('brush');
    expect(setTool).toHaveBeenCalledWith('eraser');
    expect(setTool).toHaveBeenCalledWith('select');
    expect(setTool).toHaveBeenCalledWith('lasso');
    expect(setTool).toHaveBeenCalledWith('zoom');

    setTool.mockClear();
    setCurrentSize.mockClear();

    act(() => {
      dispatchWindowKeyDown({ code: 'KeyB', repeat: true });
      dispatchWindowKeyDown({ code: 'BracketLeft', repeat: true });
      dispatchWindowKeyDown({ code: 'BracketRight', repeat: true, shiftKey: true });
    });

    expect(setTool).not.toHaveBeenCalled();
    expect(setCurrentSize).toHaveBeenCalledWith(45);
    expect(setCurrentSize).toHaveBeenCalledWith(60);
  });

  it('skips tool shortcuts in input/textarea, but still allows Ctrl+Z', () => {
    const setTool = vi.fn<[ToolType], void>();
    const handleUndo = vi.fn();

    renderHook(() =>
      useKeyboardShortcuts({
        currentTool: 'brush',
        currentSize: 50,
        setTool,
        setCurrentSize: vi.fn(),
        handleUndo,
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

    const input = document.createElement('input');
    document.body.appendChild(input);

    act(() => {
      dispatchInputKeyDown(input, { code: 'KeyB' });
      dispatchInputKeyDown(input, { code: 'KeyZ', ctrlKey: true });
    });

    expect(setTool).not.toHaveBeenCalled();
    expect(handleUndo).toHaveBeenCalledTimes(1);

    input.remove();
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
