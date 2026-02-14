import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPatternThumbnailUrl, normalizePatternThumbSize } from './pattern';

type MockWindow = Window & {
  __TAURI_INTERNALS__?: {
    convertFileSrc?: (filePath: string, protocol?: string) => string;
  };
};

const initialTauriInternals = (window as MockWindow).__TAURI_INTERNALS__;

afterEach(() => {
  const mockWindow = window as MockWindow;
  if (initialTauriInternals === undefined) {
    delete mockWindow.__TAURI_INTERNALS__;
  } else {
    mockWindow.__TAURI_INTERNALS__ = initialTauriInternals;
  }
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
    const mockWindow = window as MockWindow;
    mockWindow.__TAURI_INTERNALS__ = {
      convertFileSrc: vi.fn((_filePath: string, protocol: string = 'asset') => {
        return `${protocol}://localhost/`;
      }),
    };

    expect(getPatternThumbnailUrl('abc')).toBe('project://localhost/pattern/abc');
    expect(getPatternThumbnailUrl('abc', 40)).toBe('project://localhost/pattern/abc?thumb=48');
  });
});
