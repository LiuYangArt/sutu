import type { TextureSettings } from '@/components/BrushPanel/types';
import type { ControlSource } from '@/stores/tool';
import {
  applyControlWithMinimum,
  applyJitter,
  getControlValue,
  type DynamicsInput,
  type RandomFn,
} from './shapeDynamics';

export function depthControlToSource(value: number): ControlSource {
  switch (value) {
    case 1:
      return 'fade';
    case 2:
      return 'penPressure';
    case 3:
      return 'penTilt';
    case 4:
      return 'rotation';
    default:
      return 'off';
  }
}

export function sourceToDepthControl(source: ControlSource): number {
  switch (source) {
    case 'fade':
      return 1;
    case 'penPressure':
      return 2;
    case 'penTilt':
      return 3;
    case 'rotation':
      return 4;
    default:
      return 0;
  }
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
