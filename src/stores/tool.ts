import { create } from 'zustand';

export type ToolType = 'brush' | 'eraser' | 'eyedropper' | 'move' | 'select' | 'lasso';

interface ToolState {
  // Current tool
  currentTool: ToolType;

  // Brush settings
  brushSize: number;
  brushOpacity: number;
  brushHardness: number;
  brushColor: string;
  backgroundColor: string;

  // Pressure sensitivity settings
  pressureSizeEnabled: boolean;
  pressureOpacityEnabled: boolean;

  // Actions
  setTool: (tool: ToolType) => void;
  setBrushSize: (size: number) => void;
  setBrushOpacity: (opacity: number) => void;
  setBrushHardness: (hardness: number) => void;
  setBrushColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  swapColors: () => void;
  resetColors: () => void;
  togglePressureSize: () => void;
  togglePressureOpacity: () => void;
}

export const useToolStore = create<ToolState>((set) => ({
  // Initial state
  currentTool: 'brush',
  brushSize: 20,
  brushOpacity: 1,
  brushHardness: 100,
  brushColor: '#000000',
  backgroundColor: '#ffffff',
  pressureSizeEnabled: true,
  pressureOpacityEnabled: true,

  // Actions
  setTool: (tool) => set({ currentTool: tool }),

  setBrushSize: (size) => set({ brushSize: Math.max(1, Math.min(500, size)) }),

  setBrushOpacity: (opacity) => set({ brushOpacity: Math.max(0, Math.min(1, opacity)) }),

  setBrushHardness: (hardness) => set({ brushHardness: Math.max(0, Math.min(100, hardness)) }),

  setBrushColor: (color) => set({ brushColor: color }),

  setBackgroundColor: (color) => set({ backgroundColor: color }),

  swapColors: () =>
    set((state) => ({
      brushColor: state.backgroundColor,
      backgroundColor: state.brushColor,
    })),

  resetColors: () =>
    set({
      brushColor: '#000000',
      backgroundColor: '#ffffff',
    }),

  togglePressureSize: () =>
    set((state) => ({ pressureSizeEnabled: !state.pressureSizeEnabled })),

  togglePressureOpacity: () =>
    set((state) => ({ pressureOpacityEnabled: !state.pressureOpacityEnabled })),
}));
