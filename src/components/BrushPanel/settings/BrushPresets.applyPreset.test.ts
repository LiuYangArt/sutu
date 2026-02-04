import { describe, expect, it } from 'vitest';
import { applyPresetToToolStore } from './BrushPresets';
import { BrushPreset, DEFAULT_ROUND_BRUSH } from '../types';
import {
  DEFAULT_COLOR_DYNAMICS,
  DEFAULT_SCATTER_SETTINGS,
  DEFAULT_SHAPE_DYNAMICS,
  DEFAULT_TRANSFER_SETTINGS,
  useToolStore,
} from '@/stores/tool';

describe('applyPresetToToolStore', () => {
  it('重置并禁用动态面板，避免 preset 泄漏', () => {
    useToolStore.setState({
      brushOpacity: 0.3,
      brushFlow: 0.4,
      shapeDynamicsEnabled: true,
      shapeDynamics: { ...DEFAULT_SHAPE_DYNAMICS, sizeJitter: 77, minimumDiameter: 12 },
      scatterEnabled: true,
      scatter: { ...DEFAULT_SCATTER_SETTINGS, scatter: 321, bothAxes: true, count: 9 },
      colorDynamicsEnabled: true,
      colorDynamics: { ...DEFAULT_COLOR_DYNAMICS, hueJitter: 55, purity: 10 },
      transferEnabled: true,
      transfer: { ...DEFAULT_TRANSFER_SETTINGS, opacityJitter: 66, minimumOpacity: 22 },
    });

    applyPresetToToolStore(DEFAULT_ROUND_BRUSH);

    const s = useToolStore.getState();
    expect(s.brushOpacity).toBe(1);
    expect(s.brushFlow).toBe(1);

    expect(s.shapeDynamicsEnabled).toBe(false);
    expect(s.shapeDynamics).toEqual(DEFAULT_SHAPE_DYNAMICS);

    expect(s.scatterEnabled).toBe(false);
    expect(s.scatter).toEqual(DEFAULT_SCATTER_SETTINGS);

    expect(s.colorDynamicsEnabled).toBe(false);
    expect(s.colorDynamics).toEqual(DEFAULT_COLOR_DYNAMICS);

    expect(s.transferEnabled).toBe(false);
    expect(s.transfer).toEqual(DEFAULT_TRANSFER_SETTINGS);
  });

  it('应用 ABR preset 的基础值与动态面板参数', () => {
    const preset: BrushPreset = {
      ...DEFAULT_ROUND_BRUSH,
      id: 'test-preset-1',
      name: 'Test Preset',
      baseOpacity: 0.5,
      baseFlow: 0.7,
      shapeDynamicsEnabled: true,
      shapeDynamics: {
        ...DEFAULT_SHAPE_DYNAMICS,
        sizeJitter: 12,
        sizeControl: 'penPressure',
        minimumDiameter: 33,
        angleJitter: 90,
        angleControl: 'direction',
        roundnessJitter: 15,
        roundnessControl: 'off',
        minimumRoundness: 49,
      },
      scatterEnabled: true,
      scatter: {
        ...DEFAULT_SCATTER_SETTINGS,
        scatter: 200,
        scatterControl: 'penPressure',
        bothAxes: true,
        count: 4,
        countJitter: 25,
      },
      colorDynamicsEnabled: true,
      colorDynamics: {
        ...DEFAULT_COLOR_DYNAMICS,
        hueJitter: 10,
        saturationJitter: 20,
        brightnessJitter: 30,
        purity: -15,
        foregroundBackgroundJitter: 40,
        foregroundBackgroundControl: 'penPressure',
      },
      transferEnabled: true,
      transfer: {
        ...DEFAULT_TRANSFER_SETTINGS,
        opacityJitter: 50,
        opacityControl: 'penPressure',
        minimumOpacity: 10,
        flowJitter: 60,
        flowControl: 'penPressure',
        minimumFlow: 20,
      },
    };

    applyPresetToToolStore(preset);

    const s = useToolStore.getState();
    expect(s.brushOpacity).toBeCloseTo(0.5);
    expect(s.brushFlow).toBeCloseTo(0.7);

    expect(s.shapeDynamicsEnabled).toBe(true);
    expect(s.shapeDynamics.sizeJitter).toBe(12);
    expect(s.shapeDynamics.sizeControl).toBe('penPressure');
    expect(s.shapeDynamics.minimumDiameter).toBe(33);

    expect(s.scatterEnabled).toBe(true);
    expect(s.scatter.scatter).toBe(200);
    expect(s.scatter.scatterControl).toBe('penPressure');
    expect(s.scatter.count).toBe(4);
    expect(s.scatter.countJitter).toBe(25);

    expect(s.colorDynamicsEnabled).toBe(true);
    expect(s.colorDynamics.hueJitter).toBe(10);
    expect(s.colorDynamics.purity).toBe(-15);
    expect(s.colorDynamics.foregroundBackgroundControl).toBe('penPressure');

    expect(s.transferEnabled).toBe(true);
    expect(s.transfer.opacityJitter).toBe(50);
    expect(s.transfer.flowJitter).toBe(60);
  });
});
