import { useEffect } from 'react';
import { useToolStore, type ToolType } from '@/stores/tool';

/**
 * Hook to handle Alt+Eyedropper temporary tool switching.
 *
 * When Alt is pressed while using brush or eraser:
 * - Calls onBeforeSwitch callback (to finish current stroke)
 * - Switches to eyedropper tool
 * - Restores original tool when Alt is released
 *
 * This hook must be registered FIRST among keyboard listeners
 * to capture the initial keydown event (repeat: false).
 *
 * @param previousToolRef - Ref to store the previous tool for restoration
 * @param onBeforeSwitch - Optional callback called before switching to eyedropper (e.g., to finish current stroke)
 */
export function useAltEyedropper(
  previousToolRef: React.RefObject<ToolType | null>,
  onBeforeSwitch?: () => void | Promise<void>
): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.code === 'AltLeft' || e.code === 'AltRight') && !e.repeat) {
        const store = useToolStore.getState();
        if (store.currentTool === 'brush' || store.currentTool === 'eraser') {
          e.preventDefault();
          // Finish current stroke before switching (fire-and-forget for async)
          onBeforeSwitch?.();
          (previousToolRef as React.MutableRefObject<ToolType | null>).current = store.currentTool;
          store.setTool('eyedropper');
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'AltLeft' || e.code === 'AltRight') {
        const store = useToolStore.getState();
        if (previousToolRef.current && store.currentTool === 'eyedropper') {
          store.setTool(previousToolRef.current);
          (previousToolRef as React.MutableRefObject<ToolType | null>).current = null;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [previousToolRef, onBeforeSwitch]);
}

// Export for testing - allows creating mock keyboard events
export function createAltKeyEvent(
  type: 'keydown' | 'keyup',
  options: { repeat?: boolean; code?: 'AltLeft' | 'AltRight' } = {}
): KeyboardEvent {
  return new KeyboardEvent(type, {
    code: options.code ?? 'AltLeft',
    key: 'Alt',
    repeat: options.repeat ?? false,
    bubbles: true,
    cancelable: true,
  });
}
