import type { CustomSizePreset, NewFileOrientation } from '@/stores/settings';

export type SizePresetGroup = 'paper' | 'device' | 'custom';

export interface SizePreset {
  id: string;
  name: string;
  width: number;
  height: number;
  group: SizePresetGroup;
  isDefault: boolean;
}

interface PresetMatchResult {
  presetId: string;
  orientation: NewFileOrientation;
}

const PAPER_SIZE_PRESETS: ReadonlyArray<Omit<SizePreset, 'group' | 'isDefault'>> = [
  { id: 'paper-a1', name: 'A1', width: 7016, height: 9933 },
  { id: 'paper-a2', name: 'A2', width: 4961, height: 7016 },
  { id: 'paper-a3', name: 'A3', width: 3508, height: 4961 },
  { id: 'paper-a4', name: 'A4', width: 2480, height: 3508 },
  { id: 'paper-a5', name: 'A5', width: 1748, height: 2480 },
];

const DEVICE_SIZE_PRESETS: ReadonlyArray<Omit<SizePreset, 'group' | 'isDefault'>> = [
  { id: 'device-720p', name: '720P', width: 1280, height: 720 },
  { id: 'device-1080p', name: '1080P', width: 1920, height: 1080 },
  { id: 'device-1440p', name: '1440P', width: 2560, height: 1440 },
  { id: 'device-4k', name: '4K', width: 3840, height: 2160 },
  { id: 'device-8k', name: '8K', width: 7680, height: 4320 },
];

export const DEFAULT_SIZE_PRESETS: ReadonlyArray<SizePreset> = [
  ...PAPER_SIZE_PRESETS.map((preset) => ({ ...preset, group: 'paper' as const, isDefault: true })),
  ...DEVICE_SIZE_PRESETS.map((preset) => ({
    ...preset,
    group: 'device' as const,
    isDefault: true,
  })),
];

export function toOrientedSize(
  width: number,
  height: number,
  orientation: NewFileOrientation
): { width: number; height: number } {
  if (orientation === 'portrait') {
    return width <= height ? { width, height } : { width: height, height: width };
  }
  return width >= height ? { width, height } : { width: height, height: width };
}

export function toOrientedPresetSize(
  preset: Pick<SizePreset, 'width' | 'height'>,
  orientation: NewFileOrientation
): { width: number; height: number } {
  return toOrientedSize(preset.width, preset.height, orientation);
}

export function resolveOrientationFromSize(width: number, height: number): NewFileOrientation {
  return width >= height ? 'landscape' : 'portrait';
}

export function mapCustomSizePresets(customSizePresets: CustomSizePreset[]): SizePreset[] {
  return customSizePresets.map((preset) => ({
    ...preset,
    group: 'custom',
    isDefault: false,
  }));
}

export function buildAllSizePresets(customSizePresets: CustomSizePreset[]): SizePreset[] {
  return [...DEFAULT_SIZE_PRESETS, ...mapCustomSizePresets(customSizePresets)];
}

export function findSizePresetById(
  presetId: string | null,
  customSizePresets: CustomSizePreset[]
): SizePreset | null {
  if (!presetId) return null;
  const allPresets = buildAllSizePresets(customSizePresets);
  return allPresets.find((preset) => preset.id === presetId) ?? null;
}

export function findPresetMatchByDimensions(
  width: number,
  height: number,
  allPresets: Array<Pick<SizePreset, 'id' | 'width' | 'height'>>
): PresetMatchResult | null {
  for (const preset of allPresets) {
    if (preset.width === width && preset.height === height) {
      return {
        presetId: preset.id,
        orientation: resolveOrientationFromSize(width, height),
      };
    }
    if (preset.width === height && preset.height === width) {
      return {
        presetId: preset.id,
        orientation: resolveOrientationFromSize(width, height),
      };
    }
  }
  return null;
}
