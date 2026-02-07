import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIZE_PRESETS,
  buildAllSizePresets,
  findPresetMatchByDimensions,
  toOrientedPresetSize,
} from '../presets';

describe('new file presets', () => {
  it('includes expected paper and device preset dimensions', () => {
    const a4 = DEFAULT_SIZE_PRESETS.find((preset) => preset.id === 'paper-a4');
    const p4k = DEFAULT_SIZE_PRESETS.find((preset) => preset.id === 'device-4k');

    expect(a4).toBeDefined();
    expect(a4?.width).toBe(2480);
    expect(a4?.height).toBe(3508);

    expect(p4k).toBeDefined();
    expect(p4k?.width).toBe(3840);
    expect(p4k?.height).toBe(2160);
  });

  it('applies preset orientation by swapping width and height when needed', () => {
    const a4 = DEFAULT_SIZE_PRESETS.find((preset) => preset.id === 'paper-a4');
    expect(a4).toBeDefined();

    const portrait = toOrientedPresetSize(a4!, 'portrait');
    const landscape = toOrientedPresetSize(a4!, 'landscape');

    expect(portrait).toEqual({ width: 2480, height: 3508 });
    expect(landscape).toEqual({ width: 3508, height: 2480 });
  });

  it('finds matching preset and orientation from dimensions', () => {
    const customPresets = [{ id: 'custom-card', name: 'Card', width: 1200, height: 1600 }];
    const all = buildAllSizePresets(customPresets);

    expect(findPresetMatchByDimensions(2480, 3508, all)).toEqual({
      presetId: 'paper-a4',
      orientation: 'portrait',
    });
    expect(findPresetMatchByDimensions(3508, 2480, all)).toEqual({
      presetId: 'paper-a4',
      orientation: 'landscape',
    });
    expect(findPresetMatchByDimensions(1200, 1600, all)).toEqual({
      presetId: 'custom-card',
      orientation: 'portrait',
    });
    expect(findPresetMatchByDimensions(999, 999, all)).toBeNull();
  });
});
