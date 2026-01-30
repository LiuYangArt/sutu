import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  TextureSettings,
  DEFAULT_TEXTURE_SETTINGS,
  PatternInfo,
} from '@/components/BrushPanel/types';
import { patternManager } from '@/utils/patternManager';

export type ToolType = 'brush' | 'eraser' | 'eyedropper' | 'move' | 'select' | 'lasso' | 'zoom';

export type PressureCurve = 'linear' | 'soft' | 'hard' | 'sCurve';

export type BrushMaskType = 'gaussian' | 'default';

/**
 * Control source for dynamic brush parameters (Photoshop-compatible)
 */
export type ControlSource =
  | 'off' // No control, use base value only
  | 'fade' // Fade over stroke distance
  | 'penPressure' // Pen pressure (0-1)
  | 'penTilt' // Pen tilt magnitude
  | 'rotation' // Pen barrel rotation
  | 'direction' // Stroke direction (Angle only)
  | 'initial'; // Initial direction at stroke start (Angle only)

/**
 * Shape Dynamics settings (Photoshop Shape Dynamics panel compatible)
 * Controls how brush shape varies during a stroke
 */
export interface ShapeDynamicsSettings {
  // Size Jitter
  sizeJitter: number; // 0-100 (percentage)
  sizeControl: ControlSource; // What controls size
  minimumDiameter: number; // 0-100 (percentage of base size)

  // Angle Jitter
  angleJitter: number; // 0-360 (degrees)
  angleControl: ControlSource;

  // Roundness Jitter
  roundnessJitter: number; // 0-100 (percentage)
  roundnessControl: ControlSource;
  minimumRoundness: number; // 0-100 (percentage)

  // Flip Jitter (boolean toggles)
  flipXJitter: boolean;
  flipYJitter: boolean;
}

/** Default Shape Dynamics settings (all off) */
export const DEFAULT_SHAPE_DYNAMICS: ShapeDynamicsSettings = {
  sizeJitter: 0,
  sizeControl: 'off',
  minimumDiameter: 0,

  angleJitter: 0,
  angleControl: 'off',

  roundnessJitter: 0,
  roundnessControl: 'off',
  minimumRoundness: 25, // PS default

  flipXJitter: false,
  flipYJitter: false,
};

/**
 * Scatter settings (Photoshop Scattering panel compatible)
 * Controls random displacement of dabs perpendicular to stroke direction
 */
export interface ScatterSettings {
  // Scatter amount (% of brush diameter, 0-1000)
  scatter: number;
  scatterControl: ControlSource;

  // Both Axes - scatter along stroke direction as well
  bothAxes: boolean;

  // Count - number of dabs per spacing interval (1-16)
  count: number;
  countControl: ControlSource;
  countJitter: number; // 0-100 (%)
}

/** Default Scatter settings (all off) */
export const DEFAULT_SCATTER_SETTINGS: ScatterSettings = {
  scatter: 0,
  scatterControl: 'off',
  bothAxes: false,
  count: 1,
  countControl: 'off',
  countJitter: 0,
};

/**
 * Color Dynamics settings (Photoshop Color Dynamics panel compatible)
 * Controls how brush color varies during a stroke
 */
export interface ColorDynamicsSettings {
  // Foreground/Background Jitter
  foregroundBackgroundJitter: number; // 0-100 (percentage)
  foregroundBackgroundControl: ControlSource; // What controls F/B mixing

  // Hue Jitter
  hueJitter: number; // 0-100 (percentage, maps to ±180° at 100%)

  // Saturation Jitter
  saturationJitter: number; // 0-100 (percentage)

  // Brightness Jitter (HSB's B = HSV's V)
  brightnessJitter: number; // 0-100 (percentage)

  // Purity (global saturation adjustment)
  // -100 = grayscale, 0 = no change, +100 = maximum saturation
  purity: number; // -100 to +100
}

/** Default Color Dynamics settings (all off) */
export const DEFAULT_COLOR_DYNAMICS: ColorDynamicsSettings = {
  foregroundBackgroundJitter: 0,
  foregroundBackgroundControl: 'off',
  hueJitter: 0,
  saturationJitter: 0,
  brightnessJitter: 0,
  purity: 0,
};

/**
 * Transfer settings (Photoshop Transfer panel compatible)
 * Controls how opacity and flow vary during a stroke
 */
export interface TransferSettings {
  // Opacity Jitter
  opacityJitter: number; // 0-100 (percentage)
  opacityControl: ControlSource; // What controls opacity
  minimumOpacity: number; // 0-100 (percentage of base opacity)

  // Flow Jitter
  flowJitter: number; // 0-100 (percentage)
  flowControl: ControlSource; // What controls flow
  minimumFlow: number; // 0-100 (percentage of base flow)
}

/** Default Transfer settings (all off) */
export const DEFAULT_TRANSFER_SETTINGS: TransferSettings = {
  opacityJitter: 0,
  opacityControl: 'off',
  minimumOpacity: 0,

  flowJitter: 0,
  flowControl: 'off',
  minimumFlow: 0,
};

/**
 * Brush texture data for sampled/imported brushes (e.g., from ABR files)
 * When set, the brush uses this texture instead of procedural mask generation
 */
export interface BrushTexture {
  /** Unique identifier (from BrushPreset.id) for cache lookup */
  id: string;
  /** Base64 encoded PNG data */
  data: string;
  /** Texture width in pixels */
  width: number;
  /** Texture height in pixels */
  height: number;
  /** Decoded ImageData (cached after first use) */
  imageData?: ImageData;
  /** Pre-computed cursor outline as SVG path data (normalized 0-1 coordinates) */
  cursorPath?: string;
  /** Bounding box of the cursor path for proper scaling */
  cursorBounds?: { width: number; height: number };
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

  // Shape Dynamics settings (Photoshop-compatible)
  shapeDynamicsEnabled: boolean;
  shapeDynamics: ShapeDynamicsSettings;

  // Scatter settings (Photoshop-compatible)
  scatterEnabled: boolean;
  scatter: ScatterSettings;

  // Color Dynamics settings (Photoshop-compatible)
  colorDynamicsEnabled: boolean;
  colorDynamics: ColorDynamicsSettings;

  // Wet Edge settings (Photoshop-compatible)
  wetEdgeEnabled: boolean;
  wetEdge: number; // Wet edge strength (0-1)

  // Transfer settings (Photoshop-compatible)
  transferEnabled: boolean;
  transfer: TransferSettings;

  // Texture settings (Photoshop-compatible)
  textureEnabled: boolean;
  textureSettings: TextureSettings;

  // Patterns
  patterns: PatternInfo[];

  // Actions
  setPatterns: (patterns: PatternInfo[]) => void;
  appendPatterns: (patterns: PatternInfo[]) => void;

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
  // Texture actions
  setTextureEnabled: (enabled: boolean) => void;
  toggleTexture: () => void;
  setTextureSettings: (settings: Partial<TextureSettings>) => void;
  resetTextureSettings: () => void;
  // Shape Dynamics actions
  setShapeDynamicsEnabled: (enabled: boolean) => void;
  toggleShapeDynamics: () => void;
  setShapeDynamics: (settings: Partial<ShapeDynamicsSettings>) => void;
  resetShapeDynamics: () => void;

  // Scatter actions
  setScatterEnabled: (enabled: boolean) => void;
  toggleScatter: () => void;
  setScatter: (settings: Partial<ScatterSettings>) => void;
  resetScatter: () => void;

  // Color Dynamics actions
  setColorDynamicsEnabled: (enabled: boolean) => void;
  toggleColorDynamics: () => void;
  setColorDynamics: (settings: Partial<ColorDynamicsSettings>) => void;
  resetColorDynamics: () => void;

  // Wet Edge actions
  setWetEdgeEnabled: (enabled: boolean) => void;
  toggleWetEdge: () => void;
  setWetEdge: (value: number) => void;

  // Transfer actions
  setTransferEnabled: (enabled: boolean) => void;
  toggleTransfer: () => void;
  setTransfer: (settings: Partial<TransferSettings>) => void;
  resetTransfer: () => void;
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
      pressureSizeEnabled: false,
      pressureFlowEnabled: false,
      pressureOpacityEnabled: true, // Only opacity affected by pressure by default
      pressureCurve: 'linear',
      showCrosshair: false,

      // Shape Dynamics (default: disabled with all jitter at 0)
      shapeDynamicsEnabled: false,
      shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS },

      // Scatter (default: disabled)
      scatterEnabled: false,
      scatter: { ...DEFAULT_SCATTER_SETTINGS },

      // Color Dynamics (default: disabled with all jitter at 0)
      colorDynamicsEnabled: false,
      colorDynamics: { ...DEFAULT_COLOR_DYNAMICS },

      // Wet Edge (default: disabled, full strength when enabled)
      wetEdgeEnabled: false,
      wetEdge: 1.0,

      // Transfer (default: disabled with all jitter at 0)
      transferEnabled: false,
      transfer: { ...DEFAULT_TRANSFER_SETTINGS },

      // Texture (default: disabled)
      textureEnabled: false,
      textureSettings: { ...DEFAULT_TEXTURE_SETTINGS },

      // Patterns
      patterns: [],

      // Actions
      setPatterns: (patterns) => set({ patterns }),
      appendPatterns: (newPatterns) =>
        set((state) => ({ patterns: [...state.patterns, ...newPatterns] })),

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

      // Texture actions
      setTextureEnabled: (enabled) => set({ textureEnabled: enabled }),

      toggleTexture: () => set((state) => ({ textureEnabled: !state.textureEnabled })),

      setTextureSettings: (settings) => {
        // Optimistically load pattern if ID is provided
        if (settings.patternId) {
          patternManager.loadPattern(settings.patternId);
        }
        set((state) => ({
          textureSettings: { ...state.textureSettings, ...settings },
        }));
      },

      resetTextureSettings: () => set({ textureSettings: { ...DEFAULT_TEXTURE_SETTINGS } }),

      // Shape Dynamics actions
      setShapeDynamicsEnabled: (enabled) => set({ shapeDynamicsEnabled: enabled }),

      toggleShapeDynamics: () =>
        set((state) => ({ shapeDynamicsEnabled: !state.shapeDynamicsEnabled })),

      setShapeDynamics: (settings) =>
        set((state) => ({
          shapeDynamics: { ...state.shapeDynamics, ...settings },
        })),

      resetShapeDynamics: () => set({ shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS } }),

      // Scatter actions
      setScatterEnabled: (enabled) => set({ scatterEnabled: enabled }),

      toggleScatter: () => set((state) => ({ scatterEnabled: !state.scatterEnabled })),

      setScatter: (settings) =>
        set((state) => ({
          scatter: { ...state.scatter, ...settings },
        })),

      resetScatter: () => set({ scatter: { ...DEFAULT_SCATTER_SETTINGS } }),

      // Color Dynamics actions
      setColorDynamicsEnabled: (enabled) => set({ colorDynamicsEnabled: enabled }),

      toggleColorDynamics: () =>
        set((state) => ({ colorDynamicsEnabled: !state.colorDynamicsEnabled })),

      setColorDynamics: (settings) =>
        set((state) => ({
          colorDynamics: { ...state.colorDynamics, ...settings },
        })),

      resetColorDynamics: () => set({ colorDynamics: { ...DEFAULT_COLOR_DYNAMICS } }),

      // Wet Edge actions
      setWetEdgeEnabled: (enabled) => set({ wetEdgeEnabled: enabled }),

      toggleWetEdge: () => set((state) => ({ wetEdgeEnabled: !state.wetEdgeEnabled })),

      setWetEdge: (value) => set({ wetEdge: Math.max(0, Math.min(1, value)) }),

      // Transfer actions
      setTransferEnabled: (enabled) => set({ transferEnabled: enabled }),

      toggleTransfer: () => set((state) => ({ transferEnabled: !state.transferEnabled })),

      setTransfer: (settings) =>
        set((state) => ({
          transfer: { ...state.transfer, ...settings },
        })),

      resetTransfer: () => set({ transfer: { ...DEFAULT_TRANSFER_SETTINGS } }),
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
        shapeDynamicsEnabled: state.shapeDynamicsEnabled,
        shapeDynamics: state.shapeDynamics,
        scatterEnabled: state.scatterEnabled,
        scatter: state.scatter,
        colorDynamicsEnabled: state.colorDynamicsEnabled,
        colorDynamics: state.colorDynamics,
        wetEdgeEnabled: state.wetEdgeEnabled,
        wetEdge: state.wetEdge,
        transferEnabled: state.transferEnabled,
        transfer: state.transfer,
      }),
    }
  )
);
