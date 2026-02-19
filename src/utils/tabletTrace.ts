type TabletTraceWindow = Window & {
  __tabletInputTraceEnabled?: boolean;
};

export const TABLET_TRACE_FILE_RELATIVE_PATH = 'debug/tablet-input-trace.ndjson';
const TABLET_TRACE_FILE_DIR = 'debug';
const TRACE_FLUSH_DELAY_MS = 120;
const TRACE_IMMEDIATE_FLUSH_BATCH = 120;

let traceWriteQueue: string[] = [];
let traceFlushTimer: ReturnType<typeof setTimeout> | null = null;
let traceWriteInFlight = false;
let traceFileInitPromise: Promise<void> | null = null;
let traceFileInitFailed = false;

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

async function ensureTraceFileReady(): Promise<boolean> {
  if (traceFileInitFailed) return false;
  if (!traceFileInitPromise) {
    traceFileInitPromise = (async () => {
      try {
        const { BaseDirectory, mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs');
        await mkdir(TABLET_TRACE_FILE_DIR, {
          baseDir: BaseDirectory.AppConfig,
          recursive: true,
        });
        await writeTextFile(TABLET_TRACE_FILE_RELATIVE_PATH, '', {
          baseDir: BaseDirectory.AppConfig,
          create: true,
        });
      } catch {
        traceFileInitFailed = true;
      }
    })();
  }
  await traceFileInitPromise;
  return !traceFileInitFailed;
}

async function flushTraceQueue(): Promise<void> {
  if (traceWriteInFlight) return;
  if (traceWriteQueue.length === 0) return;
  const isReady = await ensureTraceFileReady();
  if (!isReady) return;

  traceWriteInFlight = true;
  const batch = traceWriteQueue.join('');
  traceWriteQueue = [];
  try {
    const { BaseDirectory, writeTextFile } = await import('@tauri-apps/plugin-fs');
    await writeTextFile(TABLET_TRACE_FILE_RELATIVE_PATH, batch, {
      baseDir: BaseDirectory.AppConfig,
      append: true,
      create: true,
    });
  } catch {
    traceFileInitFailed = true;
  } finally {
    traceWriteInFlight = false;
    if (traceWriteQueue.length > 0) {
      queueTraceFlush();
    }
  }
}

function queueTraceFlush(immediate: boolean = false): void {
  if (immediate) {
    if (traceFlushTimer !== null) {
      clearTimeout(traceFlushTimer);
      traceFlushTimer = null;
    }
    void flushTraceQueue();
    return;
  }
  if (traceFlushTimer !== null) return;
  traceFlushTimer = setTimeout(() => {
    traceFlushTimer = null;
    void flushTraceQueue();
  }, TRACE_FLUSH_DELAY_MS);
}

function appendTraceToFile(record: Record<string, unknown>): void {
  const line = `${JSON.stringify(record)}\n`;
  traceWriteQueue.push(line);
  const shouldFlushNow = traceWriteQueue.length >= TRACE_IMMEDIATE_FLUSH_BATCH;
  queueTraceFlush(shouldFlushNow);
}

export function getTabletInputTraceFileHint(): { baseDir: 'AppConfig'; relativePath: string } {
  return {
    baseDir: 'AppConfig',
    relativePath: TABLET_TRACE_FILE_RELATIVE_PATH,
  };
}

export function isTabletInputTraceEnabled(): boolean {
  const win = getTraceWindow();
  return !!win?.__tabletInputTraceEnabled;
}

export function setTabletInputTraceEnabled(enabled: boolean): void {
  const win = getTraceWindow();
  if (!win) return;
  const wasEnabled = !!win.__tabletInputTraceEnabled;
  win.__tabletInputTraceEnabled = enabled;
  if (enabled && !wasEnabled) {
    traceWriteQueue = [];
    traceFileInitPromise = null;
    traceFileInitFailed = false;
    void ensureTraceFileReady();
    return;
  }
  if (!enabled && wasEnabled) {
    queueTraceFlush(true);
  }
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
  appendTraceToFile({
    scope,
    ...stampedPayload,
  });
}
