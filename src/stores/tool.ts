import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ToolType = 'brush' | 'eraser' | 'eyedropper' | 'move' | 'select' | 'lasso' | 'zoom';

export type PressureCurve = 'linear' | 'soft' | 'hard' | 'sCurve';

/**
 * Brush mask type - controls how hardness affects edge falloff
 * - 'gaussian': erf-based Gaussian (Krita-style, smoother, default)
 * - 'default': Simple Gaussian exp(-k*t²) (original implementation)
 */
export type BrushMaskType = 'gaussian' | 'default';

/**
 * Render mode - controls which backend to use for brush rendering
 * - 'gpu': GPU rendering (WebGPU)
 * - 'cpu': CPU rendering (Canvas 2D)
 */
export type RenderMode = 'gpu' | 'cpu';

/**
 * Color blend mode - controls how colors are mixed during GPU rendering
 * - 'srgb': Match Canvas 2D behavior (8-bit quantization, default)
 * - 'linear': Physically correct linear-space blending
 */
export type ColorBlendMode = 'srgb' | 'linear';

/**
 * GPU render scale mode - controls dynamic downsampling
 * - 'auto': Automatically downsample for soft large brushes (hardness < 70, size > 300)
 * - 'off': Always render at full resolution
 */
export type GPURenderScaleMode = 'auto' | 'off';

/**
 * Brush texture data for sampled/imported brushes (e.g., from ABR files)
 * When set, the brush uses this texture instead of procedural mask generation
 */
export interface BrushTexture {
  /** Base64 encoded PNG data */
  data: string;
  /** Texture width in pixels */
  width: number;
  /** Texture height in pixels */
  height: number;
  /** Decoded ImageData (cached after first use) */
  imageData?: ImageData;
}

/** Clamp brush/eraser size to valid range */
const clampSize = (size: number): number => Math.max(1, Math.min(800, size));

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
  brushFlow: number; // Flow: per-dab opacity, accumulates within stroke
  brushOpacity: number; // Opacity: ceiling for entire stroke
  brushHardness: number;
  brushMaskType: BrushMaskType; // Mask type: edge falloff algorithm
  brushSpacing: number; // Spacing as fraction of size (0.01-1.0)
  brushRoundness: number; // Roundness: 0-100 (100 = circle, <100 = ellipse)
  brushAngle: number; // Angle: 0-360 degrees
  brushColor: string;
  backgroundColor: string;
  brushTexture: BrushTexture | null; // Texture for sampled brushes (from ABR import)

  // Eraser settings (independent from brush)
  eraserSize: number;

  // Pressure sensitivity settings
  pressureSizeEnabled: boolean;
  pressureFlowEnabled: boolean; // Pressure affects flow (per-dab)
  pressureOpacityEnabled: boolean; // Pressure affects opacity (legacy, can be disabled)
  pressureCurve: PressureCurve;

  // Cursor display settings
  showCrosshair: boolean;

  // Render mode
  renderMode: RenderMode;

  // Color blend mode (GPU only)
  colorBlendMode: ColorBlendMode;

  // GPU render scale mode (GPU only)
  gpuRenderScaleMode: GPURenderScaleMode;

  // Actions
  setTool: (tool: ToolType) => void;
  setBrushSize: (size: number) => void;
  setBrushFlow: (flow: number) => void;
  setBrushOpacity: (opacity: number) => void;
  setBrushHardness: (hardness: number) => void;
  setBrushMaskType: (maskType: BrushMaskType) => void;
  setBrushSpacing: (spacing: number) => void;
  setBrushRoundness: (roundness: number) => void;
  setBrushAngle: (angle: number) => void;
  setBrushColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  setBrushTexture: (texture: BrushTexture | null) => void;
  clearBrushTexture: () => void;
  setEraserSize: (size: number) => void;
  // Get current tool's size (brush or eraser)
  getCurrentSize: () => number;
  // Set current tool's size (brush or eraser)
  setCurrentSize: (size: number) => void;
  swapColors: () => void;
  resetColors: () => void;
  togglePressureSize: () => void;
  togglePressureFlow: () => void;
  togglePressureOpacity: () => void;
  setPressureCurve: (curve: PressureCurve) => void;
  toggleCrosshair: () => void;
  setRenderMode: (mode: RenderMode) => void;
  setColorBlendMode: (mode: ColorBlendMode) => void;
  setGpuRenderScaleMode: (mode: GPURenderScaleMode) => void;
}

export const useToolStore = create<ToolState>()(
  persist(
    (set, get) => ({
      // Initial state
      currentTool: 'brush',
      brushSize: 20,
      brushFlow: 1, // Default: full flow
      brushOpacity: 1, // Default: full opacity ceiling
      brushHardness: 100,
      brushMaskType: 'default', // Default to simple Gaussian (perf preferred)
      brushSpacing: 0.25, // 25% of brush size
      brushRoundness: 100, // 100 = perfect circle
      brushAngle: 0, // 0 degrees
      brushColor: '#000000',
      backgroundColor: '#ffffff',
      brushTexture: null, // No texture by default (procedural brush)
      eraserSize: 20,
      pressureSizeEnabled: true,
      pressureFlowEnabled: true, // Pressure affects flow by default
      pressureOpacityEnabled: false, // Opacity ceiling not affected by pressure by default
      pressureCurve: 'linear',
      showCrosshair: false,
      renderMode: 'gpu',
      colorBlendMode: 'linear',
      gpuRenderScaleMode: 'off',

      // Actions
      setTool: (tool) => set({ currentTool: tool }),

      setBrushSize: (size) => set({ brushSize: clampSize(size) }),

      setBrushFlow: (flow) => set({ brushFlow: Math.max(0.01, Math.min(1, flow)) }),

      setBrushOpacity: (opacity) => set({ brushOpacity: Math.max(0.01, Math.min(1, opacity)) }),

      setBrushHardness: (hardness) => set({ brushHardness: Math.max(0, Math.min(100, hardness)) }),

      setBrushMaskType: (maskType) => set({ brushMaskType: maskType }),

      setBrushSpacing: (spacing) => set({ brushSpacing: Math.max(0.01, Math.min(1, spacing)) }),

      setBrushRoundness: (roundness) =>
        set({ brushRoundness: Math.max(1, Math.min(100, roundness)) }),

      setBrushAngle: (angle) => set({ brushAngle: ((angle % 360) + 360) % 360 }),

      setBrushColor: (color) => set({ brushColor: color }),

      setBackgroundColor: (color) => set({ backgroundColor: color }),

      setBrushTexture: (texture) => set({ brushTexture: texture }),

      clearBrushTexture: () => set({ brushTexture: null }),

      setEraserSize: (size) => set({ eraserSize: clampSize(size) }),

      getCurrentSize: () => {
        const state = get();
        return state.currentTool === 'eraser' ? state.eraserSize : state.brushSize;
      },

      setCurrentSize: (size) => {
        const state = get();
        if (state.currentTool === 'eraser') {
          set({ eraserSize: clampSize(size) });
        } else {
          set({ brushSize: clampSize(size) });
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

      togglePressureSize: () =>
        set((state) => ({ pressureSizeEnabled: !state.pressureSizeEnabled })),

      togglePressureFlow: () =>
        set((state) => ({ pressureFlowEnabled: !state.pressureFlowEnabled })),

      togglePressureOpacity: () =>
        set((state) => ({ pressureOpacityEnabled: !state.pressureOpacityEnabled })),

      setPressureCurve: (curve) => set({ pressureCurve: curve }),

      toggleCrosshair: () => set((state) => ({ showCrosshair: !state.showCrosshair })),

      setRenderMode: (mode) => set({ renderMode: mode }),

      setColorBlendMode: (mode) => set({ colorBlendMode: mode }),

      setGpuRenderScaleMode: (mode) => set({ gpuRenderScaleMode: mode }),
    }),
    {
      name: 'paintboard-brush-settings',
      // Only persist brush-related settings, not current tool or runtime state
      partialize: (state) => ({
        brushSize: state.brushSize,
        brushFlow: state.brushFlow,
        brushOpacity: state.brushOpacity,
        brushHardness: state.brushHardness,
        brushMaskType: state.brushMaskType,
        brushSpacing: state.brushSpacing,
        brushRoundness: state.brushRoundness,
        brushAngle: state.brushAngle,
        brushColor: state.brushColor,
        backgroundColor: state.backgroundColor,
        eraserSize: state.eraserSize,
        pressureSizeEnabled: state.pressureSizeEnabled,
        pressureFlowEnabled: state.pressureFlowEnabled,
        pressureOpacityEnabled: state.pressureOpacityEnabled,
        pressureCurve: state.pressureCurve,
        renderMode: state.renderMode,
        colorBlendMode: state.colorBlendMode,
        gpuRenderScaleMode: state.gpuRenderScaleMode,
      }),
    }
  )
);
