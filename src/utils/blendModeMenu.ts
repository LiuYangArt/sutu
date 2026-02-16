import type { BlendMode } from '@/stores/document';

interface BlendModeOption {
  value: BlendMode;
  label: string;
  labelKey: string;
}

export type BlendModeMenuItem =
  | { kind: 'mode'; value: BlendMode; label: string; labelKey: string }
  | { kind: 'separator'; key: string };

const BLEND_MODE_GROUPS: ReadonlyArray<ReadonlyArray<BlendModeOption>> = [
  [
    { value: 'normal', label: 'Normal', labelKey: 'blendMode.normal' },
    { value: 'dissolve', label: 'Dissolve', labelKey: 'blendMode.dissolve' },
  ],
  [
    { value: 'darken', label: 'Darken', labelKey: 'blendMode.darken' },
    { value: 'multiply', label: 'Multiply', labelKey: 'blendMode.multiply' },
    { value: 'color-burn', label: 'Color Burn', labelKey: 'blendMode.colorBurn' },
    { value: 'linear-burn', label: 'Linear Burn', labelKey: 'blendMode.linearBurn' },
    { value: 'darker-color', label: 'Darker Color', labelKey: 'blendMode.darkerColor' },
  ],
  [
    { value: 'lighten', label: 'Lighten', labelKey: 'blendMode.lighten' },
    { value: 'screen', label: 'Screen', labelKey: 'blendMode.screen' },
    { value: 'color-dodge', label: 'Color Dodge', labelKey: 'blendMode.colorDodge' },
    { value: 'linear-dodge', label: 'Linear Dodge (Add)', labelKey: 'blendMode.linearDodge' },
    { value: 'lighter-color', label: 'Lighter Color', labelKey: 'blendMode.lighterColor' },
  ],
  [
    { value: 'overlay', label: 'Overlay', labelKey: 'blendMode.overlay' },
    { value: 'soft-light', label: 'Soft Light', labelKey: 'blendMode.softLight' },
    { value: 'hard-light', label: 'Hard Light', labelKey: 'blendMode.hardLight' },
    { value: 'vivid-light', label: 'Vivid Light', labelKey: 'blendMode.vividLight' },
    { value: 'linear-light', label: 'Linear Light', labelKey: 'blendMode.linearLight' },
    { value: 'pin-light', label: 'Pin Light', labelKey: 'blendMode.pinLight' },
    { value: 'hard-mix', label: 'Hard Mix', labelKey: 'blendMode.hardMix' },
  ],
  [
    { value: 'difference', label: 'Difference', labelKey: 'blendMode.difference' },
    { value: 'exclusion', label: 'Exclusion', labelKey: 'blendMode.exclusion' },
    { value: 'subtract', label: 'Subtract', labelKey: 'blendMode.subtract' },
    { value: 'divide', label: 'Divide', labelKey: 'blendMode.divide' },
  ],
  [
    { value: 'hue', label: 'Hue', labelKey: 'blendMode.hue' },
    { value: 'saturation', label: 'Saturation', labelKey: 'blendMode.saturation' },
    { value: 'color', label: 'Color', labelKey: 'blendMode.color' },
    { value: 'luminosity', label: 'Luminosity', labelKey: 'blendMode.luminosity' },
  ],
];

function buildBlendModeMenuItems(
  groups: ReadonlyArray<ReadonlyArray<BlendModeOption>>
): BlendModeMenuItem[] {
  const items: BlendModeMenuItem[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    if (!group) continue;
    for (const mode of group) {
      items.push({ kind: 'mode', ...mode });
    }
    if (i < groups.length - 1) {
      items.push({ kind: 'separator', key: `sep-${i}` });
    }
  }
  return items;
}

function buildBlendModeLabelMap(
  groups: ReadonlyArray<ReadonlyArray<BlendModeOption>>
): Map<BlendMode, string> {
  const map = new Map<BlendMode, string>();
  for (const group of groups) {
    for (const mode of group) {
      map.set(mode.value, mode.label);
    }
  }
  return map;
}

function buildBlendModeLabelKeyMap(
  groups: ReadonlyArray<ReadonlyArray<BlendModeOption>>
): Map<BlendMode, string> {
  const map = new Map<BlendMode, string>();
  for (const group of groups) {
    for (const mode of group) {
      map.set(mode.value, mode.labelKey);
    }
  }
  return map;
}

export const BLEND_MODE_MENU_ITEMS: ReadonlyArray<BlendModeMenuItem> =
  buildBlendModeMenuItems(BLEND_MODE_GROUPS);

const BLEND_MODE_LABEL_MAP = buildBlendModeLabelMap(BLEND_MODE_GROUPS);
const BLEND_MODE_LABEL_KEY_MAP = buildBlendModeLabelKeyMap(BLEND_MODE_GROUPS);

export function getBlendModeLabel(mode: BlendMode): string {
  return BLEND_MODE_LABEL_MAP.get(mode) ?? 'Normal';
}

export function getBlendModeLabelKey(mode: BlendMode): string {
  return BLEND_MODE_LABEL_KEY_MAP.get(mode) ?? 'blendMode.normal';
}
