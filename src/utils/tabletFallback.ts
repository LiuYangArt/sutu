import type { PlatformKind } from './platform';

const NORMALIZATION_TOKEN = 'not supported on this platform';
const POINTEREVENT_TOKEN = "using 'pointerevent'";
const IOS_NORMALIZATION_MESSAGE =
  'iPad uses PointerEvent by design (Apple Pencil pressure is supported).';

export function isPlatformNormalizationFallback(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return normalized.includes(NORMALIZATION_TOKEN) && normalized.includes(POINTEREVENT_TOKEN);
}

export function formatTabletFallbackReason(
  reason: string | null | undefined,
  platformKind: PlatformKind,
  target: 'toast' | 'inline' = 'inline'
): string | null {
  if (!reason) return null;

  if (platformKind === 'ios' && isPlatformNormalizationFallback(reason)) {
    if (target === 'toast') {
      return `Tablet backend: ${IOS_NORMALIZATION_MESSAGE}`;
    }
    return IOS_NORMALIZATION_MESSAGE;
  }

  return target === 'toast' ? `Tablet fallback: ${reason}` : reason;
}
