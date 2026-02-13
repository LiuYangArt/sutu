/**
 * @description 功能测试: [Bug]: 笔刷设置的 Noise 功能，跟 Photoshop 的结果不一致。
 * @issue #103
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LOCKED_NOISE_SETTINGS, useToolStore } from '@/stores/tool';

describe('[Bug]: 笔刷设置的 Noise 功能，跟 Photoshop 的结果不一致。', () => {
  beforeEach(() => {
    useToolStore.setState({
      noiseEnabled: false,
      noiseSettings: { ...LOCKED_NOISE_SETTINGS },
    });
  });

  it('Noise 参数固定为锁定值', () => {
    const state = useToolStore.getState();
    expect(state.noiseEnabled).toBe(false);
    expect(state.noiseSettings).toEqual(LOCKED_NOISE_SETTINGS);
  });

  it('忽略外部 noise 参数更新，始终保持锁定值', () => {
    const state = useToolStore.getState();
    state.setNoiseEnabled(true);
    state.setNoiseSettings({
      size: 80,
      sizeJitter: 35,
      densityJitter: 22,
    });

    const updated = useToolStore.getState();
    expect(updated.noiseEnabled).toBe(true);
    expect(updated.noiseSettings).toEqual(LOCKED_NOISE_SETTINGS);

    updated.setNoiseSettings({
      size: -10,
      sizeJitter: 999,
      densityJitter: -5,
    });

    const clamped = useToolStore.getState();
    expect(clamped.noiseSettings).toEqual(LOCKED_NOISE_SETTINGS);
  });
});
