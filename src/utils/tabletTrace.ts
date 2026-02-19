type TabletTraceWindow = Window & {
  __tabletInputTraceEnabled?: boolean;
};

function getTraceWindow(): TabletTraceWindow | null {
  if (typeof window === 'undefined') return null;
  return window as TabletTraceWindow;
}

function getPerfNowMs(): number | null {
  if (typeof performance === 'undefined' || typeof performance.now !== 'function') {
    return null;
  }
  const now = performance.now();
  return Number.isFinite(now) ? now : null;
}

export function isTabletInputTraceEnabled(): boolean {
  const win = getTraceWindow();
  return !!win?.__tabletInputTraceEnabled;
}

export function setTabletInputTraceEnabled(enabled: boolean): void {
  const win = getTraceWindow();
  if (!win) return;
  win.__tabletInputTraceEnabled = enabled;
}

export function logTabletTrace(scope: string, payload: Record<string, unknown>): void {
  if (!isTabletInputTraceEnabled()) return;

  const epochMs = Date.now();
  const perfMs = getPerfNowMs();
  const stampedPayload: Record<string, unknown> = {
    trace_iso_time: new Date(epochMs).toISOString(),
    trace_epoch_ms: epochMs,
    trace_perf_ms: perfMs,
    ...payload,
  };

  // eslint-disable-next-line no-console
  console.info(`[TabletTrace][${scope}]`, stampedPayload);
}
