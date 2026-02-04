import { useEffect, useState, type MutableRefObject } from 'react';
import { useSelectionStore } from '@/stores/selection';
import { ToolType } from '@/stores/tool';
import { stepBrushSizeBySliderProgress } from '@/utils/sliderScales';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

function isTextEditingCommand(code: string): boolean {
  switch (code) {
    case 'KeyA':
    case 'KeyZ':
    case 'KeyY':
    case 'KeyX':
    case 'KeyC':
    case 'KeyV':
      return true;
    default:
      return false;
  }
}

interface UseKeyboardShortcutsParams {
  currentTool: ToolType;
  currentSize: number;
  setTool: (tool: ToolType) => void;
  setCurrentSize: (size: number) => void;
  handleUndo: () => void;
  handleRedo: () => void;
  selectAll: (width: number, height: number) => void;
  deselectAll: () => void;
  cancelSelection: () => void;
  width: number;
  height: number;
  setIsPanning: (isPanning: boolean) => void;
  panStartRef: MutableRefObject<{ x: number; y: number } | null>;
}

export function useKeyboardShortcuts({
  currentTool,
  currentSize,
  setTool,
  setCurrentSize,
  handleUndo,
  handleRedo,
  selectAll,
  deselectAll,
  cancelSelection,
  width,
  height,
  setIsPanning,
  panStartRef,
}: UseKeyboardShortcutsParams): { spacePressed: boolean } {
  const [spacePressed, setSpacePressed] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        setSpacePressed(true);
      }

      // 优先处理修饰键组合 (Undo/Redo/Selection)
      if (e.ctrlKey || e.metaKey) {
        if (isEditableTarget(e.target) && isTextEditingCommand(e.code)) {
          return;
        }

        switch (e.code) {
          case 'KeyZ': {
            e.preventDefault();
            if (e.shiftKey) {
              handleRedo();
            } else {
              handleUndo();
            }
            return;
          }
          case 'KeyY': {
            e.preventDefault();
            handleRedo();
            return;
          }
          case 'KeyA': {
            // Ctrl+A: Select All
            e.preventDefault();
            selectAll(width, height);
            return;
          }
          case 'KeyD': {
            // Ctrl+D: Deselect
            e.preventDefault();
            deselectAll();
            return;
          }
          default:
            return;
        }
      }

      // Skip tool shortcuts if focus is on input elements (e.g., search boxes)
      // Allow Ctrl/Meta combos (handled above) and ESC to work normally
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // ESC: Cancel selection move or creation
      if (e.code === 'Escape') {
        const selState = useSelectionStore.getState();
        if (selState.isMoving) {
          selState.cancelMove();
        } else {
          cancelSelection();
        }
        return;
      }

      // 忽略不需要重复触发的按键 (除了 [] 笔刷大小调节)
      const isBracket = e.code === 'BracketLeft' || e.code === 'BracketRight';
      if (e.repeat && !isBracket) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          setSpacePressed(true);
          break;

        // Alt key handling is delegated to useAltEyedropper
        // to ensure it captures the first keydown event (repeat: false)

        case 'KeyZ':
          if (!e.altKey) {
            e.preventDefault();
            if (currentTool !== 'zoom') setTool('zoom');
          }
          break;

        case 'BracketLeft':
          e.preventDefault();
          setCurrentSize(stepBrushSizeBySliderProgress(currentSize, -1));
          break;

        case 'BracketRight':
          e.preventDefault();
          setCurrentSize(stepBrushSizeBySliderProgress(currentSize, 1));
          break;

        case 'KeyB':
          if (!e.altKey) {
            e.preventDefault();
            setTool('brush');
          }
          break;

        case 'KeyE':
          if (!e.altKey) {
            e.preventDefault();
            setTool('eraser');
          }
          break;

        case 'KeyM':
          if (!e.altKey) {
            e.preventDefault();
            setTool('select');
          }
          break;

        case 'KeyS':
          if (!e.altKey && !e.ctrlKey) {
            e.preventDefault();
            setTool('lasso');
          }
          break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpacePressed(false);
        setIsPanning(false);
        panStartRef.current = null;
      }
      // Alt key release is handled in useAltEyedropper
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [
    setIsPanning,
    handleUndo,
    handleRedo,
    currentTool,
    setTool,
    currentSize,
    setCurrentSize,
    selectAll,
    deselectAll,
    cancelSelection,
    width,
    height,
    panStartRef,
  ]);

  return { spacePressed };
}
