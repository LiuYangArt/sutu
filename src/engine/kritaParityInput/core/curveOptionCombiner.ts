import { clamp01 } from './types';

export type CurveCombineMode = 'multiply' | 'add' | 'max' | 'min' | 'difference';

export interface CurveOptionCombineInput {
  constant: number;
  values: number[];
  mode: CurveCombineMode;
  min?: number;
  max?: number;
}

function clampRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function reduceValues(values: readonly number[], mode: CurveCombineMode): number {
  if (values.length === 0) return 1;
  let acc = values[0] ?? 1;
  for (let i = 1; i < values.length; i += 1) {
    const value = values[i] ?? 1;
    switch (mode) {
      case 'add':
        acc += value;
        break;
      case 'max':
        acc = Math.max(acc, value);
        break;
      case 'min':
        acc = Math.min(acc, value);
        break;
      case 'difference':
        acc = Math.abs(acc - value);
        break;
      case 'multiply':
      default:
        acc *= value;
        break;
    }
  }
  return acc;
}

export function combineCurveOption(input: CurveOptionCombineInput): number {
  const constant = Number.isFinite(input.constant) ? input.constant : 1;
  const reduced = reduceValues(input.values, input.mode);
  const raw = constant * reduced;
  const min = Number.isFinite(input.min) ? Number(input.min) : 0;
  const max = Number.isFinite(input.max) ? Number(input.max) : 1;
  if (max <= min) return clampRange(raw, min, min + 1e-6);
  return clampRange(raw, min, max);
}

export function combineScale01(values: number[], mode: CurveCombineMode): number {
  return clamp01(reduceValues(values, mode));
}
