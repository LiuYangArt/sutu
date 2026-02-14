/**
 * @description 功能测试: [Bug]: mac版本纹理笔刷无法正确加载
 * @issue #128
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProjectProtocolUrl } from '@/utils/projectProtocolUrl';
import { getPatternThumbnailUrl } from '@/stores/pattern';

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

describe('[Bug]: mac版本纹理笔刷无法正确加载', () => {
  it('uses mac project protocol mapping for brush/layer/pattern URLs', () => {
    const mockWindow = window as MockWindow;
    mockWindow.__TAURI_INTERNALS__ = {
      convertFileSrc: vi.fn((_filePath: string, protocol: string = 'asset') => {
        return `${protocol}://localhost/`;
      }),
    };

    expect(buildProjectProtocolUrl('/brush/tip-1')).toBe('project://localhost/brush/tip-1');
    expect(buildProjectProtocolUrl('/layer/layer-1')).toBe('project://localhost/layer/layer-1');
    expect(getPatternThumbnailUrl('pattern-1', 40)).toBe(
      'project://localhost/pattern/pattern-1?thumb=48'
    );
  });

  it('keeps windows-compatible fallback when Tauri internals are missing', () => {
    const mockWindow = window as MockWindow;
    delete mockWindow.__TAURI_INTERNALS__;

    expect(buildProjectProtocolUrl('/brush/tip-1')).toBe('http://project.localhost/brush/tip-1');
    expect(buildProjectProtocolUrl('/layer/layer-1')).toBe('http://project.localhost/layer/layer-1');
    expect(getPatternThumbnailUrl('pattern-1')).toBe('http://project.localhost/pattern/pattern-1');
  });
});
