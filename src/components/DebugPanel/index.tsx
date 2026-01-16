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
import './DebugPanel.css';

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

export function DebugPanel({ canvas, onClose }: DebugPanelProps) {
  const [results, setResults] = useState<TestResult[]>([]);
  const [runningTest, setRunningTest] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [expandedResult, setExpandedResult] = useState<number | null>(null);

  const diagnosticsRef = useRef<DiagnosticHooks | null>(null);

  // Drag state for movable panel
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number; panelX: number; panelY: number } | null>(
    null
  );
  const panelRef = useRef<HTMLDivElement>(null);

  // Benchmark Stats
  const [benchmarkStats, setBenchmarkStats] = useState<{
    latency: LatencyProfilerStats;
    fps: FrameStats;
    lagometer: LagometerStats;
    queueDepth: number;
  } | null>(null);

  // Environment detection for perf debugging
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

  // Calculate panel style
  const panelStyle: React.CSSProperties = position
    ? { left: position.x, top: position.y, right: 'auto' }
    : {};

  const getBenchmarkApi = () => window.__benchmark;

  useEffect(() => {
    const timer = setInterval(() => {
      const bench = getBenchmarkApi();
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

  /**
   * Run a test with common setup/teardown logic
   */
  const runTest = useCallback(
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

  const runGridTest = useCallback(() => {
    return runTest('grid', 'Grid Test (10x10)', async () => {
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
  }, [canvas, runTest]);

  const runRapidTapsTest = useCallback(() => {
    return runTest('rapid', 'Rapid Taps (100x)', async () => {
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
  }, [canvas, runTest]);

  const runChaosTest = useCallback(() => {
    return runTest('chaos', 'Chaos Test (5s)', async () => {
      const result: ChaosTestResult = await chaosMixed(canvas!, {
        duration: 5000,
        strokeProbability: 0.3,
        onProgress: setProgress,
      });
      return { passed: result.errors === 0, report: formatChaosReport(result) };
    });
  }, [canvas, runTest]);

  const clearCanvas = useCallback(() => {
    if (!canvas) return;
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    diagnosticsRef.current?.reset();

    // Also reset benchmark stats
    const bench = getBenchmarkApi();
    bench?.latencyProfiler.reset();
    bench?.lagometer.reset();
  }, [canvas]);

  // Benchmark report state
  const [lastReport, setLastReport] = useState<BenchmarkReport | null>(null);

  const runBenchmark = useCallback(async () => {
    if (!canvas || runningTest) return;

    setRunningTest('benchmark');
    setProgress(0);
    addResult('Benchmark Suite', 'running');

    const bench = getBenchmarkApi();

    if (!bench) {
      addResult('Benchmark Suite', 'failed', 'Benchmark not initialized');
      setRunningTest(null);
      return;
    }

    try {
      const runner = new BenchmarkRunner(canvas);
      runner.setProgressCallback((p, name) => {
        setProgress(p);
        if (name !== 'Complete') {
          setRunningTest(`benchmark: ${name}`);
        }
      });

      const report = await runner.runScenarios(DEFAULT_SCENARIOS, {
        latencyProfiler: bench.latencyProfiler,
        fpsCounter: bench.fpsCounter,
        lagometer: bench.lagometer,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  const exportReport = useCallback(() => {
    if (lastReport) {
      downloadBenchmarkReport(lastReport);
    } else if (results.length > 0) {
      // Fallback to test results export
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

  function getStatusIcon(status: TestStatus) {
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

  // Drag handlers
  const handleDragStart = (e: React.PointerEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    const panel = panelRef.current;
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
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

  return (
    <div className="debug-panel" ref={panelRef} style={panelStyle}>
      <div
        className="debug-panel-header"
        onPointerDown={handleDragStart}
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
          <div className="debug-button-grid">
            <button
              className="debug-btn"
              onClick={runGridTest}
              disabled={!!runningTest}
              title="Draw 10x10 grid of taps and verify all points are rendered"
            >
              <Grid3X3 size={16} />
              <span>Grid 10x10</span>
            </button>

            <button
              className="debug-btn"
              onClick={runRapidTapsTest}
              disabled={!!runningTest}
              title="100 rapid random taps"
            >
              <Zap size={16} />
              <span>Rapid 100x</span>
            </button>

            <button
              className="debug-btn"
              onClick={runChaosTest}
              disabled={!!runningTest}
              title="5 seconds of random input (taps + strokes)"
            >
              <Play size={16} />
              <span>Chaos 5s</span>
            </button>
          </div>
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
            <div className="benchmark-stats">
              <div className="stat-row">
                <span className="stat-label">FPS:</span>
                <span className="stat-value">{benchmarkStats.fps.fps.toFixed(1)}</span>
                <span className="stat-sub">
                  (σ: {benchmarkStats.fps.frameTimeStdDev.toFixed(2)}ms)
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Dropped:</span>
                <span className="stat-value">{benchmarkStats.fps.droppedFrames}</span>
                <span className="stat-sub">
                  (max consec: {benchmarkStats.fps.consecutiveDrops})
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">P99 Frame:</span>
                <span className="stat-value">{benchmarkStats.fps.p99FrameTime.toFixed(2)}ms</span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Render Latency (Avg):</span>
                <span className="stat-value">
                  {benchmarkStats.latency.avgTotalRenderLatency.toFixed(2)}ms
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Render Latency (P99):</span>
                <span className="stat-value">
                  {benchmarkStats.latency.p99RenderLatency.toFixed(2)}ms
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Input Latency:</span>
                <span className="stat-value">
                  {benchmarkStats.latency.avgInputLatency.toFixed(2)}ms
                </span>
              </div>
              {/* Q3: Latency Segment Breakdown */}
              <div className="stat-row segment-breakdown">
                <span className="stat-label">├ Event→Queue:</span>
                <span className="stat-value">
                  {benchmarkStats.latency.segments.inputToQueue.toFixed(2)}ms
                </span>
              </div>
              <div className="stat-row segment-breakdown">
                <span className="stat-label">├ Queue Wait:</span>
                <span className="stat-value">
                  {benchmarkStats.latency.segments.queueWait.toFixed(2)}ms
                </span>
                <span className="stat-sub">
                  {benchmarkStats.latency.segments.queueWait > 5 ? '⚠️' : ''}
                </span>
              </div>
              <div className="stat-row segment-breakdown">
                <span className="stat-label">├ CPU Encode:</span>
                <span className="stat-value">
                  {benchmarkStats.latency.segments.cpuEncode.toFixed(2)}ms
                </span>
              </div>
              <div className="stat-row segment-breakdown">
                <span className="stat-label">└ GPU Execute:</span>
                <span className="stat-value">
                  {benchmarkStats.latency.segments.gpuExecute.toFixed(2)}ms
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Visual Lag (Max):</span>
                <span className="stat-value">
                  {benchmarkStats.lagometer.maxLagDistance.toFixed(1)}px
                </span>
                <span className="stat-sub">
                  ({benchmarkStats.lagometer.lagAsScreenPercent.toFixed(1)}%,{' '}
                  {benchmarkStats.lagometer.lagAsBrushRadii.toFixed(1)}x)
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Queue Depth:</span>
                <span className="stat-value">{benchmarkStats.queueDepth}</span>
                <span className="stat-sub">
                  {benchmarkStats.queueDepth > 10 ? '⚠️ Backlog' : '✅ OK'}
                </span>
              </div>
              <div
                className="stat-row"
                style={{
                  marginTop: '8px',
                  borderTop: '1px solid var(--border-color)',
                  paddingTop: '8px',
                }}
              >
                <span className="stat-label">Environment:</span>
                <span className="stat-value">{envInfo.runtime}</span>
                <span className="stat-sub">({envInfo.engine})</span>
              </div>
            </div>
          ) : (
            <div className="stat-placeholder">Benchmarks initializing...</div>
          )}
        </div>

        <div className="debug-section">
          <h3>Actions</h3>
          <div className="debug-button-row">
            <button
              className="debug-btn"
              onClick={runBenchmark}
              disabled={!!runningTest}
              title="Run automated benchmark with different brush sizes"
            >
              <Timer size={16} />
              <span>Run Benchmark</span>
            </button>
          </div>
          <div className="debug-button-row" style={{ marginTop: '8px' }}>
            <button
              className="debug-btn secondary"
              onClick={clearCanvas}
              disabled={!!runningTest}
              title="Clear canvas and reset stats"
            >
              <RotateCcw size={16} />
              <span>Clear</span>
            </button>

            <button
              className="debug-btn secondary"
              onClick={exportReport}
              disabled={!lastReport && results.length === 0}
              title="Export benchmark report"
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
                    {getStatusIcon(result.status)}
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

export default DebugPanel;
