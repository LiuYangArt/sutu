import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAltEyedropper, createAltKeyEvent } from '../useAltEyedropper';
import { useToolStore, type ToolType } from '@/stores/tool';

describe('useAltEyedropper', () => {
  let previousToolRef: { current: ToolType | null };

  beforeEach(() => {
    previousToolRef = { current: null };
    // Reset store to default state
    useToolStore.setState({ currentTool: 'brush' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should switch to eyedropper when Alt is pressed with brush tool', () => {
    useToolStore.setState({ currentTool: 'brush' });

    renderHook(() => useAltEyedropper(previousToolRef as React.RefObject<ToolType | null>));

    // Simulate Alt keydown
    window.dispatchEvent(createAltKeyEvent('keydown'));

    expect(useToolStore.getState().currentTool).toBe('eyedropper');
    expect(previousToolRef.current).toBe('brush');
  });

  it('should switch to eyedropper when Alt is pressed with eraser tool', () => {
    useToolStore.setState({ currentTool: 'eraser' });

    renderHook(() => useAltEyedropper(previousToolRef as React.RefObject<ToolType | null>));

    window.dispatchEvent(createAltKeyEvent('keydown'));

    expect(useToolStore.getState().currentTool).toBe('eyedropper');
    expect(previousToolRef.current).toBe('eraser');
  });

  it('should NOT switch to eyedropper when Alt is pressed with other tools', () => {
    useToolStore.setState({ currentTool: 'lasso' });

    renderHook(() => useAltEyedropper(previousToolRef as React.RefObject<ToolType | null>));

    window.dispatchEvent(createAltKeyEvent('keydown'));

    // Tool should remain unchanged
    expect(useToolStore.getState().currentTool).toBe('lasso');
    expect(previousToolRef.current).toBeNull();
  });

  it('should restore previous tool when Alt is released', () => {
    useToolStore.setState({ currentTool: 'brush' });

    renderHook(() => useAltEyedropper(previousToolRef as React.RefObject<ToolType | null>));

    // Press Alt
    window.dispatchEvent(createAltKeyEvent('keydown'));
    expect(useToolStore.getState().currentTool).toBe('eyedropper');

    // Release Alt
    window.dispatchEvent(createAltKeyEvent('keyup'));
    expect(useToolStore.getState().currentTool).toBe('brush');
    expect(previousToolRef.current).toBeNull();
  });

  it('should ignore repeated keydown events (e.repeat: true)', () => {
    useToolStore.setState({ currentTool: 'brush' });

    renderHook(() => useAltEyedropper(previousToolRef as React.RefObject<ToolType | null>));

    // First press (should switch)
    window.dispatchEvent(createAltKeyEvent('keydown', { repeat: false }));
    expect(useToolStore.getState().currentTool).toBe('eyedropper');

    // Reset to test repeat behavior
    useToolStore.setState({ currentTool: 'brush' });
    previousToolRef.current = null;

    // Repeated keydown (should NOT switch)
    window.dispatchEvent(createAltKeyEvent('keydown', { repeat: true }));
    expect(useToolStore.getState().currentTool).toBe('brush');
    expect(previousToolRef.current).toBeNull();
  });

  it('should work with AltRight key as well', () => {
    useToolStore.setState({ currentTool: 'brush' });

    renderHook(() => useAltEyedropper(previousToolRef as React.RefObject<ToolType | null>));

    window.dispatchEvent(createAltKeyEvent('keydown', { code: 'AltRight' }));

    expect(useToolStore.getState().currentTool).toBe('eyedropper');
    expect(previousToolRef.current).toBe('brush');
  });

  it('should only restore if current tool is still eyedropper', () => {
    useToolStore.setState({ currentTool: 'brush' });

    renderHook(() => useAltEyedropper(previousToolRef as React.RefObject<ToolType | null>));

    // Press Alt
    window.dispatchEvent(createAltKeyEvent('keydown'));
    expect(useToolStore.getState().currentTool).toBe('eyedropper');

    // User manually switches to another tool while Alt is pressed
    useToolStore.setState({ currentTool: 'lasso' });

    // Release Alt - should NOT restore because tool was changed manually
    window.dispatchEvent(createAltKeyEvent('keyup'));
    expect(useToolStore.getState().currentTool).toBe('lasso');
  });

  it('should clean up event listeners on unmount', () => {
    useToolStore.setState({ currentTool: 'brush' });
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

    const { unmount } = renderHook(() =>
      useAltEyedropper(previousToolRef as React.RefObject<ToolType | null>)
    );

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(removeEventListenerSpy).toHaveBeenCalledWith('keyup', expect.any(Function));
  });

  it('should call onBeforeSwitch before switching to eyedropper', () => {
    useToolStore.setState({ currentTool: 'brush' });
    const onBeforeSwitch = vi.fn();
    const switchOrder: string[] = [];

    // Track call order
    onBeforeSwitch.mockImplementation(() => {
      switchOrder.push('onBeforeSwitch');
    });
    const originalSetTool = useToolStore.getState().setTool;
    vi.spyOn(useToolStore.getState(), 'setTool').mockImplementation((tool) => {
      switchOrder.push(`setTool:${tool}`);
      originalSetTool(tool);
    });

    renderHook(() =>
      useAltEyedropper(previousToolRef as React.RefObject<ToolType | null>, onBeforeSwitch)
    );

    window.dispatchEvent(createAltKeyEvent('keydown'));

    expect(onBeforeSwitch).toHaveBeenCalledTimes(1);
    expect(switchOrder).toEqual(['onBeforeSwitch', 'setTool:eyedropper']);
  });
});
