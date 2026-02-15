import { describe, expect, it } from 'vitest';
import { detectPlatformKind } from './platform';

describe('platform.detectPlatformKind', () => {
  it('detects windows from platform hint', () => {
    const kind = detectPlatformKind({ platform: 'Win32', userAgent: 'Mozilla/5.0' });
    expect(kind).toBe('windows');
  });

  it('detects macos desktop when there is no touch capability', () => {
    const kind = detectPlatformKind({
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
      maxTouchPoints: 0,
    });
    expect(kind).toBe('macos');
  });

  it('detects iPadOS desktop mode as ios', () => {
    const kind = detectPlatformKind({
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
      maxTouchPoints: 5,
    });
    expect(kind).toBe('ios');
  });

  it('detects iPhone token as ios', () => {
    const kind = detectPlatformKind({
      platform: 'iPhone',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    });
    expect(kind).toBe('ios');
  });
});
