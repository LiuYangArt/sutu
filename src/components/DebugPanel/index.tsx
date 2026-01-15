import { useState, useCallback, useRef, useEffect } from 'react';
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
  }, [canvas]);

  const exportResults = useCallback(() => {
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
  }, [results]);

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

  return (
    <div className="debug-panel">
      <div className="debug-panel-header">
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
          <h3>Actions</h3>
          <div className="debug-button-row">
            <button
              className="debug-btn secondary"
              onClick={clearCanvas}
              disabled={!!runningTest}
              title="Clear the canvas"
            >
              <RotateCcw size={16} />
              <span>Clear</span>
            </button>

            <button
              className="debug-btn secondary"
              onClick={exportResults}
              disabled={results.length === 0}
              title="Export test results"
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
