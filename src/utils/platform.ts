type NavigatorLike = {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: {
    platform?: string;
  };
};

export type PlatformKind = 'windows' | 'macos' | 'ios' | 'other';

function getPlatformHint(nav: NavigatorLike): string {
  return nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? '';
}

function getMaxTouchPoints(nav: NavigatorLike): number {
  const value = nav.maxTouchPoints;
  return Number.isFinite(value) ? Number(value) : 0;
}

function isIPadOSDesktopMode(nav: NavigatorLike): boolean {
  const platform = nav.platform ?? '';
  return /mac/i.test(platform) && getMaxTouchPoints(nav) > 1;
}

export function detectPlatformKind(nav?: NavigatorLike): PlatformKind {
  if (!nav) {
    if (typeof navigator === 'undefined') return 'windows';
    return detectPlatformKind(navigator as NavigatorLike);
  }

  const ua = nav.userAgent ?? '';
  const platformHint = getPlatformHint(nav);
  const iosToken = /(iphone|ipad|ipod)/i;
  if (iosToken.test(ua) || iosToken.test(platformHint) || isIPadOSDesktopMode(nav)) {
    return 'ios';
  }
  if (/(windows|win32|win64|win)/i.test(platformHint)) return 'windows';
  if (/mac/i.test(platformHint)) return 'macos';
  return 'other';
}
