import { describe, expect, it } from 'vitest';
import { applyPresetToToolStore } from './BrushPresets';
import { BrushPreset, DEFAULT_ROUND_BRUSH, DEFAULT_TEXTURE_SETTINGS } from '../types';
import {
  DEFAULT_COLOR_DYNAMICS,
  DEFAULT_SCATTER_SETTINGS,
  DEFAULT_SHAPE_DYNAMICS,
  DEFAULT_DUAL_BRUSH,
  DEFAULT_NOISE_SETTINGS,
  DEFAULT_TRANSFER_SETTINGS,
  useToolStore,
} from '@/stores/tool';

function createTextureModePreset(
  id: string,
  name: string,
  mode: 'overlay' | 'colorBurn'
): BrushPreset {
  return {
    ...DEFAULT_ROUND_BRUSH,
    id,
    name,
    textureSettings: {
      ...DEFAULT_TEXTURE_SETTINGS,
      patternId: null,
      mode,
    },
  };
}

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
      wetEdgeEnabled: true,
      buildupEnabled: true,
      noiseEnabled: true,
      noiseSettings: { size: 90, sizeJitter: 45, densityJitter: 33 },
      dualBrushEnabled: true,
      dualBrush: { ...DEFAULT_DUAL_BRUSH, enabled: true, brushId: 'leak', size: 80, sizeRatio: 2 },
    });

    applyPresetToToolStore(DEFAULT_ROUND_BRUSH, []);

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
    expect(s.wetEdgeEnabled).toBe(false);
    expect(s.buildupEnabled).toBe(false);
    expect(s.noiseEnabled).toBe(false);
    expect(s.noiseSettings).toEqual(DEFAULT_NOISE_SETTINGS);

    expect(s.dualBrushEnabled).toBe(false);
    expect(s.dualBrush).toEqual(DEFAULT_DUAL_BRUSH);
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
        applyPerTip: false,
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
      wetEdgeEnabled: true,
      buildupEnabled: false,
      noiseEnabled: true,
      noiseSettings: {
        size: 88,
        sizeJitter: 25,
        densityJitter: 40,
      },
    };

    applyPresetToToolStore(preset, []);

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
    expect(s.colorDynamics.applyPerTip).toBe(false);

    expect(s.transferEnabled).toBe(true);
    expect(s.transfer.opacityJitter).toBe(50);
    expect(s.transfer.flowJitter).toBe(60);
    expect(s.wetEdgeEnabled).toBe(true);
    expect(s.buildupEnabled).toBe(false);
    expect(s.noiseEnabled).toBe(true);
    expect(s.noiseSettings).toEqual({
      size: 88,
      sizeJitter: 25,
      densityJitter: 40,
    });
  });

  it('主笔刷纹理优先使用 tipId 而不是 preset.id', () => {
    const preset: BrushPreset = {
      ...DEFAULT_ROUND_BRUSH,
      id: 'preset-entry-id',
      tipId: 'shared-tip-id',
      name: 'Shared Tip Preset',
      hasTexture: true,
      textureWidth: 64,
      textureHeight: 64,
    };

    applyPresetToToolStore(preset, []);

    const s = useToolStore.getState();
    expect(s.brushTexture?.id).toBe('shared-tip-id');
    expect(s.brushTexture?.width).toBe(64);
    expect(s.brushTexture?.height).toBe(64);
  });

  it('应用 Dual Brush preset 并正确映射 secondary tip', () => {
    const secondaryPreset: BrushPreset = {
      ...DEFAULT_ROUND_BRUSH,
      id: 'cached-secondary-1',
      sourceUuid: 'secondary-uuid-1',
      name: 'Secondary Tip',
      hasTexture: false,
      textureWidth: null,
      textureHeight: null,
    };

    const preset: BrushPreset = {
      ...DEFAULT_ROUND_BRUSH,
      id: 'main-1',
      name: 'Main With Dual',
      diameter: 100,
      dualBrushSettings: {
        enabled: true,
        brushId: 'secondary-uuid-1',
        brushName: null,
        mode: 'overlay',
        flip: true,
        size: 50,
        roundness: 80,
        sizeRatio: 0.5,
        spacing: 0.12,
        scatter: 123,
        bothAxes: true,
        count: 3,
      },
    };

    applyPresetToToolStore(preset, [secondaryPreset, preset]);

    const s = useToolStore.getState();
    expect(s.dualBrushEnabled).toBe(true);
    expect(s.dualBrush.brushId).toBe('cached-secondary-1');
    expect(s.dualBrush.brushIndex).toBe(0);
    expect(s.dualBrush.brushName).toBe('Secondary Tip');
    expect(s.dualBrush.mode).toBe('overlay');
    expect(s.dualBrush.flip).toBe(true);
    expect(s.dualBrush.spacing).toBeCloseTo(0.12);
    expect(s.dualBrush.scatter).toBe(123);
    expect(s.dualBrush.bothAxes).toBe(true);
    expect(s.dualBrush.count).toBe(3);
    expect(s.dualBrush.roundness).toBe(80);
    expect(s.dualBrush.sizeRatio).toBeCloseTo(0.5);
    expect(s.dualBrush.size).toBe(50);
  });

  it('切换不同 preset 时应同步切换 Texture blend mode', () => {
    const overlayPreset = createTextureModePreset('texture-overlay', 'Texture Overlay', 'overlay');
    const colorBurnPreset = createTextureModePreset(
      'texture-color-burn',
      'Texture Color Burn',
      'colorBurn'
    );

    applyPresetToToolStore(overlayPreset, []);
    expect(useToolStore.getState().textureSettings.mode).toBe('overlay');

    applyPresetToToolStore(colorBurnPreset, []);
    expect(useToolStore.getState().textureSettings.mode).toBe('colorBurn');
  });
});
