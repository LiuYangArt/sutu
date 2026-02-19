import { create } from 'zustand';

interface UiInteractionState {
  canvasInputLockCount: number;
  isCanvasInputLocked: boolean;
  acquireCanvasInputLock: () => void;
  releaseCanvasInputLock: () => void;
  resetCanvasInputLock: () => void;
}

export const useUiInteractionStore = create<UiInteractionState>((set) => ({
  canvasInputLockCount: 0,
  isCanvasInputLocked: false,

  acquireCanvasInputLock: () =>
    set((state) => {
      const nextCount = state.canvasInputLockCount + 1;
      return {
        canvasInputLockCount: nextCount,
        isCanvasInputLocked: true,
      };
    }),

  releaseCanvasInputLock: () =>
    set((state) => {
      const nextCount = Math.max(0, state.canvasInputLockCount - 1);
      return {
        canvasInputLockCount: nextCount,
        isCanvasInputLocked: nextCount > 0,
      };
    }),

  resetCanvasInputLock: () =>
    set({
      canvasInputLockCount: 0,
      isCanvasInputLocked: false,
    }),
}));
