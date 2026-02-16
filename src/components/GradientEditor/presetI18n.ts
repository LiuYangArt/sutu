import type { I18nParams } from '@/i18n/types';
import type { GradientPreset } from '@/stores/gradient';

type TranslateFn = (key: string, params?: I18nParams) => string;

const BUILTIN_PRESET_NAME_KEYS: Record<string, string> = {
  preset_fg_bg: 'gradientEditor.preset.name.foregroundToBackground',
  preset_fg_transparent: 'gradientEditor.preset.name.foregroundToTransparent',
  preset_bw: 'gradientEditor.preset.name.blackAndWhite',
  preset_rainbow: 'gradientEditor.preset.name.rainbow',
};

export function getGradientPresetDisplayName(preset: GradientPreset, t: TranslateFn): string {
  const key = BUILTIN_PRESET_NAME_KEYS[preset.id];
  if (!key) return preset.name;
  return t(key);
}
