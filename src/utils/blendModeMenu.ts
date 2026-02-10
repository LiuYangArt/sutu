import type { BlendMode } from '@/stores/document';

interface BlendModeOption {
  value: BlendMode;
  label: string;
}

export type BlendModeMenuItem =
  | { kind: 'mode'; value: BlendMode; label: string }
  | { kind: 'separator'; key: string };

const BLEND_MODE_GROUPS: ReadonlyArray<ReadonlyArray<BlendModeOption>> = [
  [
    { value: 'normal', label: 'Normal' },
    { value: 'dissolve', label: 'Dissolve' },
  ],
  [
    { value: 'darken', label: 'Darken' },
    { value: 'multiply', label: 'Multiply' },
    { value: 'color-burn', label: 'Color Burn' },
    { value: 'linear-burn', label: 'Linear Burn' },
    { value: 'darker-color', label: 'Darker Color' },
  ],
  [
    { value: 'lighten', label: 'Lighten' },
    { value: 'screen', label: 'Screen' },
    { value: 'color-dodge', label: 'Color Dodge' },
    { value: 'linear-dodge', label: 'Linear Dodge (Add)' },
    { value: 'lighter-color', label: 'Lighter Color' },
  ],
  [
    { value: 'overlay', label: 'Overlay' },
    { value: 'soft-light', label: 'Soft Light' },
    { value: 'hard-light', label: 'Hard Light' },
    { value: 'vivid-light', label: 'Vivid Light' },
    { value: 'linear-light', label: 'Linear Light' },
    { value: 'pin-light', label: 'Pin Light' },
    { value: 'hard-mix', label: 'Hard Mix' },
  ],
  [
    { value: 'difference', label: 'Difference' },
    { value: 'exclusion', label: 'Exclusion' },
    { value: 'subtract', label: 'Subtract' },
    { value: 'divide', label: 'Divide' },
  ],
  [
    { value: 'hue', label: 'Hue' },
    { value: 'saturation', label: 'Saturation' },
    { value: 'color', label: 'Color' },
    { value: 'luminosity', label: 'Luminosity' },
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

export const BLEND_MODE_MENU_ITEMS: ReadonlyArray<BlendModeMenuItem> =
  buildBlendModeMenuItems(BLEND_MODE_GROUPS);

const BLEND_MODE_LABEL_MAP = buildBlendModeLabelMap(BLEND_MODE_GROUPS);

export function getBlendModeLabel(mode: BlendMode): string {
  return BLEND_MODE_LABEL_MAP.get(mode) ?? 'Normal';
}
