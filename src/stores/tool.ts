import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  TextureSettings,
  DEFAULT_TEXTURE_SETTINGS,
  PatternInfo,
} from '@/components/BrushPanel/types';
import { patternManager } from '@/utils/patternManager';
import { appHyphenStorageKey } from '@/constants/appMeta';

export type ToolType =
  | 'brush'
  | 'eraser'
  | 'eyedropper'
  | 'gradient'
  | 'move'
  | 'select'
  | 'lasso'
  | 'zoom';

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

  // Apply jitter per dab tip (true) or once per stroke (false)
  applyPerTip: boolean;

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
  applyPerTip: true,
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
 * Dual Blend Mode (Photoshop Dual Brush panel compatible)
 * Only 8 modes are available: Multiply, Darken, Overlay,
 * Color Dodge, Color Burn, Linear Burn, Hard Mix, Linear Height
 */
export type DualBlendMode =
  | 'multiply'
  | 'darken'
  | 'overlay'
  | 'colorDodge'
  | 'colorBurn'
  | 'linearBurn'
  | 'hardMix'
  | 'linearHeight';

/**
 * Dual Brush settings (Photoshop Dual Brush panel compatible)
 */
export interface DualBrushSettings {
  enabled: boolean;
  brushId: string | null; // UUID of the secondary brush
  brushIndex: number | null; // Index in presets array (for uniqueness when UUIDs duplicate)
  brushName: string | null;
  mode: DualBlendMode;
  flip: boolean;
  size: number; // Pixels
  /** Dual size ratio relative to the preset's saved main size (dual_size / main_size) */
  sizeRatio: number; // 0-10
  spacing: number; // 0-10
  roundness?: number; // 0-100 (secondary tip shape)
  scatter: number; // Rust side uses f32
  bothAxes: boolean;
  count: number;
  /** Secondary brush texture (constructed from preset) */
  texture?: BrushTexture;
}

export const DEFAULT_DUAL_BRUSH: DualBrushSettings = {
  enabled: false,
  brushId: null,
  brushIndex: null,
  brushName: null,
  mode: 'multiply',
  flip: false,
  size: 25,
  sizeRatio: 1.25,
  spacing: 0.25,
  roundness: 100,
  scatter: 0,
  bothAxes: false,
  count: 1,
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
const clampSize = (size: number): number => Math.max(1, Math.min(1000, size));
/** Clamp texture scale percentage to valid range */
const clampTextureScale = (scale: number): number => Math.max(1, Math.min(1000, scale));
/** Clamp dual brush size ratio to valid range */
const clampDualSizeRatio = (ratio: number): number => Math.max(0, Math.min(10, ratio));

function computeDualSizeFromRatio(brushSize: number, ratio: number): number {
  return clampSize(brushSize * clampDualSizeRatio(ratio));
}

function computeDualSizeRatioFromSize(brushSize: number, size: number): number {
  if (brushSize <= 0) return 1;
  return clampDualSizeRatio(clampSize(size) / brushSize);
}

function normalizeDualBrush(
  brushSize: number,
  current: DualBrushSettings,
  patch: Partial<DualBrushSettings>
): DualBrushSettings {
  const next = { ...current, ...patch };

  if (patch.sizeRatio !== undefined) {
    const ratio = clampDualSizeRatio(patch.sizeRatio);
    return {
      ...next,
      sizeRatio: ratio,
      size: computeDualSizeFromRatio(brushSize, ratio),
    };
  }

  if (patch.size !== undefined) {
    const size = clampSize(patch.size);
    const ratio = computeDualSizeRatioFromSize(brushSize, size);
    return {
      ...next,
      size,
      sizeRatio: ratio,
    };
  }

  const ratio =
    typeof next.sizeRatio === 'number' && Number.isFinite(next.sizeRatio)
      ? clampDualSizeRatio(next.sizeRatio)
      : computeDualSizeRatioFromSize(brushSize, next.size);

  return {
    ...next,
    size: clampSize(next.size),
    sizeRatio: ratio,
  };
}

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

export type EraserBackgroundMode = 'background-color' | 'transparent';

export interface BrushToolProfile {
  size: number;
  flow: number;
  opacity: number;
  hardness: number;
  maskType: BrushMaskType;
  spacing: number;
  roundness: number;
  angle: number;
  texture: BrushTexture | null;
  pressureSizeEnabled: boolean;
  pressureFlowEnabled: boolean;
  pressureOpacityEnabled: boolean;
  pressureCurve: PressureCurve;
  shapeDynamicsEnabled: boolean;
  shapeDynamics: ShapeDynamicsSettings;
  scatterEnabled: boolean;
  scatter: ScatterSettings;
  colorDynamicsEnabled: boolean;
  colorDynamics: ColorDynamicsSettings;
  wetEdgeEnabled: boolean;
  wetEdge: number;
  buildupEnabled: boolean;
  transferEnabled: boolean;
  transfer: TransferSettings;
  textureEnabled: boolean;
  textureSettings: TextureSettings;
  noiseEnabled: boolean;
  dualBrushEnabled: boolean;
  dualBrush: DualBrushSettings;
}

type BrushProfileTool = 'brush' | 'eraser';

function toBrushProfileTool(tool: ToolType): BrushProfileTool | null {
  if (tool === 'brush' || tool === 'eraser') {
    return tool;
  }
  return null;
}

function isSameCaseInsensitiveText(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function cloneCursorBounds(
  bounds: BrushTexture['cursorBounds'] | undefined
): BrushTexture['cursorBounds'] | undefined {
  if (!bounds) return undefined;
  return { width: bounds.width, height: bounds.height };
}

function cloneBrushTexture(texture: BrushTexture | null): BrushTexture | null {
  if (!texture) return null;
  return {
    ...texture,
    cursorBounds: cloneCursorBounds(texture.cursorBounds),
  };
}

function cloneDualBrushSettings(dual: DualBrushSettings): DualBrushSettings {
  return {
    ...dual,
    texture: dual.texture
      ? { ...dual.texture, cursorBounds: cloneCursorBounds(dual.texture.cursorBounds) }
      : undefined,
  };
}

function normalizeBrushProfile(profile: BrushToolProfile): BrushToolProfile {
  const size = clampSize(profile.size);
  const dualBrush = normalizeDualBrush(size, cloneDualBrushSettings(profile.dualBrush), {});
  return {
    size,
    flow: Math.max(0.01, Math.min(1, profile.flow)),
    opacity: Math.max(0.01, Math.min(1, profile.opacity)),
    hardness: Math.max(0, Math.min(100, profile.hardness)),
    maskType: profile.maskType,
    spacing: Math.max(0.01, Math.min(10, profile.spacing)),
    roundness: Math.max(1, Math.min(100, profile.roundness)),
    angle: ((profile.angle % 360) + 360) % 360,
    texture: cloneBrushTexture(profile.texture),
    pressureSizeEnabled: profile.pressureSizeEnabled,
    pressureFlowEnabled: profile.pressureFlowEnabled,
    pressureOpacityEnabled: profile.pressureOpacityEnabled,
    pressureCurve: profile.pressureCurve,
    shapeDynamicsEnabled: profile.shapeDynamicsEnabled,
    shapeDynamics: { ...profile.shapeDynamics },
    scatterEnabled: profile.scatterEnabled,
    scatter: { ...profile.scatter },
    colorDynamicsEnabled: profile.colorDynamicsEnabled,
    colorDynamics: {
      ...profile.colorDynamics,
      applyPerTip: profile.colorDynamics.applyPerTip !== false,
    },
    wetEdgeEnabled: profile.wetEdgeEnabled,
    wetEdge: Math.max(0, Math.min(1, profile.wetEdge)),
    buildupEnabled: profile.buildupEnabled,
    transferEnabled: profile.transferEnabled,
    transfer: { ...profile.transfer },
    textureEnabled: profile.textureEnabled,
    textureSettings: { ...profile.textureSettings },
    noiseEnabled: profile.noiseEnabled,
    dualBrushEnabled: profile.dualBrushEnabled,
    dualBrush,
  };
}

function getDefaultBrushProfile(): BrushToolProfile {
  return normalizeBrushProfile({
    size: 20,
    flow: 1,
    opacity: 1,
    hardness: 100,
    maskType: 'default',
    spacing: 0.25,
    roundness: 100,
    angle: 0,
    texture: null,
    pressureSizeEnabled: false,
    pressureFlowEnabled: false,
    pressureOpacityEnabled: true,
    pressureCurve: 'linear',
    shapeDynamicsEnabled: false,
    shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS },
    scatterEnabled: false,
    scatter: { ...DEFAULT_SCATTER_SETTINGS },
    colorDynamicsEnabled: false,
    colorDynamics: { ...DEFAULT_COLOR_DYNAMICS },
    wetEdgeEnabled: false,
    wetEdge: 1.0,
    buildupEnabled: false,
    transferEnabled: false,
    transfer: { ...DEFAULT_TRANSFER_SETTINGS },
    textureEnabled: false,
    textureSettings: { ...DEFAULT_TEXTURE_SETTINGS },
    noiseEnabled: false,
    dualBrushEnabled: false,
    dualBrush: { ...DEFAULT_DUAL_BRUSH },
  });
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
  brushSpacing: number; // Spacing as fraction of tip short edge (0.01-10.0)
  brushRoundness: number; // Roundness: 0-100 (100 = circle, <100 = ellipse)
  brushAngle: number; // Angle: 0-360 degrees
  brushColor: string;
  backgroundColor: string;
  brushTexture: BrushTexture | null; // Texture for sampled brushes (from ABR import)

  // Eraser settings (independent from brush)
  eraserSize: number;
  eraserBackgroundMode: EraserBackgroundMode;
  brushProfile: BrushToolProfile;
  eraserProfile: BrushToolProfile;

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

  // Build-up settings (Photoshop-compatible)
  buildupEnabled: boolean;

  // Transfer settings (Photoshop-compatible)
  transferEnabled: boolean;
  transfer: TransferSettings;

  // Texture settings (Photoshop-compatible)
  textureEnabled: boolean;
  textureSettings: TextureSettings;

  // Noise settings (Photoshop-compatible)
  noiseEnabled: boolean;

  // Dual Brush settings (Photoshop-compatible)
  dualBrushEnabled: boolean;
  dualBrush: DualBrushSettings;

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
  setEraserBackgroundMode: (mode: EraserBackgroundMode) => void;
  toggleEraserBackgroundMode: () => void;
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
  // Noise actions
  setNoiseEnabled: (enabled: boolean) => void;
  toggleNoise: () => void;
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

  // Build-up actions
  setBuildupEnabled: (enabled: boolean) => void;
  toggleBuildup: () => void;

  // Transfer actions
  setTransferEnabled: (enabled: boolean) => void;
  toggleTransfer: () => void;
  setTransfer: (settings: Partial<TransferSettings>) => void;
  resetTransfer: () => void;

  // Dual Brush actions
  setDualBrushEnabled: (enabled: boolean) => void;
  toggleDualBrush: () => void;
  setDualBrush: (settings: Partial<DualBrushSettings>) => void;
  resetDualBrush: () => void;
}

function snapshotProfileFromLiveState(state: ToolState): BrushToolProfile {
  return normalizeBrushProfile({
    size: state.brushSize,
    flow: state.brushFlow,
    opacity: state.brushOpacity,
    hardness: state.brushHardness,
    maskType: state.brushMaskType,
    spacing: state.brushSpacing,
    roundness: state.brushRoundness,
    angle: state.brushAngle,
    texture: state.brushTexture,
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
    buildupEnabled: state.buildupEnabled,
    transferEnabled: state.transferEnabled,
    transfer: state.transfer,
    textureEnabled: state.textureEnabled,
    textureSettings: state.textureSettings,
    noiseEnabled: state.noiseEnabled,
    dualBrushEnabled: state.dualBrushEnabled,
    dualBrush: state.dualBrush,
  });
}

function applyProfileToLiveState(profile: BrushToolProfile): Partial<ToolState> {
  return {
    brushSize: profile.size,
    brushFlow: profile.flow,
    brushOpacity: profile.opacity,
    brushHardness: profile.hardness,
    brushMaskType: profile.maskType,
    brushSpacing: profile.spacing,
    brushRoundness: profile.roundness,
    brushAngle: profile.angle,
    brushTexture: cloneBrushTexture(profile.texture),
    pressureSizeEnabled: profile.pressureSizeEnabled,
    pressureFlowEnabled: profile.pressureFlowEnabled,
    pressureOpacityEnabled: profile.pressureOpacityEnabled,
    pressureCurve: profile.pressureCurve,
    shapeDynamicsEnabled: profile.shapeDynamicsEnabled,
    shapeDynamics: { ...profile.shapeDynamics },
    scatterEnabled: profile.scatterEnabled,
    scatter: { ...profile.scatter },
    colorDynamicsEnabled: profile.colorDynamicsEnabled,
    colorDynamics: { ...profile.colorDynamics },
    wetEdgeEnabled: profile.wetEdgeEnabled,
    wetEdge: profile.wetEdge,
    buildupEnabled: profile.buildupEnabled,
    transferEnabled: profile.transferEnabled,
    transfer: { ...profile.transfer },
    textureEnabled: profile.textureEnabled,
    textureSettings: { ...profile.textureSettings },
    noiseEnabled: profile.noiseEnabled,
    dualBrushEnabled: profile.dualBrushEnabled,
    dualBrush: cloneDualBrushSettings(profile.dualBrush),
  };
}

function syncActiveProfilePatch(state: ToolState, patch: Partial<ToolState>): Partial<ToolState> {
  const tool = toBrushProfileTool(state.currentTool);
  if (!tool) {
    return patch;
  }

  const nextLike = { ...state, ...patch } as ToolState;
  const snapshot = snapshotProfileFromLiveState(nextLike);
  if (tool === 'brush') {
    return { ...patch, brushProfile: snapshot };
  }
  return { ...patch, eraserProfile: snapshot, eraserSize: snapshot.size };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function coerceBrushTexture(value: unknown, fallback: BrushTexture | null): BrushTexture | null {
  if (!isRecord(value)) return cloneBrushTexture(fallback);
  const textureId = typeof value.id === 'string' ? value.id : null;
  const width = typeof value.width === 'number' ? value.width : null;
  const height = typeof value.height === 'number' ? value.height : null;
  if (!textureId || width === null || height === null) return cloneBrushTexture(fallback);
  return {
    id: textureId,
    data: typeof value.data === 'string' ? value.data : '',
    width,
    height,
    cursorPath: typeof value.cursorPath === 'string' ? value.cursorPath : undefined,
    cursorBounds: isRecord(value.cursorBounds)
      ? {
          width: typeof value.cursorBounds.width === 'number' ? value.cursorBounds.width : width,
          height:
            typeof value.cursorBounds.height === 'number' ? value.cursorBounds.height : height,
        }
      : undefined,
  };
}

function coerceBrushProfile(value: unknown, fallback: BrushToolProfile): BrushToolProfile {
  if (!isRecord(value)) {
    return normalizeBrushProfile(fallback);
  }
  const raw = value as Partial<BrushToolProfile> & Record<string, unknown>;

  return normalizeBrushProfile({
    ...fallback,
    ...raw,
    texture: coerceBrushTexture(raw.texture, fallback.texture),
    shapeDynamics: isRecord(raw.shapeDynamics)
      ? { ...fallback.shapeDynamics, ...raw.shapeDynamics }
      : { ...fallback.shapeDynamics },
    scatter: isRecord(raw.scatter)
      ? { ...fallback.scatter, ...raw.scatter }
      : { ...fallback.scatter },
    colorDynamics: isRecord(raw.colorDynamics)
      ? { ...fallback.colorDynamics, ...raw.colorDynamics }
      : { ...fallback.colorDynamics },
    transfer: isRecord(raw.transfer)
      ? { ...fallback.transfer, ...raw.transfer }
      : { ...fallback.transfer },
    textureSettings: isRecord(raw.textureSettings)
      ? { ...fallback.textureSettings, ...raw.textureSettings }
      : { ...fallback.textureSettings },
    dualBrush: isRecord(raw.dualBrush)
      ? normalizeDualBrush(
          typeof raw.size === 'number' ? raw.size : fallback.size,
          { ...fallback.dualBrush, ...raw.dualBrush },
          {}
        )
      : cloneDualBrushSettings(fallback.dualBrush),
  });
}

export const useToolStore = create<ToolState>()(
  persist(
    (set, get) => {
      const setWithActiveProfile = (updater: (state: ToolState) => Partial<ToolState>): void => {
        set((state) => syncActiveProfilePatch(state, updater(state)));
      };

      return {
        // Initial state
        currentTool: 'brush',
        brushProfile: getDefaultBrushProfile(),
        eraserProfile: getDefaultBrushProfile(),
        brushSize: 20,
        brushFlow: 1, // Default: full flow
        brushOpacity: 1, // Default: full opacity ceiling
        brushHardness: 100,
        brushMaskType: 'default', // Default to simple Gaussian (perf preferred)
        brushSpacing: 0.25, // 25% of tip short edge
        brushRoundness: 100, // 100 = perfect circle
        brushAngle: 0, // 0 degrees
        brushColor: '#000000',
        backgroundColor: '#ffffff',
        brushTexture: null, // No texture by default (procedural brush)
        eraserSize: 20,
        eraserBackgroundMode: 'background-color',
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

        // Build-up (default: disabled)
        buildupEnabled: false,

        // Transfer (default: disabled with all jitter at 0)
        transferEnabled: false,
        transfer: { ...DEFAULT_TRANSFER_SETTINGS },

        // Texture (default: disabled)
        textureEnabled: false,
        textureSettings: { ...DEFAULT_TEXTURE_SETTINGS },

        // Noise (default: disabled)
        noiseEnabled: false,

        // Dual Brush (default: disabled)
        dualBrushEnabled: false,
        dualBrush: { ...DEFAULT_DUAL_BRUSH },

        // Patterns
        patterns: [],

        // Actions
        setPatterns: (patterns) => set({ patterns }),
        appendPatterns: (newPatterns) =>
          set((state) => ({ patterns: [...state.patterns, ...newPatterns] })),

        setTool: (tool) =>
          set((state) => {
            if (state.currentTool === tool) {
              return { currentTool: tool };
            }

            const currentProfileTool = toBrushProfileTool(state.currentTool);
            const nextProfileTool = toBrushProfileTool(tool);

            let nextBrushProfile = state.brushProfile;
            let nextEraserProfile = state.eraserProfile;

            if (currentProfileTool === 'brush') {
              nextBrushProfile = snapshotProfileFromLiveState(state);
            } else if (currentProfileTool === 'eraser') {
              nextEraserProfile = snapshotProfileFromLiveState(state);
            }

            if (!nextProfileTool) {
              return {
                currentTool: tool,
                brushProfile: nextBrushProfile,
                eraserProfile: nextEraserProfile,
              };
            }

            const targetProfile = normalizeBrushProfile(
              nextProfileTool === 'brush' ? nextBrushProfile : nextEraserProfile
            );
            if (nextProfileTool === 'brush') {
              nextBrushProfile = targetProfile;
            } else {
              nextEraserProfile = targetProfile;
            }

            return {
              currentTool: tool,
              brushProfile: nextBrushProfile,
              eraserProfile: nextEraserProfile,
              ...applyProfileToLiveState(targetProfile),
              eraserSize: nextEraserProfile.size,
            };
          }),

        setBrushSize: (size) =>
          setWithActiveProfile((state) => {
            const clamped = clampSize(size);
            const ratio = clampDualSizeRatio(state.dualBrush.sizeRatio);
            const normalizedDualBrush = {
              ...state.dualBrush,
              size: computeDualSizeFromRatio(clamped, ratio),
              sizeRatio: ratio,
            };
            const eraserSize = state.currentTool === 'eraser' ? clamped : state.eraserSize;
            return {
              brushSize: clamped,
              eraserSize,
              dualBrush: normalizedDualBrush,
            };
          }),

        setBrushFlow: (flow) =>
          setWithActiveProfile(() => ({ brushFlow: Math.max(0.01, Math.min(1, flow)) })),

        setBrushOpacity: (opacity) =>
          setWithActiveProfile(() => ({ brushOpacity: Math.max(0.01, Math.min(1, opacity)) })),

        setBrushHardness: (hardness) =>
          setWithActiveProfile(() => ({ brushHardness: Math.max(0, Math.min(100, hardness)) })),

        setBrushMaskType: (maskType) => setWithActiveProfile(() => ({ brushMaskType: maskType })),

        setBrushSpacing: (spacing) =>
          setWithActiveProfile(() => ({ brushSpacing: Math.max(0.01, Math.min(10, spacing)) })),

        setBrushRoundness: (roundness) =>
          setWithActiveProfile(() => ({ brushRoundness: Math.max(1, Math.min(100, roundness)) })),

        setBrushAngle: (angle) =>
          setWithActiveProfile(() => ({ brushAngle: ((angle % 360) + 360) % 360 })),

        setBrushColor: (color) =>
          set((state) => {
            if (isSameCaseInsensitiveText(state.brushColor, color)) {
              return state;
            }
            return { brushColor: color };
          }),

        setBackgroundColor: (color) => set({ backgroundColor: color }),

        setBrushTexture: (texture) =>
          setWithActiveProfile(() => ({ brushTexture: cloneBrushTexture(texture) })),

        clearBrushTexture: () => setWithActiveProfile(() => ({ brushTexture: null })),

        setEraserSize: (size) =>
          set((state) => {
            const clamped = clampSize(size);
            if (state.currentTool === 'eraser') {
              return syncActiveProfilePatch(state, {
                eraserSize: clamped,
                brushSize: clamped,
              });
            }
            return {
              eraserSize: clamped,
              eraserProfile: normalizeBrushProfile({
                ...state.eraserProfile,
                size: clamped,
              }),
            };
          }),

        setEraserBackgroundMode: (mode) => set({ eraserBackgroundMode: mode }),

        toggleEraserBackgroundMode: () =>
          set((state) => ({
            eraserBackgroundMode:
              state.eraserBackgroundMode === 'background-color'
                ? 'transparent'
                : 'background-color',
          })),

        getCurrentSize: () => {
          const state = get();
          return state.currentTool === 'eraser' ? state.eraserSize : state.brushSize;
        },

        setCurrentSize: (size) => {
          const state = get();
          if (state.currentTool === 'eraser') {
            state.setEraserSize(size);
          } else {
            state.setBrushSize(size);
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
          setWithActiveProfile((state) => ({ pressureSizeEnabled: !state.pressureSizeEnabled })),

        togglePressureFlow: () =>
          setWithActiveProfile((state) => ({ pressureFlowEnabled: !state.pressureFlowEnabled })),

        togglePressureOpacity: () =>
          setWithActiveProfile((state) => ({
            pressureOpacityEnabled: !state.pressureOpacityEnabled,
          })),

        setPressureCurve: (curve) => setWithActiveProfile(() => ({ pressureCurve: curve })),

        toggleCrosshair: () => set((state) => ({ showCrosshair: !state.showCrosshair })),

        // Texture actions
        setTextureEnabled: (enabled) => setWithActiveProfile(() => ({ textureEnabled: enabled })),

        toggleTexture: () =>
          setWithActiveProfile((state) => ({ textureEnabled: !state.textureEnabled })),

        setTextureSettings: (settings) => {
          // Optimistically load pattern if ID is provided
          if (settings.patternId) {
            patternManager.loadPattern(settings.patternId);
          }
          setWithActiveProfile((state) => {
            const nextScale =
              settings.scale === undefined
                ? state.textureSettings.scale
                : clampTextureScale(settings.scale);
            return {
              textureSettings: { ...state.textureSettings, ...settings, scale: nextScale },
            };
          });
        },

        resetTextureSettings: () =>
          setWithActiveProfile(() => ({ textureSettings: { ...DEFAULT_TEXTURE_SETTINGS } })),

        // Noise actions
        setNoiseEnabled: (enabled) => setWithActiveProfile(() => ({ noiseEnabled: enabled })),

        toggleNoise: () => setWithActiveProfile((state) => ({ noiseEnabled: !state.noiseEnabled })),

        // Shape Dynamics actions
        setShapeDynamicsEnabled: (enabled) =>
          setWithActiveProfile(() => ({ shapeDynamicsEnabled: enabled })),

        toggleShapeDynamics: () =>
          setWithActiveProfile((state) => ({ shapeDynamicsEnabled: !state.shapeDynamicsEnabled })),

        setShapeDynamics: (settings) =>
          setWithActiveProfile((state) => ({
            shapeDynamics: { ...state.shapeDynamics, ...settings },
          })),

        resetShapeDynamics: () =>
          setWithActiveProfile(() => ({ shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS } })),

        // Scatter actions
        setScatterEnabled: (enabled) => setWithActiveProfile(() => ({ scatterEnabled: enabled })),

        toggleScatter: () =>
          setWithActiveProfile((state) => ({ scatterEnabled: !state.scatterEnabled })),

        setScatter: (settings) =>
          setWithActiveProfile((state) => ({
            scatter: { ...state.scatter, ...settings },
          })),

        resetScatter: () =>
          setWithActiveProfile(() => ({ scatter: { ...DEFAULT_SCATTER_SETTINGS } })),

        // Color Dynamics actions
        setColorDynamicsEnabled: (enabled) =>
          setWithActiveProfile(() => ({ colorDynamicsEnabled: enabled })),

        toggleColorDynamics: () =>
          setWithActiveProfile((state) => ({ colorDynamicsEnabled: !state.colorDynamicsEnabled })),

        setColorDynamics: (settings) =>
          setWithActiveProfile((state) => ({
            colorDynamics: { ...state.colorDynamics, ...settings },
          })),

        resetColorDynamics: () =>
          setWithActiveProfile(() => ({ colorDynamics: { ...DEFAULT_COLOR_DYNAMICS } })),

        // Wet Edge actions
        setWetEdgeEnabled: (enabled) => setWithActiveProfile(() => ({ wetEdgeEnabled: enabled })),

        toggleWetEdge: () =>
          setWithActiveProfile((state) => ({ wetEdgeEnabled: !state.wetEdgeEnabled })),

        setWetEdge: (value) =>
          setWithActiveProfile(() => ({ wetEdge: Math.max(0, Math.min(1, value)) })),

        // Build-up actions
        setBuildupEnabled: (enabled) => setWithActiveProfile(() => ({ buildupEnabled: enabled })),

        toggleBuildup: () =>
          setWithActiveProfile((state) => ({ buildupEnabled: !state.buildupEnabled })),

        // Transfer actions
        setTransferEnabled: (enabled) => setWithActiveProfile(() => ({ transferEnabled: enabled })),

        toggleTransfer: () =>
          setWithActiveProfile((state) => ({ transferEnabled: !state.transferEnabled })),

        setTransfer: (settings) =>
          setWithActiveProfile((state) => ({
            transfer: { ...state.transfer, ...settings },
          })),

        resetTransfer: () =>
          setWithActiveProfile(() => ({ transfer: { ...DEFAULT_TRANSFER_SETTINGS } })),

        // Dual Brush actions
        setDualBrushEnabled: (enabled) =>
          setWithActiveProfile(() => ({ dualBrushEnabled: enabled })),

        toggleDualBrush: () =>
          setWithActiveProfile((state) => ({ dualBrushEnabled: !state.dualBrushEnabled })),

        setDualBrush: (settings) =>
          setWithActiveProfile((state) => ({
            dualBrush: normalizeDualBrush(state.brushSize, state.dualBrush, settings),
          })),

        resetDualBrush: () =>
          setWithActiveProfile(() => ({ dualBrush: { ...DEFAULT_DUAL_BRUSH } })),
      };
    },
    {
      name: appHyphenStorageKey('brush-settings'),
      version: 4,
      // Only persist brush-related settings, not current tool or runtime state
      migrate: (persistedState: unknown) => {
        if (!isRecord(persistedState)) {
          return persistedState as ToolState;
        }

        const state = persistedState;
        const defaultProfile = getDefaultBrushProfile();
        const legacyProfile = coerceBrushProfile(
          {
            ...defaultProfile,
            size: typeof state.brushSize === 'number' ? state.brushSize : defaultProfile.size,
            flow: state.brushFlow,
            opacity: state.brushOpacity,
            hardness: state.brushHardness,
            maskType: state.brushMaskType,
            spacing: state.brushSpacing,
            roundness: state.brushRoundness,
            angle: state.brushAngle,
            texture: state.brushTexture,
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
            buildupEnabled: state.buildupEnabled,
            transferEnabled: state.transferEnabled,
            transfer: state.transfer,
            textureEnabled: state.textureEnabled,
            textureSettings: state.textureSettings,
            noiseEnabled: state.noiseEnabled,
            dualBrushEnabled: state.dualBrushEnabled,
            dualBrush: state.dualBrush,
          },
          defaultProfile
        );

        const brushProfile = coerceBrushProfile(state.brushProfile, legacyProfile);
        const eraserProfile = coerceBrushProfile(state.eraserProfile, {
          ...legacyProfile,
          size:
            typeof state.eraserSize === 'number' ? clampSize(state.eraserSize) : legacyProfile.size,
        });
        const eraserBackgroundMode: EraserBackgroundMode =
          state.eraserBackgroundMode === 'transparent' ? 'transparent' : 'background-color';

        return {
          ...(state as unknown as ToolState),
          ...applyProfileToLiveState(brushProfile),
          brushProfile,
          eraserProfile,
          eraserSize: eraserProfile.size,
          eraserBackgroundMode,
        };
      },
      partialize: (state) =>
        (() => {
          const serializeTexture = (texture: BrushTexture | null): BrushTexture | null => {
            if (!texture) return null;
            return {
              ...texture,
              imageData: undefined,
              cursorBounds: cloneCursorBounds(texture.cursorBounds),
            };
          };
          const serializeDualBrush = (dual: DualBrushSettings): DualBrushSettings => ({
            ...dual,
            texture: dual.texture ? { ...dual.texture, imageData: undefined } : undefined,
          });
          const serializeProfile = (profile: BrushToolProfile): BrushToolProfile => ({
            ...profile,
            texture: serializeTexture(profile.texture),
            shapeDynamics: { ...profile.shapeDynamics },
            scatter: { ...profile.scatter },
            colorDynamics: { ...profile.colorDynamics },
            transfer: { ...profile.transfer },
            textureSettings: { ...profile.textureSettings },
            dualBrush: serializeDualBrush(profile.dualBrush),
          });

          return {
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
            eraserBackgroundMode: state.eraserBackgroundMode,
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
            buildupEnabled: state.buildupEnabled,
            transferEnabled: state.transferEnabled,
            transfer: state.transfer,
            textureEnabled: state.textureEnabled,
            textureSettings: state.textureSettings,
            noiseEnabled: state.noiseEnabled,
            dualBrushEnabled: state.dualBrushEnabled,
            brushProfile: serializeProfile(state.brushProfile),
            eraserProfile: serializeProfile(state.eraserProfile),
            dualBrush: state.dualBrush
              ? {
                  enabled: state.dualBrush.enabled,
                  brushId: state.dualBrush.brushId,
                  brushIndex: state.dualBrush.brushIndex,
                  brushName: state.dualBrush.brushName,
                  mode: state.dualBrush.mode,
                  flip: state.dualBrush.flip,
                  size: state.dualBrush.size,
                  sizeRatio: state.dualBrush.sizeRatio,
                  spacing: state.dualBrush.spacing,
                  roundness: state.dualBrush.roundness,
                  scatter: state.dualBrush.scatter,
                  bothAxes: state.dualBrush.bothAxes,
                  count: state.dualBrush.count,
                  // texture is excluded - it's runtime data
                }
              : state.dualBrush,
          };
        })() as unknown as ToolState,
    }
  )
);
