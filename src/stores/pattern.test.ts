import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPlatformConvertFileSrcMock,
  getTauriInternalsSnapshot,
  restoreTauriInternals,
  setTauriConvertFileSrcMock,
} from '@/test/tauriInternalsMock';
import { getPatternThumbnailUrl, normalizePatternThumbSize } from './pattern';

const initialTauriInternals = getTauriInternalsSnapshot();

afterEach(() => {
  restoreTauriInternals(initialTauriInternals);
});

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

  it('uses macOS project://localhost mapping when available', () => {
    setTauriConvertFileSrcMock(vi.fn(createPlatformConvertFileSrcMock('macos')));

    expect(getPatternThumbnailUrl('abc')).toBe('project://localhost/pattern/abc');
    expect(getPatternThumbnailUrl('abc', 40)).toBe('project://localhost/pattern/abc?thumb=48');
  });
});
