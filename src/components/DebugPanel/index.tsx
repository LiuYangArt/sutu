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
} from '../../test';
import { LatencyProfilerStats, FrameStats, LagometerStats } from '@/benchmark/types';
import {
  BenchmarkRunner,
  DEFAULT_SCENARIOS,
  downloadBenchmarkReport,
  type BenchmarkReport,
} from '@/benchmark';
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
  const [results, setResults] = useState<TestResult[]>([]);
  const [runningTest, setRunningTest] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [expandedResult, setExpandedResult] = useState<number | null>(null);
  const [benchmarkStats, setBenchmarkStats] = useState<BenchmarkStatsData | null>(null);
  const [lastReport, setLastReport] = useState<BenchmarkReport | null>(null);

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

  const addResult = useCallback((name: string, status: TestStatus, report?: string) => {
    setResults((prev) => [{ name, status, report, timestamp: new Date() }, ...prev.slice(0, 9)]);
  }, []);

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
        latencyProfiler: bench.latencyProfiler,
        fpsCounter: bench.fpsCounter,
        lagometer: bench.lagometer,
      } as any);

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
