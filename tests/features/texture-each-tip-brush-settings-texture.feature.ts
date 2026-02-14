/**
 * @description 功能测试: [Feature]: 补充 Texture Each Tip 功能（Brush Settings > Texture）
 * @issue #119
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_TEXTURE_SETTINGS } from '@/components/BrushPanel/types';
import { computeTextureDepth } from '@/utils/textureDynamics';

describe('[Feature]: 补充 Texture Each Tip 功能（Brush Settings > Texture）', () => {
  it('Texture Each Tip 关闭时，depth 控制参数不会改变有效 depth', () => {
    const settings = {
      ...DEFAULT_TEXTURE_SETTINGS,
      textureEachTip: false,
      depth: 62,
      depthControl: 2,
      minimumDepth: 80,
      depthJitter: 100,
    };
    const result = computeTextureDepth(settings.depth, settings, {
      pressure: 0.1,
      tiltX: 0,
      tiltY: 0,
      rotation: 0,
      direction: 0,
      initialDirection: 0,
      fadeProgress: 0,
    });
    expect(result).toBe(62);
  });

  it('Texture Each Tip 开启且 Control=Off 时，Minimum Depth 不生效', () => {
    const settings = {
      ...DEFAULT_TEXTURE_SETTINGS,
      textureEachTip: true,
      depth: 80,
      depthControl: 0,
      minimumDepth: 90,
      depthJitter: 0,
    };
    const result = computeTextureDepth(settings.depth, settings, {
      pressure: 0.2,
      tiltX: 0,
      tiltY: 0,
      rotation: 0,
      direction: 0,
      initialDirection: 0,
      fadeProgress: 0,
    });
    expect(result).toBe(80);
  });
});
