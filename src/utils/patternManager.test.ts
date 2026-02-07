import { afterEach, describe, expect, it } from 'vitest';
import { patternManager, type PatternData } from './patternManager';

const TEST_PATTERN_ID = '__pattern_manager_test__';

function createPattern(id: string, value: number): PatternData {
  const data = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  return {
    id,
    width: 4,
    height: 4,
    data,
  };
}

describe('patternManager register/remove', () => {
  afterEach(() => {
    patternManager.removePattern(TEST_PATTERN_ID);
  });

  it('registerPattern stores a memory pattern for sync reads', () => {
    const pattern = createPattern(TEST_PATTERN_ID, 80);
    patternManager.registerPattern(pattern);

    expect(patternManager.hasPattern(TEST_PATTERN_ID)).toBe(true);
    const cached = patternManager.getPattern(TEST_PATTERN_ID);
    expect(cached).toBe(pattern);
    expect(cached?.data[0]).toBe(80);
  });

  it('removePattern clears cache and reports existence', () => {
    const pattern = createPattern(TEST_PATTERN_ID, 120);
    patternManager.registerPattern(pattern);

    expect(patternManager.removePattern(TEST_PATTERN_ID)).toBe(true);
    expect(patternManager.hasPattern(TEST_PATTERN_ID)).toBe(false);
    expect(patternManager.getPattern(TEST_PATTERN_ID)).toBeUndefined();
    expect(patternManager.removePattern(TEST_PATTERN_ID)).toBe(false);
  });
});
