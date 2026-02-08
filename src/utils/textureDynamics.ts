import type { TextureSettings } from '@/components/BrushPanel/types';
import type { ControlSource } from '@/stores/tool';
import {
  applyControlWithMinimum,
  applyJitter,
  getControlValue,
  type DynamicsInput,
  type RandomFn,
} from './shapeDynamics';

const DEPTH_CONTROL_MAP = ['off', 'fade', 'penPressure', 'penTilt', 'rotation'] as const;

export function depthControlToSource(value: number): ControlSource {
  return (DEPTH_CONTROL_MAP[value] as ControlSource) || 'off';
}

export function sourceToDepthControl(source: ControlSource): number {
  const index = (DEPTH_CONTROL_MAP as readonly string[]).indexOf(source);
  return index >= 0 ? index : 0;
}

export function computeTextureDepth(
  baseDepth: number,
  settings: TextureSettings,
  input: DynamicsInput,
  random: RandomFn = Math.random
): number {
  const clampedBase = Math.max(0, Math.min(100, baseDepth));

  // Photoshop semantics: these controls are per-tip variation controls.
  if (!settings.textureEachTip) {
    return clampedBase;
  }

  const control = depthControlToSource(settings.depthControl);
  let depth = clampedBase;

  if (control !== 'off') {
    depth = applyControlWithMinimum(
      clampedBase,
      getControlValue(control, input),
      settings.minimumDepth
    );
  }

  if (settings.depthJitter > 0) {
    depth = applyJitter(depth, settings.depthJitter, random);
  }

  return Math.max(0, Math.min(100, depth));
}
