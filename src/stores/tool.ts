import { create } from 'zustand';

export type ToolType = 'brush' | 'eraser' | 'eyedropper' | 'move' | 'select' | 'lasso';

export type PressureCurve = 'linear' | 'soft' | 'hard' | 'sCurve';

/**
 * Apply pressure curve transformation
 * @param pressure - Raw pressure value (0-1)
 * @param curve - Curve type
 * @returns Transformed pressure value (0-1)
 */
export function applyPressureCurve(pressure: number, curve: PressureCurve): number {
  const p = Math.max(0, Math.min(1, pressure));

  switch (curve) {
    case 'linear':
      return p;
    case 'soft':
      // Quadratic ease-out: more sensitive at low pressure
      return 1 - (1 - p) * (1 - p);
    case 'hard':
      // Quadratic ease-in: more sensitive at high pressure
      return p * p;
    case 'sCurve':
      // Smooth S-curve: gradual at extremes, sensitive in middle
      return p * p * (3 - 2 * p);
    default:
      return p;
  }
}

interface ToolState {
  // Current tool
  currentTool: ToolType;

  // Brush settings
  brushSize: number;
  brushOpacity: number;
  brushHardness: number;
  brushColor: string;
  backgroundColor: string;

  // Eraser settings (independent from brush)
  eraserSize: number;

  // Pressure sensitivity settings
  pressureSizeEnabled: boolean;
  pressureOpacityEnabled: boolean;
  pressureCurve: PressureCurve;

  // Actions
  setTool: (tool: ToolType) => void;
  setBrushSize: (size: number) => void;
  setBrushOpacity: (opacity: number) => void;
  setBrushHardness: (hardness: number) => void;
  setBrushColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  setEraserSize: (size: number) => void;
  // Get current tool's size (brush or eraser)
  getCurrentSize: () => number;
  // Set current tool's size (brush or eraser)
  setCurrentSize: (size: number) => void;
  swapColors: () => void;
  resetColors: () => void;
  togglePressureSize: () => void;
  togglePressureOpacity: () => void;
  setPressureCurve: (curve: PressureCurve) => void;
}

export const useToolStore = create<ToolState>((set, get) => ({
  // Initial state
  currentTool: 'brush',
  brushSize: 20,
  brushOpacity: 1,
  brushHardness: 100,
  brushColor: '#000000',
  backgroundColor: '#ffffff',
  eraserSize: 20,
  pressureSizeEnabled: true,
  pressureOpacityEnabled: true,
  pressureCurve: 'linear',

  // Actions
  setTool: (tool) => set({ currentTool: tool }),

  setBrushSize: (size) => set({ brushSize: Math.max(1, Math.min(500, size)) }),

  setBrushOpacity: (opacity) => set({ brushOpacity: Math.max(0, Math.min(1, opacity)) }),

  setBrushHardness: (hardness) => set({ brushHardness: Math.max(0, Math.min(100, hardness)) }),

  setBrushColor: (color) => set({ brushColor: color }),

  setBackgroundColor: (color) => set({ backgroundColor: color }),

  setEraserSize: (size) => set({ eraserSize: Math.max(1, Math.min(500, size)) }),

  getCurrentSize: () => {
    const state = get();
    return state.currentTool === 'eraser' ? state.eraserSize : state.brushSize;
  },

  setCurrentSize: (size) => {
    const state = get();
    if (state.currentTool === 'eraser') {
      set({ eraserSize: Math.max(1, Math.min(500, size)) });
    } else {
      set({ brushSize: Math.max(1, Math.min(500, size)) });
    }
  },

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

  togglePressureSize: () => set((state) => ({ pressureSizeEnabled: !state.pressureSizeEnabled })),

  togglePressureOpacity: () =>
    set((state) => ({ pressureOpacityEnabled: !state.pressureOpacityEnabled })),

  setPressureCurve: (curve) => set({ pressureCurve: curve }),
}));
