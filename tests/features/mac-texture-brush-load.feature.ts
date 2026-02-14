/**
 * @description 功能测试: [Bug]: mac版本纹理笔刷无法正确加载
 * @issue #128
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProjectProtocolUrl } from '@/utils/projectProtocolUrl';
import { getPatternThumbnailUrl } from '@/stores/pattern';
import {
  createPlatformConvertFileSrcMock,
  getTauriInternalsSnapshot,
  restoreTauriInternals,
  setTauriConvertFileSrcMock,
  type TauriInternalsWindow,
} from '@/test/tauriInternalsMock';

const initialTauriInternals = getTauriInternalsSnapshot();

afterEach(() => {
  restoreTauriInternals(initialTauriInternals);
});

describe('[Bug]: mac版本纹理笔刷无法正确加载', () => {
  it('uses mac project protocol mapping for brush/layer/pattern URLs', () => {
    setTauriConvertFileSrcMock(vi.fn(createPlatformConvertFileSrcMock('macos')));

    expect(buildProjectProtocolUrl('/brush/tip-1')).toBe('project://localhost/brush/tip-1');
    expect(buildProjectProtocolUrl('/layer/layer-1')).toBe('project://localhost/layer/layer-1');
    expect(getPatternThumbnailUrl('pattern-1', 40)).toBe(
      'project://localhost/pattern/pattern-1?thumb=48'
    );
  });

  it('keeps windows-compatible fallback when Tauri internals are missing', () => {
    const mockWindow = window as TauriInternalsWindow;
    delete mockWindow.__TAURI_INTERNALS__;

    expect(buildProjectProtocolUrl('/brush/tip-1')).toBe('http://project.localhost/brush/tip-1');
    expect(buildProjectProtocolUrl('/layer/layer-1')).toBe('http://project.localhost/layer/layer-1');
    expect(getPatternThumbnailUrl('pattern-1')).toBe('http://project.localhost/pattern/pattern-1');
  });
});
