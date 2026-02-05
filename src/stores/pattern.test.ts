import { describe, it, expect } from 'vitest';
import { getPatternThumbnailUrl, normalizePatternThumbSize } from './pattern';

describe('pattern thumbnail url', () => {
  it('normalizes thumb sizes into buckets', () => {
    expect(normalizePatternThumbSize(32)).toBe(32);
    expect(normalizePatternThumbSize(40)).toBe(48);
    expect(normalizePatternThumbSize(48)).toBe(48);
    expect(normalizePatternThumbSize(80)).toBe(80);
    expect(normalizePatternThumbSize(999)).toBe(80);
  });

  it('adds thumb query when size is provided', () => {
    expect(getPatternThumbnailUrl('abc')).toBe('http://project.localhost/pattern/abc');
    expect(getPatternThumbnailUrl('abc', 40)).toBe('http://project.localhost/pattern/abc?thumb=48');
  });
});
