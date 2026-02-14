import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProjectProtocolUrl, getProjectProtocolBaseUrl } from '@/utils/projectProtocolUrl';
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

describe('projectProtocolUrl', () => {
  it('falls back to project localhost when Tauri internals are unavailable', () => {
    const mockWindow = window as TauriInternalsWindow;
    delete mockWindow.__TAURI_INTERNALS__;

    expect(getProjectProtocolBaseUrl()).toBe('http://project.localhost');
    expect(buildProjectProtocolUrl('/brush/abc')).toBe('http://project.localhost/brush/abc');
  });

  it('uses Tauri convertFileSrc mapping on Windows', () => {
    const convertFileSrc = vi.fn(createPlatformConvertFileSrcMock('windows'));
    setTauriConvertFileSrcMock(convertFileSrc);

    expect(getProjectProtocolBaseUrl()).toBe('http://project.localhost');
    expect(buildProjectProtocolUrl('/pattern/p1?thumb=48')).toBe(
      'http://project.localhost/pattern/p1?thumb=48'
    );
    expect(convertFileSrc).toHaveBeenCalledWith('', 'project');
  });

  it('uses Tauri convertFileSrc mapping on macOS', () => {
    const convertFileSrc = vi.fn(createPlatformConvertFileSrcMock('macos'));
    setTauriConvertFileSrcMock(convertFileSrc);

    expect(getProjectProtocolBaseUrl()).toBe('project://localhost');
    expect(buildProjectProtocolUrl('/layer/layer-1')).toBe('project://localhost/layer/layer-1');
    expect(convertFileSrc).toHaveBeenCalledWith('', 'project');
  });

  it('falls back when convertFileSrc throws', () => {
    const convertFileSrc = vi.fn(() => {
      throw new Error('convert failed');
    });
    setTauriConvertFileSrcMock(convertFileSrc);

    expect(getProjectProtocolBaseUrl()).toBe('http://project.localhost');
    expect(buildProjectProtocolUrl('/layer/l1')).toBe('http://project.localhost/layer/l1');
  });
});
