import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  Bug,
  Grid3X3,
  Zap,
  Play,
  X,
  RotateCcw,
  Download,
  ChevronDown,
  ChevronUp,
  Timer,
} from 'lucide-react';
import {
  InputSimulator,
  verifyGrid,
  formatVerificationReport,
  chaosMixed,
  formatChaosReport,
  installDiagnosticHooks,
  getTestReport,
  type ChaosTestResult,
  type DiagnosticHooks,
  type StrokeCaptureData,
} from '../../test';
import { LatencyProfilerStats, FrameStats, LagometerStats } from '@/benchmark/types';
import {
  BenchmarkRunner,
  DEFAULT_SCENARIOS,
  downloadBenchmarkReport,
  type BenchmarkReport,
  type LatencyProfiler,
  type FPSCounter,
  type LagometerMonitor,
} from '@/benchmark';
import type { GpuBrushCommitMetricsSnapshot, GpuBrushCommitReadbackMode } from '@/gpu';
import { runLatencyBenchmark } from '@/utils/LatencyTest';
import './DebugPanel.css';

// --- Types ---

interface DebugPanelProps {
  canvas: HTMLCanvasElement | null;
  onClose: () => void;
}

type TestStatus = 'idle' | 'running' | 'passed' | 'failed';

interface TestResult {
  name: string;
  status: TestStatus;
  report?: string;
  timestamp: Date;
}

interface BenchmarkStatsData {
  latency: LatencyProfilerStats;
  fps: FrameStats;
  lagometer: LagometerStats;
  queueDepth: number;
}

interface ManualGateChecklist {
  noThinStart: boolean;
  noMissingOrDisappear: boolean;
  noTailDab: boolean;
}

const DEFAULT_MANUAL_GATE_CHECKLIST: ManualGateChecklist = {
  noThinStart: false,
  noMissingOrDisappear: false,
  noTailDab: false,
};

type GpuBrushDiagnosticsSnapshot = {
  diagnosticsSessionId?: number;
  uncapturedErrors?: unknown[];
  deviceLost?: boolean;
};

type RAfFrameSamplingSummary = {
  sampleCount: number;
  avgMs: number;
  p95Ms: number;
  p99Ms: number;
  droppedFrames: number;
};

const PHASE6B_TARGET_DURATION_MS = 30_000;
const PHASE6B3_FIXED_CAPTURE_NAME = 'case-5000-04.json';
const PHASE6B3_FIXED_CAPTURE_PATH = `/abr/${PHASE6B3_FIXED_CAPTURE_NAME}`;
const PILOT_BASELINE_A_TOTAL_MS = 62.27;
const PILOT_READBACK_NEAR_ZERO_MS = 2;
const PHASE6B3_READBACK_SEQUENCE: GpuBrushCommitReadbackMode[] = [
  'enabled',
  'disabled',
  'disabled',
  'enabled',
];

type RAfFrameSlice = {
  frameTimes: number[];
  frameCount: number;
};

type Phase6B3RoundResult = {
  mode: GpuBrushCommitReadbackMode;
  sequenceIndex: number;
  didResetDiag: boolean;
  didResetCommitMetrics: boolean;
  clearPerRound: boolean;
  replayCount: number;
  replayElapsedMs: number;
  clearElapsedMs: number;
  frameSlice: RAfFrameSlice;
  commitSnapshot: GpuBrushCommitMetricsSnapshot | null;
  uncapturedErrors: unknown[];
  deviceLost: boolean;
  sessionAfterReset: number | string;
  sessionAfterRun: number | string;
  passed: boolean;
};

type Phase6B3ModeAggregate = {
  mode: GpuBrushCommitReadbackMode;
  rounds: number;
  replayElapsedMs: number;
  clearElapsedMs: number;
  frameSummary: RAfFrameSamplingSummary;
  commitSnapshot: GpuBrushCommitMetricsSnapshot;
  uncapturedErrors: number;
  deviceLost: boolean;
};

type Phase6B3CaptureResult = {
  capture: StrokeCaptureData;
  name: string;
  source: string;
};

function asGpuDiagnosticsSnapshot(value: unknown): GpuBrushDiagnosticsSnapshot {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return value as GpuBrushDiagnosticsSnapshot;
}

function asGpuBrushCommitMetricsSnapshot(value: unknown): GpuBrushCommitMetricsSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as GpuBrushCommitMetricsSnapshot;
}

function isGpuBrushCommitReadbackMode(value: unknown): value is GpuBrushCommitReadbackMode {
  return value === 'enabled' || value === 'disabled';
}

function assertStrokeCaptureData(value: unknown): asserts value is StrokeCaptureData {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid capture JSON: expected object');
  }
  const capture = value as StrokeCaptureData;
  if (!Array.isArray(capture.samples) || !capture.metadata) {
    throw new Error('Invalid capture JSON: missing samples/metadata');
  }
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  const clipboardApi = (
    navigator as Navigator & {
      clipboard?: { writeText?: (value: string) => Promise<void> };
    }
  ).clipboard;

  if (clipboardApi?.writeText) {
    try {
      await clipboardApi.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * ratio) - 1)
  );
  return sortedValues[index] ?? 0;
}

function summarizeRafFrames(frameTimes: number[], frameCount: number): RAfFrameSamplingSummary {
  if (frameCount === 0) {
    return {
      sampleCount: 0,
      avgMs: 0,
      p95Ms: 0,
      p99Ms: 0,
      droppedFrames: 0,
    };
  }

  if (frameTimes.length === 0) {
    return {
      sampleCount: frameCount,
      avgMs: 0,
      p95Ms: 0,
      p99Ms: 0,
      droppedFrames: 0,
    };
  }

  const sorted = [...frameTimes].sort((a, b) => a - b);
  const sum = frameTimes.reduce((acc, value) => acc + value, 0);

  return {
    sampleCount: frameCount,
    avgMs: sum / frameTimes.length,
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    droppedFrames: frameTimes.filter((value) => value > 33).length,
  };
}

function mergeRafFrameSlices(slices: RAfFrameSlice[]): RAfFrameSamplingSummary {
  const frameTimes: number[] = [];
  let frameCount = 0;
  for (const slice of slices) {
    frameCount += slice.frameCount;
    frameTimes.push(...slice.frameTimes);
  }
  return summarizeRafFrames(frameTimes, frameCount);
}

function startRafFrameSampler(): { stop: () => Promise<RAfFrameSamplingSummary> } {
  let active = true;
  const frameTimes: number[] = [];
  let frameCount = 0;
  let lastMs: number | null = null;
  let stopPromise: Promise<RAfFrameSamplingSummary> | null = null;

  const loopPromise = (async (): Promise<RAfFrameSamplingSummary> => {
    while (active) {
      await waitForAnimationFrame();
      frameCount += 1;
      const now = performance.now();
      if (lastMs !== null) {
        frameTimes.push(now - lastMs);
      }
      lastMs = now;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    return summarizeRafFrames(frameTimes, frameCount);
  })();

  return {
    stop: () => {
      if (stopPromise) return stopPromise;
      active = false;
      stopPromise = loopPromise;
      return stopPromise;
    },
  };
}

async function pickStrokeCaptureFromFile(): Promise<{
  capture: StrokeCaptureData;
  name: string;
} | null> {
  const picker = (
    window as Window & {
      showOpenFilePicker?: (options?: unknown) => Promise<Array<{ getFile: () => Promise<File> }>>;
    }
  ).showOpenFilePicker;

  let file: File | null = null;

  if (typeof picker === 'function') {
    const handles = await picker({
      types: [{ description: 'Stroke Capture JSON', accept: { 'application/json': ['.json'] } }],
      multiple: false,
      excludeAcceptAllOption: false,
    });
    const first = handles?.[0];
    if (!first) return null;
    file = await first.getFile();
  } else {
    file = await new Promise<File | null>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.oncancel = () => resolve(null);
      input.click();
    });
  }

  if (!file) return null;
  const text = await file.text();
  const parsed = JSON.parse(text) as unknown;
  assertStrokeCaptureData(parsed);
  const capture = parsed;
  return { capture, name: file.name };
}

async function loadFixedPhase6B3Capture(): Promise<Phase6B3CaptureResult | null> {
  try {
    const response = await fetch(PHASE6B3_FIXED_CAPTURE_PATH, { cache: 'no-store' });
    if (response.ok) {
      const parsed = (await response.json()) as unknown;
      assertStrokeCaptureData(parsed);
      return {
        capture: parsed,
        name: PHASE6B3_FIXED_CAPTURE_NAME,
        source: PHASE6B3_FIXED_CAPTURE_PATH,
      };
    }
  } catch {
    // Fall back to local file picker.
  }

  const picked = await pickStrokeCaptureFromFile();
  if (!picked) return null;
  if (picked.name !== PHASE6B3_FIXED_CAPTURE_NAME) {
    throw new Error(`Expected capture file: ${PHASE6B3_FIXED_CAPTURE_NAME}`);
  }

  return {
    capture: picked.capture,
    name: picked.name,
    source: 'file-picker',
  };
}

async function sampleRafFramesDuringReplay<T>(
  replayAction: () => Promise<T>
): Promise<{ result: T; frameSlice: RAfFrameSlice }> {
  let active = true;
  const frameTimes: number[] = [];
  let frameCount = 0;
  let lastMs: number | null = null;

  const loopPromise = (async (): Promise<void> => {
    while (active) {
      await waitForAnimationFrame();
      frameCount += 1;
      const now = performance.now();
      if (lastMs !== null) {
        frameTimes.push(now - lastMs);
      }
      lastMs = now;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  })();

  try {
    const result = await replayAction();
    return { result, frameSlice: { frameTimes, frameCount } };
  } finally {
    active = false;
    await loopPromise;
  }
}

function createEmptyCommitSnapshot(
  mode: GpuBrushCommitReadbackMode
): GpuBrushCommitMetricsSnapshot {
  return {
    attemptCount: 0,
    committedCount: 0,
    avgPrepareMs: 0,
    avgCommitMs: 0,
    avgReadbackMs: 0,
    avgTotalMs: 0,
    maxTotalMs: 0,
    totalDirtyTiles: 0,
    avgDirtyTiles: 0,
    maxDirtyTiles: 0,
    lastCommitAtMs: null,
    readbackMode: mode,
    readbackBypassedCount: 0,
  };
}

function aggregateCommitSnapshots(
  mode: GpuBrushCommitReadbackMode,
  snapshots: Array<GpuBrushCommitMetricsSnapshot | null>
): GpuBrushCommitMetricsSnapshot {
  const valid = snapshots.filter((snapshot): snapshot is GpuBrushCommitMetricsSnapshot =>
    Boolean(snapshot)
  );
  if (valid.length === 0) {
    return createEmptyCommitSnapshot(mode);
  }

  const totalAttempts = valid.reduce((sum, snapshot) => sum + snapshot.attemptCount, 0);
  const weightedAvg = (selector: (snapshot: GpuBrushCommitMetricsSnapshot) => number): number => {
    if (totalAttempts === 0) return 0;
    const weighted = valid.reduce(
      (sum, snapshot) => sum + selector(snapshot) * snapshot.attemptCount,
      0
    );
    return weighted / totalAttempts;
  };

  return {
    attemptCount: totalAttempts,
    committedCount: valid.reduce((sum, snapshot) => sum + snapshot.committedCount, 0),
    avgPrepareMs: weightedAvg((snapshot) => snapshot.avgPrepareMs),
    avgCommitMs: weightedAvg((snapshot) => snapshot.avgCommitMs),
    avgReadbackMs: weightedAvg((snapshot) => snapshot.avgReadbackMs),
    avgTotalMs: weightedAvg((snapshot) => snapshot.avgTotalMs),
    maxTotalMs: valid.reduce((max, snapshot) => Math.max(max, snapshot.maxTotalMs), 0),
    totalDirtyTiles: valid.reduce((sum, snapshot) => sum + snapshot.totalDirtyTiles, 0),
    avgDirtyTiles: weightedAvg((snapshot) => snapshot.avgDirtyTiles),
    maxDirtyTiles: valid.reduce((max, snapshot) => Math.max(max, snapshot.maxDirtyTiles), 0),
    lastCommitAtMs: valid.reduce<number | null>((last, snapshot) => {
      if (snapshot.lastCommitAtMs === null) return last;
      if (last === null) return snapshot.lastCommitAtMs;
      return Math.max(last, snapshot.lastCommitAtMs);
    }, null),
    readbackMode: mode,
    readbackBypassedCount: valid.reduce((sum, snapshot) => sum + snapshot.readbackBypassedCount, 0),
  };
}

function aggregatePhase6B3ModeResults(
  mode: GpuBrushCommitReadbackMode,
  rounds: Phase6B3RoundResult[]
): Phase6B3ModeAggregate {
  return {
    mode,
    rounds: rounds.length,
    replayElapsedMs: rounds.reduce((sum, round) => sum + round.replayElapsedMs, 0),
    clearElapsedMs: rounds.reduce((sum, round) => sum + round.clearElapsedMs, 0),
    frameSummary: mergeRafFrameSlices(rounds.map((round) => round.frameSlice)),
    commitSnapshot: aggregateCommitSnapshots(
      mode,
      rounds.map((round) => round.commitSnapshot)
    ),
    uncapturedErrors: rounds.reduce((sum, round) => sum + round.uncapturedErrors.length, 0),
    deviceLost: rounds.some((round) => round.deviceLost),
  };
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// --- Hooks ---

function useDraggable(initialPosition: { x: number; y: number } | null = null) {
  const [position, setPosition] = useState(initialPosition);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number; panelX: number; panelY: number } | null>(
    null
  );

  const handleDragStart = (e: React.PointerEvent, element: HTMLElement | null) => {
    if (!element) return;
    e.preventDefault();
    isDraggingRef.current = true;
    const rect = element.getBoundingClientRect();
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panelX: rect.left,
      panelY: rect.top,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleDragMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current || !dragStartRef.current) return;
    const deltaX = e.clientX - dragStartRef.current.x;
    const deltaY = e.clientY - dragStartRef.current.y;
    setPosition({
      x: dragStartRef.current.panelX + deltaX,
      y: dragStartRef.current.panelY + deltaY,
    });
  };

  const handleDragEnd = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  };

  return { position, handleDragStart, handleDragMove, handleDragEnd };
}

// --- Sub-components ---

function BenchmarkStatsView({
  stats,
  envInfo,
}: {
  stats: BenchmarkStatsData;
  envInfo: { runtime: string; engine: string };
}) {
  const { latency, fps, lagometer, queueDepth } = stats;

  return (
    <div className="benchmark-stats">
      <StatRow
        label="FPS"
        value={fps.fps.toFixed(1)}
        sub={`(σ: ${fps.frameTimeStdDev.toFixed(2)}ms)`}
      />
      <StatRow
        label="Dropped"
        value={fps.droppedFrames}
        sub={`(max consec: ${fps.consecutiveDrops})`}
      />
      <StatRow label="P99 Frame" value={`${fps.p99FrameTime.toFixed(2)}ms`} />
      <StatRow
        label="Render Latency (Avg)"
        value={`${latency.avgTotalRenderLatency.toFixed(2)}ms`}
      />
      <StatRow label="Render Latency (P99)" value={`${latency.p99RenderLatency.toFixed(2)}ms`} />
      <StatRow label="Input Latency" value={`${latency.avgInputLatency.toFixed(2)}ms`} />

      <div className="stat-row segment-breakdown">
        <span className="stat-label">├ Event→Queue:</span>
        <span className="stat-value">{latency.segments.inputToQueue.toFixed(2)}ms</span>
      </div>
      <div className="stat-row segment-breakdown">
        <span className="stat-label">├ Queue Wait:</span>
        <span className="stat-value">{latency.segments.queueWait.toFixed(2)}ms</span>
        <span className="stat-sub">{latency.segments.queueWait > 5 ? '⚠️' : ''}</span>
      </div>
      <div className="stat-row segment-breakdown">
        <span className="stat-label">├ CPU Encode:</span>
        <span className="stat-value">{latency.segments.cpuEncode.toFixed(2)}ms</span>
      </div>
      <div className="stat-row segment-breakdown">
        <span className="stat-label">└ GPU Execute:</span>
        <span className="stat-value">{latency.segments.gpuExecute.toFixed(2)}ms</span>
      </div>

      <StatRow
        label="Visual Lag (Max)"
        value={`${lagometer.maxLagDistance.toFixed(1)}px`}
        sub={`(${lagometer.lagAsScreenPercent.toFixed(1)}%, ${lagometer.lagAsBrushRadii.toFixed(1)}x)`}
      />
      <div className="stat-row">
        <span className="stat-label">Queue Depth:</span>
        <span className="stat-value">{queueDepth}</span>
        <span className="stat-sub">{queueDepth > 10 ? '⚠️ Backlog' : '✅ OK'}</span>
      </div>

      <div
        className="stat-row"
        style={{ marginTop: '8px', borderTop: '1px solid var(--border-color)', paddingTop: '8px' }}
      >
        <span className="stat-label">Environment:</span>
        <span className="stat-value">{envInfo.runtime}</span>
        <span className="stat-sub">({envInfo.engine})</span>
      </div>
    </div>
  );
}

function StatRow({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: React.ReactNode;
}) {
  return (
    <div className="stat-row">
      <span className="stat-label">{label}:</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

function readDebugRectsFlag(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(window.__gpuBrushDebugRects);
}

function readBatchUnionFlag(): boolean {
  if (typeof window === 'undefined') return true;
  const flag = window.__gpuBrushUseBatchUnionRect;
  return typeof flag === 'boolean' ? flag : true;
}

function ActionGrid({
  onRunTest,
  isRunning,
}: {
  onRunTest: (id: string) => void;
  isRunning: boolean;
}) {
  const actions = [
    { id: 'grid', label: 'Grid 10x10', icon: Grid3X3, title: 'Draw 10x10 grid of taps' },
    { id: 'rapid', label: 'Rapid 100x', icon: Zap, title: '100 rapid random taps' },
    { id: 'chaos', label: 'Chaos 5s', icon: Play, title: '5 seconds of random input' },
    { id: 'latency', label: 'Channel Jitter', icon: Zap, title: 'Rust->Frontend Channel Jitter' },
  ];

  return (
    <div className="debug-button-grid">
      {actions.map((action) => (
        <button
          key={action.id}
          className="debug-btn"
          onClick={() => onRunTest(action.id)}
          disabled={isRunning}
          title={action.title}
        >
          <action.icon size={16} />
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  );
}

// --- Main Component ---

export function DebugPanel({ canvas, onClose }: DebugPanelProps) {
  const isDevBuild = import.meta.env.DEV || import.meta.env.MODE === 'test';
  const [results, setResults] = useState<TestResult[]>([]);
  const [runningTest, setRunningTest] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [expandedResult, setExpandedResult] = useState<number | null>(null);
  const [benchmarkStats, setBenchmarkStats] = useState<BenchmarkStatsData | null>(null);
  const [lastReport, setLastReport] = useState<BenchmarkReport | null>(null);
  const [copiedResultIndex, setCopiedResultIndex] = useState<number | null>(null);
  const [debugRectsEnabled, setDebugRectsEnabled] = useState(readDebugRectsFlag);
  const [batchUnionEnabled, setBatchUnionEnabled] = useState(readBatchUnionFlag);
  const [gpuDiagResetMessage, setGpuDiagResetMessage] = useState<string>('');
  const [noReadbackPilotEnabled, setNoReadbackPilotEnabled] = useState(false);
  const [noReadbackPilotMessage, setNoReadbackPilotMessage] = useState<string>('');
  const [phase6GateCaptureName, setPhase6GateCaptureName] = useState<string>('');
  const [manualGateChecklist, setManualGateChecklist] = useState<ManualGateChecklist>(
    DEFAULT_MANUAL_GATE_CHECKLIST
  );

  const diagnosticsRef = useRef<DiagnosticHooks | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const { position, handleDragStart, handleDragMove, handleDragEnd } = useDraggable();

  // Environment detection
  const envInfo = useMemo(() => {
    const isTauri = '__TAURI_INTERNALS__' in window;
    const ua = navigator.userAgent;
    const isChrome = ua.includes('Chrome/') && !ua.includes('Edg/');
    const isEdge = ua.includes('Edg/');
    const isWebView2 = isTauri && isEdge;

    return {
      runtime: isTauri ? 'Tauri App' : 'Browser',
      engine: isWebView2 ? 'WebView2' : isChrome ? 'Chrome' : isEdge ? 'Edge' : 'Other',
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const bench = window.__benchmark;
      if (bench) {
        setBenchmarkStats({
          latency: bench.latencyProfiler.getStats(),
          fps: bench.fpsCounter.getStats(),
          lagometer: bench.lagometer.getStats(),
          queueDepth: bench.getQueueDepth?.() ?? 0,
        });
      }
    }, 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    diagnosticsRef.current = installDiagnosticHooks();
    return () => diagnosticsRef.current?.cleanup();
  }, []);

  const toggleDebugRects = useCallback(
    function toggleDebugRects(): void {
      const next = !debugRectsEnabled;
      window.__gpuBrushDebugRects = next;
      setDebugRectsEnabled(next);
    },
    [debugRectsEnabled]
  );

  const toggleBatchUnion = useCallback(
    function toggleBatchUnion(): void {
      const next = !batchUnionEnabled;
      window.__gpuBrushUseBatchUnionRect = next;
      setBatchUnionEnabled(next);
    },
    [batchUnionEnabled]
  );

  const resetGpuDiagnostics = useCallback(() => {
    const reset = window.__gpuBrushDiagnosticsReset;
    if (typeof reset !== 'function') {
      setGpuDiagResetMessage('Reset API unavailable');
      return;
    }

    const didReset = reset();
    const snapshot = window.__gpuBrushDiagnostics?.();
    const sessionId =
      snapshot && typeof snapshot === 'object' && 'diagnosticsSessionId' in snapshot
        ? String((snapshot as { diagnosticsSessionId?: unknown }).diagnosticsSessionId ?? '?')
        : '?';

    if (didReset) {
      setGpuDiagResetMessage(`Diagnostics reset OK (session ${sessionId})`);
    } else {
      setGpuDiagResetMessage('GPU not ready, diagnostics not reset');
    }
  }, []);

  const refreshNoReadbackPilotState = useCallback(() => {
    const getter = window.__gpuBrushNoReadbackPilot;
    if (typeof getter === 'function') {
      setNoReadbackPilotEnabled(Boolean(getter()));
      return;
    }
    setNoReadbackPilotEnabled(false);
  }, []);

  useEffect(() => {
    refreshNoReadbackPilotState();
  }, [refreshNoReadbackPilotState]);

  const toggleNoReadbackPilot = useCallback(() => {
    const getter = window.__gpuBrushNoReadbackPilot;
    const setter = window.__gpuBrushNoReadbackPilotSet;
    if (typeof getter !== 'function' || typeof setter !== 'function') {
      setNoReadbackPilotMessage('No-Readback Pilot API unavailable');
      return;
    }

    const next = !getter();
    const ok = setter(next);
    if (!ok) {
      setNoReadbackPilotMessage(`No-Readback Pilot ${next ? 'ON' : 'OFF'} failed`);
      return;
    }

    const current = Boolean(getter());
    setNoReadbackPilotEnabled(current);
    setNoReadbackPilotMessage(`No-Readback Pilot ${current ? 'ON' : 'OFF'}`);
  }, []);

  const addResult = useCallback((name: string, status: TestStatus, report?: string) => {
    setResults((prev) => [{ name, status, report, timestamp: new Date() }, ...prev.slice(0, 9)]);
  }, []);

  const updateManualGateChecklist = useCallback(
    (key: keyof ManualGateChecklist, checked: boolean) => {
      setManualGateChecklist((prev) => ({ ...prev, [key]: checked }));
    },
    []
  );

  const runPhase6AutoGate = useCallback(async () => {
    if (runningTest) return;
    setRunningTest('phase6a:auto');
    setProgress(0);
    addResult('Phase6A Auto Gate', 'running');

    try {
      const replay = window.__strokeCaptureReplay;
      const clearLayer = window.__canvasClearLayer;
      const getDiag = window.__gpuBrushDiagnostics;
      const reset = window.__gpuBrushDiagnosticsReset;
      if (typeof replay !== 'function') {
        throw new Error('Missing API: window.__strokeCaptureReplay');
      }
      if (typeof clearLayer !== 'function') {
        throw new Error('Missing API: window.__canvasClearLayer');
      }
      if (typeof getDiag !== 'function') {
        throw new Error('Missing API: window.__gpuBrushDiagnostics');
      }
      if (typeof reset !== 'function') {
        throw new Error('Missing API: window.__gpuBrushDiagnosticsReset');
      }

      diagnosticsRef.current?.reset();
      const didReset = reset();
      const resetSnapshot = asGpuDiagnosticsSnapshot(getDiag());
      const picked = await pickStrokeCaptureFromFile();
      if (!picked) {
        addResult('Phase6A Auto Gate', 'failed', 'Capture selection cancelled.');
        return;
      }
      setPhase6GateCaptureName(picked.name);

      let clearPerRound = true;
      for (let i = 1; i <= 3; i++) {
        try {
          clearLayer();
        } catch {
          clearPerRound = false;
        }
        await waitForAnimationFrame();
        await replay(picked.capture);
        setProgress(i / 3);
      }

      const finalSnapshot = asGpuDiagnosticsSnapshot(getDiag());
      const sessionId = finalSnapshot.diagnosticsSessionId ?? '?';
      const uncapturedErrors = Array.isArray(finalSnapshot.uncapturedErrors)
        ? finalSnapshot.uncapturedErrors
        : [];
      const deviceLost = Boolean(finalSnapshot.deviceLost);
      const startPressureFallbackCount = diagnosticsRef.current?.startPressureFallbackCount ?? 0;

      const passed = didReset && clearPerRound && uncapturedErrors.length === 0 && !deviceLost;
      const report = [
        `Capture: ${picked.name}`,
        `Reset: ${didReset ? 'OK' : 'FAILED'}`,
        `clearPerRound: ${clearPerRound ? 'YES' : 'NO'}`,
        `Session after reset: ${resetSnapshot.diagnosticsSessionId ?? '?'}`,
        `Session after replay x3: ${sessionId}`,
        `Uncaptured errors: ${uncapturedErrors.length}`,
        `Device lost: ${deviceLost ? 'YES' : 'NO'}`,
        `startPressureFallbackCount: ${startPressureFallbackCount}`,
        `Auto Gate: ${passed ? 'PASS' : 'FAIL'}`,
        '',
        'Next: run 20 pressure strokes manually, then click "Record 20-Stroke Manual Gate".',
      ].join('\n');
      addResult('Phase6A Auto Gate', passed ? 'passed' : 'failed', report);
    } catch (e) {
      addResult('Phase6A Auto Gate', 'failed', String(e));
    } finally {
      setRunningTest(null);
      setProgress(0);
    }
  }, [runningTest, addResult]);

  const runPhase6BPerfGate = useCallback(async () => {
    if (runningTest) return;
    setRunningTest('phase6b:perf');
    setProgress(0);
    addResult('Phase6B Perf Gate (30s)', 'running');

    let stopFrameSampler: (() => Promise<RAfFrameSamplingSummary>) | null = null;

    try {
      const replay = window.__strokeCaptureReplay;
      const clearLayer = window.__canvasClearLayer;
      const getDiag = window.__gpuBrushDiagnostics;
      const resetDiag = window.__gpuBrushDiagnosticsReset;
      const getCommitMetrics = window.__gpuBrushCommitMetrics;
      const resetCommitMetrics = window.__gpuBrushCommitMetricsReset;

      if (typeof replay !== 'function') {
        throw new Error('Missing API: window.__strokeCaptureReplay');
      }
      if (typeof clearLayer !== 'function') {
        throw new Error('Missing API: window.__canvasClearLayer');
      }
      if (typeof getDiag !== 'function') {
        throw new Error('Missing API: window.__gpuBrushDiagnostics');
      }
      if (typeof resetDiag !== 'function') {
        throw new Error('Missing API: window.__gpuBrushDiagnosticsReset');
      }
      if (typeof getCommitMetrics !== 'function') {
        throw new Error('Missing API: window.__gpuBrushCommitMetrics');
      }
      if (typeof resetCommitMetrics !== 'function') {
        throw new Error('Missing API: window.__gpuBrushCommitMetricsReset');
      }

      diagnosticsRef.current?.reset();
      const didResetDiag = resetDiag();
      const didResetCommitMetrics = resetCommitMetrics();
      const resetDiagSnapshot = asGpuDiagnosticsSnapshot(getDiag());

      const picked = await pickStrokeCaptureFromFile();
      if (!picked) {
        addResult('Phase6B Perf Gate (30s)', 'failed', 'Capture selection cancelled.');
        return;
      }
      setPhase6GateCaptureName(picked.name);

      const sampler = startRafFrameSampler();
      stopFrameSampler = sampler.stop;

      const gateStartMs = performance.now();
      let elapsedMs = 0;
      let rounds = 0;
      let clearPerRound = true;

      while (elapsedMs < PHASE6B_TARGET_DURATION_MS) {
        rounds += 1;
        try {
          clearLayer();
        } catch {
          clearPerRound = false;
        }

        await waitForAnimationFrame();
        await replay(picked.capture);

        elapsedMs = performance.now() - gateStartMs;
        setProgress(Math.min(elapsedMs / PHASE6B_TARGET_DURATION_MS, 1));
      }

      const frameSummary = await sampler.stop();
      stopFrameSampler = null;
      const finalSnapshot = asGpuDiagnosticsSnapshot(getDiag());
      const commitSnapshot = asGpuBrushCommitMetricsSnapshot(getCommitMetrics());
      const uncapturedErrors = Array.isArray(finalSnapshot.uncapturedErrors)
        ? finalSnapshot.uncapturedErrors
        : [];
      const deviceLost = Boolean(finalSnapshot.deviceLost);
      const committedCount = commitSnapshot?.committedCount ?? 0;
      const hasFrameSamples = frameSummary.sampleCount > 0;

      const passed =
        didResetDiag &&
        didResetCommitMetrics &&
        clearPerRound &&
        uncapturedErrors.length === 0 &&
        !deviceLost &&
        committedCount > 0 &&
        hasFrameSamples;

      const report = [
        `Capture: ${picked.name}`,
        `Duration target: ${PHASE6B_TARGET_DURATION_MS}ms`,
        `Duration actual: ${Math.round(elapsedMs)}ms`,
        `Rounds: ${rounds}`,
        `Reset diagnostics: ${didResetDiag ? 'OK' : 'FAILED'}`,
        `Reset commit metrics: ${didResetCommitMetrics ? 'OK' : 'FAILED'}`,
        `clearPerRound: ${clearPerRound ? 'YES' : 'NO'}`,
        `Diag session after reset: ${resetDiagSnapshot.diagnosticsSessionId ?? '?'}`,
        `Diag session after run: ${finalSnapshot.diagnosticsSessionId ?? '?'}`,
        `Uncaptured errors: ${uncapturedErrors.length}`,
        `Device lost: ${deviceLost ? 'YES' : 'NO'}`,
        '',
        `Frame samples: ${frameSummary.sampleCount}`,
        `Frame avg: ${frameSummary.avgMs.toFixed(2)}ms`,
        `Frame p95: ${frameSummary.p95Ms.toFixed(2)}ms`,
        `Frame p99: ${frameSummary.p99Ms.toFixed(2)}ms`,
        `Frame dropped(>33ms): ${frameSummary.droppedFrames}`,
        '',
        `Commit attempts: ${commitSnapshot?.attemptCount ?? 0}`,
        `Commit committed: ${commitSnapshot?.committedCount ?? 0}`,
        `Commit avg prepare: ${(commitSnapshot?.avgPrepareMs ?? 0).toFixed(2)}ms`,
        `Commit avg gpu: ${(commitSnapshot?.avgCommitMs ?? 0).toFixed(2)}ms`,
        `Commit avg readback: ${(commitSnapshot?.avgReadbackMs ?? 0).toFixed(2)}ms`,
        `Commit avg total: ${(commitSnapshot?.avgTotalMs ?? 0).toFixed(2)}ms`,
        `Commit max total: ${(commitSnapshot?.maxTotalMs ?? 0).toFixed(2)}ms`,
        `Commit total dirtyTiles: ${commitSnapshot?.totalDirtyTiles ?? 0}`,
        `Commit avg dirtyTiles: ${(commitSnapshot?.avgDirtyTiles ?? 0).toFixed(2)}`,
        `Commit max dirtyTiles: ${commitSnapshot?.maxDirtyTiles ?? 0}`,
        `Commit lastAtMs: ${commitSnapshot?.lastCommitAtMs ?? 'N/A'}`,
        '',
        `Phase6B Gate: ${passed ? 'PASS' : 'FAIL'}`,
        'Note: 6A 临时豁免期间，性能结论为非封版预结论。',
      ].join('\n');

      addResult('Phase6B Perf Gate (30s)', passed ? 'passed' : 'failed', report);
    } catch (e) {
      addResult('Phase6B Perf Gate (30s)', 'failed', String(e));
    } finally {
      if (stopFrameSampler) {
        try {
          await stopFrameSampler();
        } catch {
          // Ignore cleanup errors from sampler.
        }
      }
      setRunningTest(null);
      setProgress(0);
    }
  }, [runningTest, addResult]);

  const runPhase6B3ReadbackCompare = useCallback(async () => {
    if (runningTest) return;
    setRunningTest('phase6b3:ab-compare');
    setProgress(0);
    addResult('Phase6B-3 Readback A/B Compare', 'running');

    let originalReadbackMode: GpuBrushCommitReadbackMode | null = null;

    try {
      const replay = window.__strokeCaptureReplay;
      const clearLayer = window.__canvasClearLayer;
      const getDiag = window.__gpuBrushDiagnostics;
      const resetDiag = window.__gpuBrushDiagnosticsReset;
      const getCommitMetrics = window.__gpuBrushCommitMetrics;
      const resetCommitMetrics = window.__gpuBrushCommitMetricsReset;
      const getReadbackMode = window.__gpuBrushCommitReadbackMode;
      const setReadbackMode = window.__gpuBrushCommitReadbackModeSet;

      if (typeof replay !== 'function') {
        throw new Error('Missing API: window.__strokeCaptureReplay');
      }
      if (typeof clearLayer !== 'function') {
        throw new Error('Missing API: window.__canvasClearLayer');
      }
      if (typeof getDiag !== 'function') {
        throw new Error('Missing API: window.__gpuBrushDiagnostics');
      }
      if (typeof resetDiag !== 'function') {
        throw new Error('Missing API: window.__gpuBrushDiagnosticsReset');
      }
      if (typeof getCommitMetrics !== 'function') {
        throw new Error('Missing API: window.__gpuBrushCommitMetrics');
      }
      if (typeof resetCommitMetrics !== 'function') {
        throw new Error('Missing API: window.__gpuBrushCommitMetricsReset');
      }
      if (typeof getReadbackMode !== 'function') {
        throw new Error('Missing API: window.__gpuBrushCommitReadbackMode');
      }
      if (typeof setReadbackMode !== 'function') {
        throw new Error('Missing API: window.__gpuBrushCommitReadbackModeSet');
      }

      const captureResult = await loadFixedPhase6B3Capture();
      if (!captureResult) {
        addResult('Phase6B-3 Readback A/B Compare', 'failed', 'Capture selection cancelled.');
        return;
      }
      setPhase6GateCaptureName(captureResult.name);

      const currentMode = getReadbackMode();
      if (!isGpuBrushCommitReadbackMode(currentMode)) {
        throw new Error(`Invalid readback mode from API: ${String(currentMode)}`);
      }
      originalReadbackMode = currentMode;

      const roundResults: Phase6B3RoundResult[] = [];

      for (let i = 0; i < PHASE6B3_READBACK_SEQUENCE.length; i += 1) {
        const mode = PHASE6B3_READBACK_SEQUENCE[i]!;
        const setOk = setReadbackMode(mode);
        const modeAfterSet = getReadbackMode();
        if (!setOk || modeAfterSet !== mode) {
          throw new Error(`Failed to switch readback mode to ${mode}`);
        }

        diagnosticsRef.current?.reset();
        const didResetDiag = resetDiag();
        const didResetCommitMetrics = resetCommitMetrics();
        const resetDiagSnapshot = asGpuDiagnosticsSnapshot(getDiag());

        let replayElapsedMs = 0;
        let clearElapsedMs = 0;
        let replayCount = 0;
        let clearPerRound = true;
        const frameSlices: RAfFrameSlice[] = [];

        while (replayElapsedMs < PHASE6B_TARGET_DURATION_MS) {
          const clearStart = performance.now();
          try {
            clearLayer();
          } catch {
            clearPerRound = false;
          }
          await waitForAnimationFrame();
          clearElapsedMs += performance.now() - clearStart;

          const { result: replayDurationMs, frameSlice } = await sampleRafFramesDuringReplay(
            async () => {
              const replayStart = performance.now();
              await replay(captureResult.capture);
              return performance.now() - replayStart;
            }
          );
          replayElapsedMs += replayDurationMs;
          replayCount += 1;
          frameSlices.push(frameSlice);

          const roundProgress =
            (i + Math.min(replayElapsedMs / PHASE6B_TARGET_DURATION_MS, 1)) /
            PHASE6B3_READBACK_SEQUENCE.length;
          setProgress(roundProgress);
        }

        const frameSummary = mergeRafFrameSlices(frameSlices);
        const finalSnapshot = asGpuDiagnosticsSnapshot(getDiag());
        const commitSnapshot = asGpuBrushCommitMetricsSnapshot(getCommitMetrics());
        const uncapturedErrors = Array.isArray(finalSnapshot.uncapturedErrors)
          ? finalSnapshot.uncapturedErrors
          : [];
        const deviceLost = Boolean(finalSnapshot.deviceLost);
        const committedCount = commitSnapshot?.committedCount ?? 0;
        const hasFrameSamples = frameSummary.sampleCount > 0;
        const commitMode = commitSnapshot?.readbackMode ?? mode;
        const passed =
          didResetDiag &&
          didResetCommitMetrics &&
          clearPerRound &&
          uncapturedErrors.length === 0 &&
          !deviceLost &&
          committedCount > 0 &&
          hasFrameSamples &&
          commitMode === mode;

        roundResults.push({
          mode,
          sequenceIndex: i + 1,
          didResetDiag,
          didResetCommitMetrics,
          clearPerRound,
          replayCount,
          replayElapsedMs,
          clearElapsedMs,
          frameSlice: {
            frameTimes: frameSlices.flatMap((slice) => slice.frameTimes),
            frameCount: frameSlices.reduce((sum, slice) => sum + slice.frameCount, 0),
          },
          commitSnapshot,
          uncapturedErrors,
          deviceLost,
          sessionAfterReset: resetDiagSnapshot.diagnosticsSessionId ?? '?',
          sessionAfterRun: finalSnapshot.diagnosticsSessionId ?? '?',
          passed,
        });
      }

      const enabledRounds = roundResults.filter((round) => round.mode === 'enabled');
      const disabledRounds = roundResults.filter((round) => round.mode === 'disabled');
      const enabledAggregate = aggregatePhase6B3ModeResults('enabled', enabledRounds);
      const disabledAggregate = aggregatePhase6B3ModeResults('disabled', disabledRounds);

      const deltaReadbackMs =
        disabledAggregate.commitSnapshot.avgReadbackMs -
        enabledAggregate.commitSnapshot.avgReadbackMs;
      const deltaTotalMs =
        disabledAggregate.commitSnapshot.avgTotalMs - enabledAggregate.commitSnapshot.avgTotalMs;
      const deltaFrameP95Ms =
        disabledAggregate.frameSummary.p95Ms - enabledAggregate.frameSummary.p95Ms;
      const deltaFrameP99Ms =
        disabledAggregate.frameSummary.p99Ms - enabledAggregate.frameSummary.p99Ms;
      const deltaDirtyTiles =
        disabledAggregate.commitSnapshot.avgDirtyTiles -
        enabledAggregate.commitSnapshot.avgDirtyTiles;

      const modeRestored =
        originalReadbackMode !== null &&
        setReadbackMode(originalReadbackMode) &&
        getReadbackMode() === originalReadbackMode;

      const passed =
        modeRestored &&
        roundResults.length === PHASE6B3_READBACK_SEQUENCE.length &&
        roundResults.every((round) => round.passed);

      const roundDetails = roundResults
        .map((round) => {
          const commit = round.commitSnapshot;
          return [
            `Round ${round.sequenceIndex} [${round.mode}]`,
            `  replayDuration: ${Math.round(round.replayElapsedMs)}ms`,
            `  clearDuration: ${Math.round(round.clearElapsedMs)}ms`,
            `  replayLoops: ${round.replayCount}`,
            `  frame p95/p99: ${mergeRafFrameSlices([round.frameSlice]).p95Ms.toFixed(2)}ms / ${mergeRafFrameSlices([round.frameSlice]).p99Ms.toFixed(2)}ms`,
            `  commit avg readback/total: ${(commit?.avgReadbackMs ?? 0).toFixed(2)}ms / ${(commit?.avgTotalMs ?? 0).toFixed(2)}ms`,
            `  commit avg dirtyTiles: ${(commit?.avgDirtyTiles ?? 0).toFixed(2)}`,
            `  bypassed readback: ${commit?.readbackBypassedCount ?? 0}`,
            `  uncapturedErrors: ${round.uncapturedErrors.length}, deviceLost: ${round.deviceLost ? 'YES' : 'NO'}`,
            `  reset(diag/metrics): ${round.didResetDiag ? 'OK' : 'FAILED'}/${round.didResetCommitMetrics ? 'OK' : 'FAILED'}`,
            `  clearPerRound: ${round.clearPerRound ? 'YES' : 'NO'}`,
            `  diag session reset->run: ${round.sessionAfterReset} -> ${round.sessionAfterRun}`,
            `  roundStatus: ${round.passed ? 'PASS' : 'FAIL'}`,
          ].join('\n');
        })
        .join('\n\n');

      const report = [
        `Capture: ${captureResult.name}`,
        `Capture source: ${captureResult.source}`,
        `Target replay-only duration per mode: ${PHASE6B_TARGET_DURATION_MS}ms`,
        `Sequence: ${PHASE6B3_READBACK_SEQUENCE.join(' -> ')}`,
        '',
        'Per-round details:',
        roundDetails,
        '',
        'Mode aggregate (enabled / A):',
        `  rounds: ${enabledAggregate.rounds}`,
        `  replayDuration: ${Math.round(enabledAggregate.replayElapsedMs)}ms`,
        `  clearDuration: ${Math.round(enabledAggregate.clearElapsedMs)}ms`,
        `  frame avg/p95/p99: ${enabledAggregate.frameSummary.avgMs.toFixed(2)} / ${enabledAggregate.frameSummary.p95Ms.toFixed(2)} / ${enabledAggregate.frameSummary.p99Ms.toFixed(2)}ms`,
        `  commit avg readback/total: ${enabledAggregate.commitSnapshot.avgReadbackMs.toFixed(2)} / ${enabledAggregate.commitSnapshot.avgTotalMs.toFixed(2)}ms`,
        `  commit avg dirtyTiles: ${enabledAggregate.commitSnapshot.avgDirtyTiles.toFixed(2)}`,
        `  readback bypassed count: ${enabledAggregate.commitSnapshot.readbackBypassedCount}`,
        `  stability: uncapturedErrors=${enabledAggregate.uncapturedErrors}, deviceLost=${enabledAggregate.deviceLost ? 'YES' : 'NO'}`,
        '',
        'Mode aggregate (disabled / B):',
        `  rounds: ${disabledAggregate.rounds}`,
        `  replayDuration: ${Math.round(disabledAggregate.replayElapsedMs)}ms`,
        `  clearDuration: ${Math.round(disabledAggregate.clearElapsedMs)}ms`,
        `  frame avg/p95/p99: ${disabledAggregate.frameSummary.avgMs.toFixed(2)} / ${disabledAggregate.frameSummary.p95Ms.toFixed(2)} / ${disabledAggregate.frameSummary.p99Ms.toFixed(2)}ms`,
        `  commit avg readback/total: ${disabledAggregate.commitSnapshot.avgReadbackMs.toFixed(2)} / ${disabledAggregate.commitSnapshot.avgTotalMs.toFixed(2)}ms`,
        `  commit avg dirtyTiles: ${disabledAggregate.commitSnapshot.avgDirtyTiles.toFixed(2)}`,
        `  readback bypassed count: ${disabledAggregate.commitSnapshot.readbackBypassedCount}`,
        `  stability: uncapturedErrors=${disabledAggregate.uncapturedErrors}, deviceLost=${disabledAggregate.deviceLost ? 'YES' : 'NO'}`,
        '',
        'Delta (B - A):',
        `  commit avg readback: ${deltaReadbackMs.toFixed(2)}ms`,
        `  commit avg total: ${deltaTotalMs.toFixed(2)}ms`,
        `  frame p95: ${deltaFrameP95Ms.toFixed(2)}ms`,
        `  frame p99: ${deltaFrameP99Ms.toFixed(2)}ms`,
        `  commit avg dirtyTiles: ${deltaDirtyTiles.toFixed(2)}`,
        `  mode restored: ${modeRestored ? 'YES' : 'NO'}`,
        '',
        `Phase6B-3 Compare: ${passed ? 'PASS' : 'FAIL'}`,
        'Note: Report is comparison-only (no hard perf threshold), and remains non-release evidence under 6A waiver.',
      ].join('\n');

      addResult('Phase6B-3 Readback A/B Compare', passed ? 'passed' : 'failed', report);
    } catch (e) {
      addResult('Phase6B-3 Readback A/B Compare', 'failed', String(e));
    } finally {
      if (originalReadbackMode) {
        try {
          window.__gpuBrushCommitReadbackModeSet?.(originalReadbackMode);
        } catch {
          // Ignore best-effort restore failure.
        }
      }
      refreshNoReadbackPilotState();
      setRunningTest(null);
      setProgress(0);
    }
  }, [runningTest, addResult, refreshNoReadbackPilotState]);

  const runNoReadbackPilotGate = useCallback(async () => {
    if (runningTest) return;
    setRunningTest('pilot:no-readback-gate');
    setProgress(0);
    addResult('No-Readback Pilot Gate (30s)', 'running');

    let originalPilotEnabled: boolean | null = null;

    try {
      const replay = window.__strokeCaptureReplay;
      const clearLayer = window.__canvasClearLayer;
      const getDiag = window.__gpuBrushDiagnostics;
      const resetDiag = window.__gpuBrushDiagnosticsReset;
      const getCommitMetrics = window.__gpuBrushCommitMetrics;
      const resetCommitMetrics = window.__gpuBrushCommitMetricsReset;
      const getReadbackMode = window.__gpuBrushCommitReadbackMode;
      const getPilot = window.__gpuBrushNoReadbackPilot;
      const setPilot = window.__gpuBrushNoReadbackPilotSet;

      if (typeof replay !== 'function') {
        throw new Error('Missing API: window.__strokeCaptureReplay');
      }
      if (typeof clearLayer !== 'function') {
        throw new Error('Missing API: window.__canvasClearLayer');
      }
      if (typeof getDiag !== 'function') {
        throw new Error('Missing API: window.__gpuBrushDiagnostics');
      }
      if (typeof resetDiag !== 'function') {
        throw new Error('Missing API: window.__gpuBrushDiagnosticsReset');
      }
      if (typeof getCommitMetrics !== 'function') {
        throw new Error('Missing API: window.__gpuBrushCommitMetrics');
      }
      if (typeof resetCommitMetrics !== 'function') {
        throw new Error('Missing API: window.__gpuBrushCommitMetricsReset');
      }
      if (typeof getReadbackMode !== 'function') {
        throw new Error('Missing API: window.__gpuBrushCommitReadbackMode');
      }
      if (typeof getPilot !== 'function') {
        throw new Error('Missing API: window.__gpuBrushNoReadbackPilot');
      }
      if (typeof setPilot !== 'function') {
        throw new Error('Missing API: window.__gpuBrushNoReadbackPilotSet');
      }

      const captureResult = await loadFixedPhase6B3Capture();
      if (!captureResult) {
        addResult('No-Readback Pilot Gate (30s)', 'failed', 'Capture selection cancelled.');
        return;
      }
      setPhase6GateCaptureName(captureResult.name);

      originalPilotEnabled = Boolean(getPilot());
      const didEnablePilot = setPilot(true) && Boolean(getPilot());
      if (!didEnablePilot) {
        throw new Error('Failed to enable No-Readback Pilot');
      }
      setNoReadbackPilotEnabled(true);
      setNoReadbackPilotMessage('No-Readback Pilot ON');

      diagnosticsRef.current?.reset();
      const didResetDiag = resetDiag();
      const didResetCommitMetrics = resetCommitMetrics();
      const resetDiagSnapshot = asGpuDiagnosticsSnapshot(getDiag());

      let replayElapsedMs = 0;
      let clearElapsedMs = 0;
      let replayCount = 0;
      let clearPerRound = true;
      const frameSlices: RAfFrameSlice[] = [];

      while (replayElapsedMs < PHASE6B_TARGET_DURATION_MS) {
        const clearStart = performance.now();
        try {
          clearLayer();
        } catch {
          clearPerRound = false;
        }
        await waitForAnimationFrame();
        clearElapsedMs += performance.now() - clearStart;

        const { result: replayDurationMs, frameSlice } = await sampleRafFramesDuringReplay(
          async () => {
            const replayStart = performance.now();
            await replay(captureResult.capture);
            return performance.now() - replayStart;
          }
        );
        replayElapsedMs += replayDurationMs;
        replayCount += 1;
        frameSlices.push(frameSlice);

        setProgress(Math.min(replayElapsedMs / PHASE6B_TARGET_DURATION_MS, 1));
      }

      const frameSummary = mergeRafFrameSlices(frameSlices);
      const finalSnapshot = asGpuDiagnosticsSnapshot(getDiag());
      const commitSnapshot = asGpuBrushCommitMetricsSnapshot(getCommitMetrics());
      const uncapturedErrors = Array.isArray(finalSnapshot.uncapturedErrors)
        ? finalSnapshot.uncapturedErrors
        : [];
      const deviceLost = Boolean(finalSnapshot.deviceLost);
      const committedCount = commitSnapshot?.committedCount ?? 0;
      const hasFrameSamples = frameSummary.sampleCount > 0;
      const readbackMode = commitSnapshot?.readbackMode ?? 'enabled';
      const readbackNearZero =
        (commitSnapshot?.avgReadbackMs ?? Number.POSITIVE_INFINITY) <= PILOT_READBACK_NEAR_ZERO_MS;
      const readbackBypassedCount = commitSnapshot?.readbackBypassedCount ?? 0;
      const avgTotalMs = commitSnapshot?.avgTotalMs ?? 0;
      const totalDeltaVsBaselineMs = avgTotalMs - PILOT_BASELINE_A_TOTAL_MS;
      const totalImprovedVsBaseline = totalDeltaVsBaselineMs < 0;

      const pilotRestored =
        setPilot(originalPilotEnabled) && Boolean(getPilot()) === originalPilotEnabled;
      setNoReadbackPilotEnabled(Boolean(getPilot()));

      const passed =
        didResetDiag &&
        didResetCommitMetrics &&
        clearPerRound &&
        uncapturedErrors.length === 0 &&
        !deviceLost &&
        committedCount > 0 &&
        hasFrameSamples &&
        readbackMode === 'disabled' &&
        readbackNearZero &&
        readbackBypassedCount > 0 &&
        totalImprovedVsBaseline &&
        pilotRestored;

      const report = [
        `Capture: ${captureResult.name}`,
        `Capture source: ${captureResult.source}`,
        `Target replay-only duration: ${PHASE6B_TARGET_DURATION_MS}ms`,
        `Replay duration: ${Math.round(replayElapsedMs)}ms`,
        `Clear duration (excluded): ${Math.round(clearElapsedMs)}ms`,
        `Replay loops: ${replayCount}`,
        '',
        `Reset diagnostics/metrics: ${didResetDiag ? 'OK' : 'FAILED'}/${didResetCommitMetrics ? 'OK' : 'FAILED'}`,
        `clearPerRound: ${clearPerRound ? 'YES' : 'NO'}`,
        `Diag session reset->run: ${resetDiagSnapshot.diagnosticsSessionId ?? '?'} -> ${finalSnapshot.diagnosticsSessionId ?? '?'}`,
        `Stability: uncapturedErrors=${uncapturedErrors.length}, deviceLost=${deviceLost ? 'YES' : 'NO'}`,
        '',
        `Frame avg/p95/p99: ${frameSummary.avgMs.toFixed(2)} / ${frameSummary.p95Ms.toFixed(2)} / ${frameSummary.p99Ms.toFixed(2)}ms`,
        `Commit attempts/committed: ${commitSnapshot?.attemptCount ?? 0} / ${committedCount}`,
        `Commit avg readback/total: ${(commitSnapshot?.avgReadbackMs ?? 0).toFixed(2)} / ${avgTotalMs.toFixed(2)}ms`,
        `Commit avg dirtyTiles: ${(commitSnapshot?.avgDirtyTiles ?? 0).toFixed(2)}`,
        `Readback bypassed count: ${readbackBypassedCount}`,
        `Commit readback mode: ${readbackMode}`,
        '',
        `Pilot acceptance (near-zero readback <= ${PILOT_READBACK_NEAR_ZERO_MS}ms): ${readbackNearZero ? 'YES' : 'NO'}`,
        `Pilot acceptance (avg total improved vs baseline ${PILOT_BASELINE_A_TOTAL_MS.toFixed(2)}ms): ${totalImprovedVsBaseline ? 'YES' : 'NO'}`,
        `Delta avg total vs baseline A: ${totalDeltaVsBaselineMs.toFixed(2)}ms`,
        `Pilot restored: ${pilotRestored ? 'YES' : 'NO'}`,
        '',
        `No-Readback Pilot Gate: ${passed ? 'PASS' : 'FAIL'}`,
        'Note: Pilot result remains non-release evidence under 6A waiver.',
      ].join('\n');

      addResult('No-Readback Pilot Gate (30s)', passed ? 'passed' : 'failed', report);
    } catch (e) {
      addResult('No-Readback Pilot Gate (30s)', 'failed', String(e));
    } finally {
      if (originalPilotEnabled !== null) {
        try {
          window.__gpuBrushNoReadbackPilotSet?.(originalPilotEnabled);
        } catch {
          // Ignore best-effort restore failure.
        }
      }
      refreshNoReadbackPilotState();
      setRunningTest(null);
      setProgress(0);
    }
  }, [runningTest, addResult, refreshNoReadbackPilotState]);

  const recordPhase6ManualGate = useCallback(() => {
    const getDiag = window.__gpuBrushDiagnostics;
    if (typeof getDiag !== 'function') {
      addResult('Phase6A Manual 20-Stroke', 'failed', 'Missing API: window.__gpuBrushDiagnostics');
      return;
    }

    const snapshot = asGpuDiagnosticsSnapshot(getDiag());
    const uncapturedErrors = Array.isArray(snapshot.uncapturedErrors)
      ? snapshot.uncapturedErrors
      : [];
    const deviceLost = Boolean(snapshot.deviceLost);
    const manualChecklist = {
      noThinStart: manualGateChecklist.noThinStart,
      noMissingOrDisappear: manualGateChecklist.noMissingOrDisappear,
      noTailDab: manualGateChecklist.noTailDab,
    };
    const checklistPass =
      manualChecklist.noThinStart &&
      manualChecklist.noMissingOrDisappear &&
      manualChecklist.noTailDab;
    const startPressureFallbackCount = diagnosticsRef.current?.startPressureFallbackCount ?? 0;
    const passed = checklistPass && uncapturedErrors.length === 0 && !deviceLost;
    const report = [
      `Capture used: ${phase6GateCaptureName || 'N/A'}`,
      `Session: ${snapshot.diagnosticsSessionId ?? '?'}`,
      `Uncaptured errors: ${uncapturedErrors.length}`,
      `Device lost: ${deviceLost ? 'YES' : 'NO'}`,
      `startPressureFallbackCount: ${startPressureFallbackCount}`,
      `manualChecklist: ${JSON.stringify(manualChecklist)}`,
      `Manual Gate: ${passed ? 'PASS' : 'FAIL'}`,
    ].join('\n');
    addResult('Phase6A Manual 20-Stroke', passed ? 'passed' : 'failed', report);
  }, [addResult, phase6GateCaptureName, manualGateChecklist]);

  // --- Test Runners ---

  const runTestWrapper = useCallback(
    async (
      testId: string,
      testName: string,
      testFn: () => Promise<{ passed: boolean; report: string }>
    ) => {
      if (!canvas || runningTest) return;

      setRunningTest(testId);
      setProgress(0);
      addResult(testName, 'running');
      diagnosticsRef.current?.reset();

      try {
        const { passed, report } = await testFn();
        const telemetry = diagnosticsRef.current ? getTestReport(diagnosticsRef.current) : '';
        const fullReport = report + (telemetry ? '\n\n' + telemetry : '');
        addResult(testName, passed ? 'passed' : 'failed', fullReport);
      } catch (e) {
        addResult(testName, 'failed', String(e));
      } finally {
        setRunningTest(null);
        setProgress(0);
      }
    },
    [canvas, runningTest, addResult]
  );

  const handleRunTest = useCallback(
    (id: string) => {
      switch (id) {
        case 'grid':
          runTestWrapper('grid', 'Grid Test (10x10)', async () => {
            const simulator = new InputSimulator(canvas!);
            const points = await simulator.drawGrid(10, 10, 30, {
              startX: 50,
              startY: 50,
              intervalMs: 20,
            });
            await new Promise((r) => setTimeout(r, 500));
            const result = await verifyGrid(canvas!, points);
            return { passed: result.passed, report: formatVerificationReport(result) };
          });
          break;
        case 'rapid':
          runTestWrapper('rapid', 'Rapid Taps (100x)', async () => {
            const simulator = new InputSimulator(canvas!);
            const points = await simulator.rapidTaps(
              100,
              { x: 50, y: 50, width: canvas!.width - 100, height: canvas!.height - 100 },
              5
            );
            await new Promise((r) => setTimeout(r, 500));
            const result = await verifyGrid(canvas!, points, { sampleRadius: 5 });
            return {
              passed: result.passed,
              report: `Taps: ${points.length}\n${formatVerificationReport(result)}`,
            };
          });
          break;
        case 'chaos':
          runTestWrapper('chaos', 'Chaos Test (5s)', async () => {
            const result: ChaosTestResult = await chaosMixed(canvas!, {
              duration: 5000,
              strokeProbability: 0.3,
              onProgress: setProgress,
            });
            return { passed: result.errors === 0, report: formatChaosReport(result) };
          });
          break;
        case 'latency': {
          const title = 'Rust Channel Latency (2s)';

          runTestWrapper(id, title, async () => {
            const result = await runLatencyBenchmark(240, 2000);
            return {
              passed: result.avgJitter < 1.0,
              report: `Freq: 240Hz, Duration: ${result.duration}ms\nMsgs Recv: ${result.msgCount}\nAvg Jitter: ${result.avgJitter.toFixed(3)}ms\nMax Jitter: ${result.maxJitter.toFixed(3)}ms\nStatus: ${result.avgJitter < 1.0 ? 'PASS' : 'FAIL(<1.0ms)'}`,
            };
          });
          break;
        }
      }
    },
    [canvas, runTestWrapper]
  );

  const runFullBenchmark = useCallback(async () => {
    if (!canvas || runningTest) return;

    setRunningTest('benchmark');
    setProgress(0);
    addResult('Benchmark Suite', 'running');

    const bench = window.__benchmark;
    if (!bench) {
      addResult('Benchmark Suite', 'failed', 'Benchmark not initialized');
      setRunningTest(null);
      return;
    }

    try {
      const runner = new BenchmarkRunner(canvas);
      runner.setProgressCallback((p, name) => {
        setProgress(p);
        if (name !== 'Complete') setRunningTest(`benchmark: ${name}`);
      });

      const report = await runner.runScenarios(DEFAULT_SCENARIOS, {
        latencyProfiler: bench.latencyProfiler as LatencyProfiler,
        fpsCounter: bench.fpsCounter as FPSCounter,
        lagometer: bench.lagometer as LagometerMonitor,
      });

      setLastReport(report);
      const summary = `Avg FPS: ${report.summary.avgFps.toFixed(1)}\nAvg Latency: ${report.summary.avgRenderLatency.toFixed(2)}ms\nMax Lag: ${report.summary.maxVisualLag.toFixed(1)}px`;
      addResult('Benchmark Suite', 'passed', summary);
    } catch (e) {
      addResult('Benchmark Suite', 'failed', String(e));
    } finally {
      setRunningTest(null);
      setProgress(0);
    }
  }, [canvas, runningTest, addResult]);

  const clearCanvas = useCallback(() => {
    if (!canvas) return;
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    diagnosticsRef.current?.reset();
    window.__benchmark?.latencyProfiler.reset();
    window.__benchmark?.lagometer.reset();
  }, [canvas]);

  const exportReport = useCallback(() => {
    if (lastReport) {
      downloadBenchmarkReport(lastReport);
    } else if (results.length > 0) {
      const content = results
        .map((r) => `[${r.timestamp.toISOString()}] ${r.name}: ${r.status}\n${r.report || ''}`)
        .join('\n\n---\n\n');
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `debug-report-${Date.now()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [lastReport, results]);

  const copyResultReport = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>, index: number, result: TestResult) => {
      event.stopPropagation();
      if (!result.report) return;

      const content = `[${result.timestamp.toISOString()}] ${result.name}: ${result.status}\n${result.report}`;
      const copied = await copyTextToClipboard(content);
      if (!copied) return;

      setCopiedResultIndex(index);
      window.setTimeout(() => {
        setCopiedResultIndex((current) => (current === index ? null : current));
      }, 2000);
    },
    []
  );

  return (
    <div
      className="debug-panel"
      ref={panelRef}
      style={position ? { left: position.x, top: position.y, right: 'auto' } : {}}
    >
      <div
        className="debug-panel-header"
        onPointerDown={(e) => handleDragStart(e, panelRef.current)}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
      >
        <div className="debug-panel-title">
          <Bug size={18} />
          <span>Debug Panel</span>
        </div>
        <button className="debug-close-btn" onClick={onClose} title="Close (Shift+Ctrl+D)">
          <X size={16} />
        </button>
      </div>

      <div className="debug-panel-content">
        <div className="debug-section">
          <h3>Stroke Tests</h3>
          <ActionGrid onRunTest={handleRunTest} isRunning={!!runningTest} />
        </div>

        <div className="debug-section">
          <h3>GPU Brush</h3>
          <div className="debug-button-row">
            <button
              className={`debug-btn secondary ${debugRectsEnabled ? 'active' : ''}`}
              onClick={toggleDebugRects}
              title="window.__gpuBrushDebugRects"
            >
              <span>Debug Rects</span>
            </button>
            <button
              className={`debug-btn secondary ${batchUnionEnabled ? 'active' : ''}`}
              onClick={toggleBatchUnion}
              title="window.__gpuBrushUseBatchUnionRect"
            >
              <span>Batch-Union Preview</span>
            </button>
          </div>
          {isDevBuild && (
            <div className="debug-button-row" style={{ marginTop: '8px' }}>
              <button
                className="debug-btn secondary"
                onClick={resetGpuDiagnostics}
                title="Reset GPU diagnostics counters/session only (no render state changes)"
              >
                <span>Reset GPU Diag</span>
              </button>
            </div>
          )}
          <div className="debug-button-row" style={{ marginTop: '8px' }}>
            <button
              className="debug-btn secondary"
              onClick={runPhase6AutoGate}
              disabled={!!runningTest}
              title="Reset diagnostics, replay selected case 3 times, and auto-check uncaptured errors"
            >
              <span>Run Phase6A Auto Gate</span>
            </button>
          </div>
          <div className="debug-button-row" style={{ marginTop: '8px' }}>
            <button
              className="debug-btn secondary"
              onClick={runPhase6BPerfGate}
              disabled={!!runningTest}
              title="Run 30s replay-based perf gate with frame + commit + diagnostics report"
            >
              <span>Run Phase6B Perf Gate (30s)</span>
            </button>
          </div>
          <div className="debug-button-row" style={{ marginTop: '8px' }}>
            <button
              className="debug-btn secondary"
              onClick={runPhase6B3ReadbackCompare}
              disabled={!!runningTest}
              title="Run fixed case-5000-04 readback A/B compare (A->B->B->A) with replay-only timing"
            >
              <span>Run Phase6B-3 Readback A/B Compare</span>
            </button>
          </div>
          <div className="debug-button-row" style={{ marginTop: '8px' }}>
            <button
              className="debug-btn secondary"
              onClick={runNoReadbackPilotGate}
              disabled={!!runningTest}
              title="Run fixed case-5000-04 with pilot enabled for 30s replay-only acceptance checks"
            >
              <span>Run No-Readback Pilot Gate (30s)</span>
            </button>
          </div>
          <div className="debug-button-row" style={{ marginTop: '8px' }}>
            <button
              className={`debug-btn secondary ${noReadbackPilotEnabled ? 'active' : ''}`}
              onClick={toggleNoReadbackPilot}
              disabled={!!runningTest}
              title="Debug-only pilot: disable stroke-end readback on live path. Undo/Redo are blocked while enabled."
            >
              <span>No-Readback Pilot: {noReadbackPilotEnabled ? 'ON' : 'OFF'}</span>
            </button>
          </div>
          <div className="debug-button-row" style={{ marginTop: '8px' }}>
            <button
              className="debug-btn secondary"
              onClick={recordPhase6ManualGate}
              disabled={!!runningTest}
              title="Record final manual 20-stroke pressure gate result"
            >
              <span>Record 20-Stroke Manual Gate</span>
            </button>
          </div>
          {noReadbackPilotEnabled && (
            <div className="debug-note" style={{ marginTop: '6px' }}>
              Pilot enabled: Undo/Redo are blocked to avoid CPU-layer consistency mismatch.
            </div>
          )}
          {noReadbackPilotMessage && (
            <div className="debug-note" style={{ marginTop: '6px' }}>
              {noReadbackPilotMessage}
            </div>
          )}
          <div className="debug-note" style={{ marginTop: '8px' }}>
            Manual checklist:
          </div>
          <label className="debug-note" style={{ display: 'block' }}>
            <input
              type="checkbox"
              checked={manualGateChecklist.noThinStart}
              onChange={(e) => updateManualGateChecklist('noThinStart', e.currentTarget.checked)}
              disabled={!!runningTest}
              style={{ marginRight: '6px' }}
            />
            无起笔细头
          </label>
          <label className="debug-note" style={{ display: 'block' }}>
            <input
              type="checkbox"
              checked={manualGateChecklist.noMissingOrDisappear}
              onChange={(e) =>
                updateManualGateChecklist('noMissingOrDisappear', e.currentTarget.checked)
              }
              disabled={!!runningTest}
              style={{ marginRight: '6px' }}
            />
            无丢笔触/无预览后消失
          </label>
          <label className="debug-note" style={{ display: 'block' }}>
            <input
              type="checkbox"
              checked={manualGateChecklist.noTailDab}
              onChange={(e) => updateManualGateChecklist('noTailDab', e.currentTarget.checked)}
              disabled={!!runningTest}
              style={{ marginRight: '6px' }}
            />
            无尾部延迟 dab
          </label>
          {gpuDiagResetMessage && (
            <div className="debug-note" style={{ marginTop: '6px' }}>
              {gpuDiagResetMessage}
            </div>
          )}
          <div className="debug-note">No console commands needed for these toggles.</div>
        </div>

        {runningTest && (
          <div className="debug-progress">
            <div className="debug-progress-label">
              Running: {runningTest}
              <span>{Math.round(progress * 100)}%</span>
            </div>
            <div className="debug-progress-bar">
              <div className="debug-progress-fill" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        )}

        <div className="debug-section">
          <h3>Performance Benchmark</h3>
          {benchmarkStats ? (
            <BenchmarkStatsView stats={benchmarkStats} envInfo={envInfo} />
          ) : (
            <div className="stat-placeholder">Benchmarks initializing...</div>
          )}
        </div>

        <div className="debug-section">
          <h3>Actions</h3>
          <div className="debug-button-row">
            <button
              className="debug-btn"
              onClick={runFullBenchmark}
              disabled={!!runningTest}
              title="Run automated benchmark"
            >
              <Timer size={16} />
              <span>Run Benchmark</span>
            </button>
          </div>
          <div className="debug-button-row" style={{ marginTop: '8px' }}>
            <button className="debug-btn secondary" onClick={clearCanvas} disabled={!!runningTest}>
              <RotateCcw size={16} />
              <span>Clear</span>
            </button>
            <button
              className="debug-btn secondary"
              onClick={exportReport}
              disabled={!lastReport && results.length === 0}
            >
              <Download size={16} />
              <span>Export</span>
            </button>
          </div>
        </div>

        {results.length > 0 && (
          <div className="debug-section">
            <h3>Results</h3>
            <div className="debug-results">
              {results.map((result, index) => (
                <div
                  key={index}
                  className={`debug-result ${result.status}`}
                  onClick={() => setExpandedResult(expandedResult === index ? null : index)}
                >
                  <div className="debug-result-header">
                    <StatusIcon status={result.status} />
                    <span className="debug-result-name">{result.name}</span>
                    {result.report && (
                      <button
                        type="button"
                        className="debug-result-copy-btn"
                        aria-label="Copy Report"
                        title="Copy this report to clipboard"
                        onClick={(event) => {
                          void copyResultReport(event, index, result);
                        }}
                      >
                        {copiedResultIndex === index ? 'Copied' : 'Copy'}
                      </button>
                    )}
                    <span className="debug-result-time">
                      {result.timestamp.toLocaleTimeString()}
                    </span>
                    {result.report &&
                      (expandedResult === index ? (
                        <ChevronUp size={14} />
                      ) : (
                        <ChevronDown size={14} />
                      ))}
                  </div>
                  {expandedResult === index && result.report && (
                    <pre className="debug-result-report">{result.report}</pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="debug-panel-footer">
        <span className="debug-hint">Press Shift+Ctrl+D to toggle</span>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: TestStatus }) {
  switch (status) {
    case 'running':
      return <span className="status-icon running">⏳</span>;
    case 'passed':
      return <span className="status-icon passed">✅</span>;
    case 'failed':
      return <span className="status-icon failed">❌</span>;
    default:
      return null;
  }
}

export default DebugPanel;
