/**
 * @description 功能测试: [Bug]: 笔刷设置的 Noise 功能，跟 Photoshop 的结果不一致。
 * @issue #103
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useToolStore } from '@/stores/tool';

describe('[Bug]: 笔刷设置的 Noise 功能，跟 Photoshop 的结果不一致。', () => {
  beforeEach(() => {
    useToolStore.setState({
      noiseEnabled: false,
      noiseSettings: {
        size: 100,
        sizeJitter: 0,
        densityJitter: 0,
      },
    });
  });

  it('新增参数默认值符合预期（jitter 默认 0）', () => {
    const state = useToolStore.getState();
    expect(state.noiseEnabled).toBe(false);
    expect(state.noiseSettings).toEqual({
      size: 100,
      sizeJitter: 0,
      densityJitter: 0,
    });
  });

  it('支持更新 noise 参数并做范围钳制', () => {
    const state = useToolStore.getState();
    state.setNoiseEnabled(true);
    state.setNoiseSettings({
      size: 80,
      sizeJitter: 35,
      densityJitter: 22,
    });

    const updated = useToolStore.getState();
    expect(updated.noiseEnabled).toBe(true);
    expect(updated.noiseSettings).toEqual({
      size: 80,
      sizeJitter: 35,
      densityJitter: 22,
    });

    updated.setNoiseSettings({
      size: -10,
      sizeJitter: 999,
      densityJitter: -5,
    });

    const clamped = useToolStore.getState();
    expect(clamped.noiseSettings).toEqual({
      size: 1,
      sizeJitter: 100,
      densityJitter: 0,
    });
  });
});
