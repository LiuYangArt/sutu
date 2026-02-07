import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StrokeCaptureData } from '../../test';
import { DebugPanel } from './index';

type TestWindow = Window & {
  __gpuBrushDiagnosticsReset?: () => boolean;
  __gpuBrushDiagnostics?: () => unknown;
  __gpuLayerStackCacheStats?: () => unknown;
  __gpuBrushCommitMetrics?: () => unknown;
  __gpuBrushCommitMetricsReset?: () => boolean;
  __gpuBrushCommitReadbackMode?: () => 'enabled' | 'disabled';
  __gpuBrushCommitReadbackModeSet?: (mode: 'enabled' | 'disabled') => boolean;
  __gpuBrushNoReadbackPilot?: () => boolean;
  __gpuBrushNoReadbackPilotSet?: (enabled: boolean) => boolean;
  __strokeCaptureStart?: () => boolean;
  __strokeCaptureStop?: () => unknown;
  __strokeCaptureSaveFixed?: (
    capture?: unknown
  ) => Promise<{ ok: boolean; path: string; name: string; source: 'appconfig' | 'localstorage' }>;
  __strokeCaptureLoadFixed?: () => Promise<{
    capture: unknown;
    path: string;
    name: string;
    source: 'appconfig' | 'localstorage';
  } | null>;
  __strokeCaptureReplay?: (capture?: unknown) => Promise<unknown>;
  __canvasClearLayer?: () => void;
  __gpuM4ParityGate?: () => Promise<{
    passed: boolean;
    report: string;
    captureName: string;
    captureSource: 'appconfig' | 'localstorage';
    capturePath: string;
    thresholds: { meanAbsDiffMax: number; mismatchRatioMax: number };
    uncapturedErrors: number;
    deviceLost: boolean;
    cases: Array<{
      caseId: string;
      passed: boolean;
      meanAbsDiff: number;
      mismatchRatio: number;
      maxDiff: number;
      pixelCount: number;
      error?: string;
    }>;
  }>;
};

function createFixedCapture(): StrokeCaptureData {
  return {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    metadata: { canvasWidth: 128, canvasHeight: 128, viewportScale: 1, tool: {} },
    samples: [
      {
        type: 'pointerdown',
        timeMs: 0,
        x: 10,
        y: 10,
        pressure: 0.5,
        tiltX: 0,
        tiltY: 0,
        pointerType: 'pen',
        pointerId: 1,
        buttons: 1,
      },
    ],
  };
}

function getLatestResultNode(resultName: string): HTMLElement {
  if (document.querySelector('.debug-result') === null) {
    const generalTab = screen.queryByRole('tab', { name: 'General' });
    if (generalTab) {
      fireEvent.click(generalTab);
    }
  }
  const labels = screen.getAllByText(resultName);
  const latest = labels[0];
  const resultNode = latest?.closest('.debug-result');
  if (!resultNode) {
    throw new Error(`Missing result node for: ${resultName}`);
  }
  return resultNode as HTMLElement;
}

function expectLatestResultStatus(resultName: string, status: 'passed' | 'failed'): void {
  const latest = getLatestResultNode(resultName);
  expect(latest.className).toContain(status);
}

describe('DebugPanel', () => {
  beforeEach(() => {
    (window as TestWindow).__gpuBrushDiagnosticsReset = vi.fn(() => true);
    (window as TestWindow).__gpuBrushDiagnostics = vi.fn(() => ({
      diagnosticsSessionId: 2,
      uncapturedErrors: [],
      deviceLost: false,
    }));
    (window as TestWindow).__gpuBrushCommitMetrics = vi.fn(() => ({
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
      readbackMode: 'enabled' as const,
      readbackBypassedCount: 0,
    }));
    (window as TestWindow).__gpuBrushCommitMetricsReset = vi.fn(() => true);
    (window as TestWindow).__gpuBrushCommitReadbackMode = vi.fn(() => 'enabled');
    (window as TestWindow).__gpuBrushCommitReadbackModeSet = vi.fn(() => true);
    (window as TestWindow).__gpuBrushNoReadbackPilot = vi.fn(() => false);
    (window as TestWindow).__gpuBrushNoReadbackPilotSet = vi.fn(() => true);
    (window as TestWindow).__strokeCaptureStart = vi.fn(() => true);
    (window as TestWindow).__strokeCaptureStop = vi.fn(() => createFixedCapture());
    (window as TestWindow).__strokeCaptureSaveFixed = vi.fn(async () => ({
      ok: true,
      path: 'AppConfig/debug-data/debug-stroke-capture.json',
      name: 'debug-stroke-capture.json',
      source: 'appconfig' as const,
    }));
    (window as TestWindow).__strokeCaptureLoadFixed = vi.fn(async () => ({
      capture: createFixedCapture(),
      path: 'AppConfig/debug-data/debug-stroke-capture.json',
      name: 'debug-stroke-capture.json',
      source: 'appconfig' as const,
    }));
    (window as TestWindow).__gpuM4ParityGate = vi.fn(async () => ({
      passed: true,
      report: 'M4 Gate: PASS',
      captureName: 'debug-stroke-capture.json',
      captureSource: 'appconfig' as const,
      capturePath: 'AppConfig/debug-data/debug-stroke-capture.json',
      thresholds: { meanAbsDiffMax: 3, mismatchRatioMax: 1.5 },
      uncapturedErrors: 0,
      deviceLost: false,
      cases: [
        {
          caseId: 'scatter_core',
          passed: true,
          meanAbsDiff: 0.6,
          mismatchRatio: 0.4,
          maxDiff: 3,
          pixelCount: 128 * 128,
        },
      ],
    }));
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    delete (window as TestWindow).__gpuBrushDiagnosticsReset;
    delete (window as TestWindow).__gpuBrushDiagnostics;
    delete (window as TestWindow).__gpuBrushCommitMetrics;
    delete (window as TestWindow).__gpuBrushCommitMetricsReset;
    delete (window as TestWindow).__gpuBrushCommitReadbackMode;
    delete (window as TestWindow).__gpuBrushCommitReadbackModeSet;
    delete (window as TestWindow).__gpuBrushNoReadbackPilot;
    delete (window as TestWindow).__gpuBrushNoReadbackPilotSet;
    delete (window as TestWindow).__strokeCaptureStart;
    delete (window as TestWindow).__strokeCaptureStop;
    delete (window as TestWindow).__strokeCaptureSaveFixed;
    delete (window as TestWindow).__strokeCaptureLoadFixed;
    delete (window as TestWindow).__strokeCaptureReplay;
    delete (window as TestWindow).__canvasClearLayer;
    delete (window as TestWindow).__gpuM4ParityGate;
    vi.restoreAllMocks();
  });

  it('calls diagnostics reset from GPU Brush panel button', async () => {
    const user = userEvent.setup();
    const resetSpy = vi.fn(() => true);
    (window as TestWindow).__gpuBrushDiagnosticsReset = resetSpy;
    (window as TestWindow).__gpuBrushDiagnostics = vi.fn(() => ({ diagnosticsSessionId: 7 }));

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);
    const resetButton = screen.getByRole('button', { name: 'Reset GPU Diag' });
    await user.click(resetButton);

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Diagnostics reset OK (session 7)')).toBeInTheDocument();
  });

  it('默认显示 GPU Tests tab，可切换到 General', async () => {
    const user = userEvent.setup();
    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);

    expect(screen.getByRole('button', { name: 'Reset GPU Diag' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Stroke Tests' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'General' }));
    expect(screen.getByRole('heading', { name: 'Stroke Tests' })).toBeInTheDocument();
  });

  it('可通过 Start/Stop 按钮录制并保存固定文件', async () => {
    const user = userEvent.setup();
    const startSpy = vi.fn(() => true);
    const stopSpy = vi.fn(() => createFixedCapture());
    const saveSpy = vi.fn(async () => ({
      ok: true,
      path: 'AppConfig/debug-data/debug-stroke-capture.json',
      name: 'debug-stroke-capture.json',
      source: 'appconfig' as const,
    }));
    (window as TestWindow).__strokeCaptureStart = startSpy;
    (window as TestWindow).__strokeCaptureStop = stopSpy;
    (window as TestWindow).__strokeCaptureSaveFixed = saveSpy;

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);

    await user.click(screen.getByRole('button', { name: 'Start Recording' }));
    await user.click(screen.getByRole('button', { name: 'Stop & Save Fixed Case' }));

    await waitFor(() => {
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Saved fixed capture:/)).toBeInTheDocument();
    });
  });

  it('Phase6A Auto Gate 每轮 replay 前都会清层', async () => {
    const user = userEvent.setup();
    const clearLayerSpy = vi.fn();
    const replaySpy = vi.fn(async () => ({ events: 100, durationMs: 1000 }));
    const resetSpy = vi.fn(() => true);

    (window as TestWindow).__canvasClearLayer = clearLayerSpy;
    (window as TestWindow).__strokeCaptureReplay = replaySpy;
    (window as TestWindow).__gpuBrushDiagnosticsReset = resetSpy;
    (window as TestWindow).__gpuBrushDiagnostics = vi
      .fn()
      .mockReturnValueOnce({ diagnosticsSessionId: 7, uncapturedErrors: [], deviceLost: false })
      .mockReturnValue({ diagnosticsSessionId: 7, uncapturedErrors: [], deviceLost: false });

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);

    await user.click(screen.getByRole('button', { name: 'Run Phase6A Auto Gate' }));

    await waitFor(() => {
      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(clearLayerSpy).toHaveBeenCalledTimes(3);
      expect(replaySpy).toHaveBeenCalledTimes(3);
      expect((window as TestWindow).__strokeCaptureLoadFixed).toHaveBeenCalledTimes(1);
    });
    expectLatestResultStatus('Phase6A Auto Gate', 'passed');
  });

  it('M4 Feature Parity Gate 调用全局 API 并写入结果', async () => {
    const user = userEvent.setup();
    const gateSpy = vi.fn(async () => ({
      passed: false,
      report: 'M4 Gate: FAIL',
      captureName: 'debug-stroke-capture.json',
      captureSource: 'appconfig' as const,
      capturePath: 'AppConfig/debug-data/debug-stroke-capture.json',
      thresholds: { meanAbsDiffMax: 3, mismatchRatioMax: 1.5 },
      uncapturedErrors: 1,
      deviceLost: false,
      cases: [
        {
          caseId: 'texture_core',
          passed: false,
          meanAbsDiff: 3.8,
          mismatchRatio: 2.1,
          maxDiff: 18,
          pixelCount: 4096,
        },
      ],
    }));
    (window as TestWindow).__gpuM4ParityGate = gateSpy;

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Run M4 Feature Parity Gate' }));

    await waitFor(() => {
      expect(gateSpy).toHaveBeenCalledTimes(1);
      expectLatestResultStatus('M4 Feature Parity Gate', 'failed');
    });
    const latest = getLatestResultNode('M4 Feature Parity Gate');
    await user.click(latest);
    expect(screen.getByText(/M4 Gate: FAIL/)).toBeInTheDocument();
    expect(screen.getByText(/texture_core: FAIL/)).toBeInTheDocument();
  });

  it('M4 Feature Parity Gate 缺失 API 时失败并提示', async () => {
    const user = userEvent.setup();
    delete (window as TestWindow).__gpuM4ParityGate;

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Run M4 Feature Parity Gate' }));

    await waitFor(() => {
      expectLatestResultStatus('M4 Feature Parity Gate', 'failed');
    });
    const latest = getLatestResultNode('M4 Feature Parity Gate');
    await user.click(latest);
    expect(screen.getByText(/Missing API: window.__gpuM4ParityGate/)).toBeInTheDocument();
  });

  it('固定录制文件缺失时 Phase6A Auto Gate 失败并提示', async () => {
    const user = userEvent.setup();
    (window as TestWindow).__strokeCaptureLoadFixed = vi.fn(async () => null);
    (window as TestWindow).__canvasClearLayer = vi.fn();
    (window as TestWindow).__strokeCaptureReplay = vi.fn(async () => ({
      events: 100,
      durationMs: 1,
    }));

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Run Phase6A Auto Gate' }));

    await waitFor(() => {
      expectLatestResultStatus('Phase6A Auto Gate', 'failed');
    });
    const latest = getLatestResultNode('Phase6A Auto Gate');
    await user.click(latest);
    expect(screen.getByText(/Fixed capture not found/)).toBeInTheDocument();
  });

  it('Phase6A Manual Gate 由 checklist + diagnostics 共同判定', async () => {
    const user = userEvent.setup();
    (window as TestWindow).__gpuBrushDiagnostics = vi.fn(() => ({
      diagnosticsSessionId: 7,
      uncapturedErrors: [],
      deviceLost: false,
    }));

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);

    await user.click(screen.getByRole('button', { name: 'Record 20-Stroke Manual Gate' }));
    expectLatestResultStatus('Phase6A Manual 20-Stroke', 'failed');

    await user.click(screen.getByRole('tab', { name: 'GPU Tests' }));
    await user.click(screen.getByLabelText('无起笔细头'));
    await user.click(screen.getByLabelText('无丢笔触/无预览后消失'));
    await user.click(screen.getByLabelText('无尾部延迟 dab'));

    await user.click(screen.getByRole('button', { name: 'Record 20-Stroke Manual Gate' }));
    expectLatestResultStatus('Phase6A Manual 20-Stroke', 'passed');
  });

  it('No-Readback Pilot 开关可切换并显示同步提示', async () => {
    const user = userEvent.setup();
    let pilotEnabled = false;
    const getPilotSpy = vi.fn(() => pilotEnabled);
    const setPilotSpy = vi.fn((enabled: boolean) => {
      pilotEnabled = enabled;
      return true;
    });
    (window as TestWindow).__gpuBrushNoReadbackPilot = getPilotSpy;
    (window as TestWindow).__gpuBrushNoReadbackPilotSet = setPilotSpy;

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);

    const pilotButton = screen.getByRole('button', { name: 'No-Readback Pilot: OFF' });
    await user.click(pilotButton);

    expect(setPilotSpy).toHaveBeenCalledWith(true);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'No-Readback Pilot: ON' })).toBeInTheDocument();
    });
    expect(
      screen.getByText('No-Readback active: Undo/Redo and export use on-demand GPU-to-CPU sync.')
    ).toBeInTheDocument();
  });

  it('Results 支持一键复制报告到剪贴板', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Record 20-Stroke Manual Gate' }));

    await waitFor(() => {
      expectLatestResultStatus('Phase6A Manual 20-Stroke', 'failed');
    });

    const latest = getLatestResultNode('Phase6A Manual 20-Stroke');
    const copyButton = within(latest).getByRole('button', { name: 'Copy Report' });
    await user.click(copyButton);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Phase6A Manual 20-Stroke'));
    expect(copyButton).toHaveTextContent('Copied');
  });

  it('Phase6B Perf Gate 在 replay+metrics 可用时通过', async () => {
    const user = userEvent.setup();
    const clearLayerSpy = vi.fn();
    const replaySpy = vi.fn(async () => ({ events: 120, durationMs: 1500 }));
    const resetDiagSpy = vi.fn(() => true);
    const resetMetricsSpy = vi.fn(() => true);
    const getMetricsSpy = vi.fn(() => ({
      attemptCount: 2,
      committedCount: 2,
      avgPrepareMs: 1.2,
      avgCommitMs: 2.4,
      avgReadbackMs: 3.6,
      avgTotalMs: 7.2,
      maxTotalMs: 9.9,
      totalDirtyTiles: 10,
      avgDirtyTiles: 5,
      maxDirtyTiles: 6,
      lastCommitAtMs: 1234,
      readbackMode: 'enabled' as const,
      readbackBypassedCount: 0,
    }));

    (window as TestWindow).__canvasClearLayer = clearLayerSpy;
    (window as TestWindow).__strokeCaptureReplay = replaySpy;
    (window as TestWindow).__gpuBrushDiagnosticsReset = resetDiagSpy;
    (window as TestWindow).__gpuBrushCommitMetricsReset = resetMetricsSpy;
    (window as TestWindow).__gpuBrushCommitMetrics = getMetricsSpy;
    (window as TestWindow).__gpuBrushDiagnostics = vi.fn(() => ({
      diagnosticsSessionId: 9,
      uncapturedErrors: [],
      deviceLost: false,
    }));

    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 10_000;
      return now;
    });

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);

    await user.click(screen.getByRole('button', { name: 'Run Phase6B Perf Gate (30s)' }));

    await waitFor(() => {
      expect(resetDiagSpy).toHaveBeenCalledTimes(1);
      expect(resetMetricsSpy).toHaveBeenCalledTimes(1);
      expect(replaySpy).toHaveBeenCalled();
      expect(getMetricsSpy).toHaveBeenCalled();
      expect((window as TestWindow).__strokeCaptureLoadFixed).toHaveBeenCalledTimes(1);
    });
    expectLatestResultStatus('Phase6B Perf Gate (30s)', 'passed');
  });

  it('Phase6B-3 Readback A/B Compare 按 A->B->B->A 顺序执行并通过', async () => {
    const user = userEvent.setup();
    const clearLayerSpy = vi.fn();
    const replaySpy = vi.fn(async () => {
      await Promise.resolve();
      return { events: 200, durationMs: 1000 };
    });
    const resetDiagSpy = vi.fn(() => true);
    const resetMetricsSpy = vi.fn(() => true);
    let mode: 'enabled' | 'disabled' = 'enabled';
    const getModeSpy = vi.fn(() => mode);
    const setModeSpy = vi.fn((next: 'enabled' | 'disabled') => {
      mode = next;
      return true;
    });
    const getMetricsSpy = vi.fn(() => ({
      attemptCount: 3,
      committedCount: 3,
      avgPrepareMs: 1,
      avgCommitMs: 2,
      avgReadbackMs: mode === 'enabled' ? 4 : 0,
      avgTotalMs: mode === 'enabled' ? 7 : 3,
      maxTotalMs: 10,
      totalDirtyTiles: 12,
      avgDirtyTiles: 4,
      maxDirtyTiles: 6,
      lastCommitAtMs: 4567,
      readbackMode: mode,
      readbackBypassedCount: mode === 'enabled' ? 0 : 3,
    }));

    (window as TestWindow).__canvasClearLayer = clearLayerSpy;
    (window as TestWindow).__strokeCaptureReplay = replaySpy;
    (window as TestWindow).__gpuBrushDiagnosticsReset = resetDiagSpy;
    (window as TestWindow).__gpuBrushCommitMetricsReset = resetMetricsSpy;
    (window as TestWindow).__gpuBrushCommitMetrics = getMetricsSpy;
    (window as TestWindow).__gpuBrushDiagnostics = vi.fn(() => ({
      diagnosticsSessionId: 11,
      uncapturedErrors: [],
      deviceLost: false,
    }));
    (window as TestWindow).__gpuBrushCommitReadbackMode = getModeSpy;
    (window as TestWindow).__gpuBrushCommitReadbackModeSet = setModeSpy;

    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 40_000;
      return now;
    });

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Run Phase6B-3 Readback A/B Compare' }));

    await waitFor(() => {
      expectLatestResultStatus('Phase6B-3 Readback A/B Compare', 'passed');
    });

    const firstFourModes = setModeSpy.mock.calls.slice(0, 4).map((call) => call[0]);
    expect(firstFourModes).toEqual(['enabled', 'disabled', 'disabled', 'enabled']);
    const lastModeCall = setModeSpy.mock.calls[setModeSpy.mock.calls.length - 1];
    expect(lastModeCall?.[0]).toBe('enabled');
    expect(replaySpy).toHaveBeenCalled();
    expect(clearLayerSpy).toHaveBeenCalled();
  });

  it('Phase6B-3 Compare 与 Pilot 共存时恢复到 disabled 模式', async () => {
    const user = userEvent.setup();
    const clearLayerSpy = vi.fn();
    const replaySpy = vi.fn(async () => ({ events: 200, durationMs: 1000 }));
    const resetDiagSpy = vi.fn(() => true);
    const resetMetricsSpy = vi.fn(() => true);
    let mode: 'enabled' | 'disabled' = 'disabled';
    const getModeSpy = vi.fn(() => mode);
    const setModeSpy = vi.fn((next: 'enabled' | 'disabled') => {
      mode = next;
      return true;
    });

    (window as TestWindow).__gpuBrushNoReadbackPilot = vi.fn(() => mode === 'disabled');
    (window as TestWindow).__gpuBrushNoReadbackPilotSet = vi.fn((enabled: boolean) => {
      mode = enabled ? 'disabled' : 'enabled';
      return true;
    });
    (window as TestWindow).__canvasClearLayer = clearLayerSpy;
    (window as TestWindow).__strokeCaptureReplay = replaySpy;
    (window as TestWindow).__gpuBrushDiagnosticsReset = resetDiagSpy;
    (window as TestWindow).__gpuBrushCommitMetricsReset = resetMetricsSpy;
    (window as TestWindow).__gpuBrushCommitMetrics = vi.fn(() => ({
      attemptCount: 3,
      committedCount: 3,
      avgPrepareMs: 1,
      avgCommitMs: 2,
      avgReadbackMs: mode === 'enabled' ? 4 : 0,
      avgTotalMs: mode === 'enabled' ? 7 : 3,
      maxTotalMs: 10,
      totalDirtyTiles: 12,
      avgDirtyTiles: 4,
      maxDirtyTiles: 6,
      lastCommitAtMs: 4567,
      readbackMode: mode,
      readbackBypassedCount: mode === 'enabled' ? 0 : 3,
    }));
    (window as TestWindow).__gpuBrushDiagnostics = vi.fn(() => ({
      diagnosticsSessionId: 21,
      uncapturedErrors: [],
      deviceLost: false,
    }));
    (window as TestWindow).__gpuBrushCommitReadbackMode = getModeSpy;
    (window as TestWindow).__gpuBrushCommitReadbackModeSet = setModeSpy;

    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 40_000;
      return now;
    });

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Run Phase6B-3 Readback A/B Compare' }));

    await waitFor(() => {
      expectLatestResultStatus('Phase6B-3 Readback A/B Compare', 'passed');
    });
    const lastModeCall = setModeSpy.mock.calls[setModeSpy.mock.calls.length - 1];
    expect(lastModeCall?.[0]).toBe('disabled');
    await user.click(screen.getByRole('tab', { name: 'GPU Tests' }));
    expect(screen.getByRole('button', { name: 'No-Readback Pilot: ON' })).toBeInTheDocument();
  });

  it('Phase6B-3 Readback A/B Compare 缺失 readback mode API 时失败', async () => {
    const user = userEvent.setup();
    delete (window as TestWindow).__gpuBrushCommitReadbackModeSet;

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Run Phase6B-3 Readback A/B Compare' }));

    await waitFor(() => {
      expectLatestResultStatus('Phase6B-3 Readback A/B Compare', 'failed');
    });
  });

  it('No-Readback Pilot Gate 在 API 可用时通过', async () => {
    const user = userEvent.setup();
    let pilotEnabled = false;
    const getPilotSpy = vi.fn(() => pilotEnabled);
    const setPilotSpy = vi.fn((enabled: boolean) => {
      pilotEnabled = enabled;
      return true;
    });
    const clearLayerSpy = vi.fn();
    const replaySpy = vi.fn(async () => ({ events: 150, durationMs: 900 }));

    (window as TestWindow).__gpuBrushNoReadbackPilot = getPilotSpy;
    (window as TestWindow).__gpuBrushNoReadbackPilotSet = setPilotSpy;
    (window as TestWindow).__canvasClearLayer = clearLayerSpy;
    (window as TestWindow).__strokeCaptureReplay = replaySpy;
    (window as TestWindow).__gpuBrushDiagnosticsReset = vi.fn(() => true);
    (window as TestWindow).__gpuBrushCommitMetricsReset = vi.fn(() => true);
    (window as TestWindow).__gpuBrushCommitMetrics = vi.fn(() => ({
      attemptCount: 3,
      committedCount: 3,
      avgPrepareMs: 1,
      avgCommitMs: 2,
      avgReadbackMs: 0.2,
      avgTotalMs: 3.2,
      maxTotalMs: 8,
      totalDirtyTiles: 10,
      avgDirtyTiles: 3.3,
      maxDirtyTiles: 5,
      lastCommitAtMs: 1234,
      readbackMode: 'disabled' as const,
      readbackBypassedCount: 22,
    }));
    (window as TestWindow).__gpuBrushDiagnostics = vi.fn(() => ({
      diagnosticsSessionId: 31,
      uncapturedErrors: [],
      deviceLost: false,
    }));

    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 40_000;
      return now;
    });

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Run No-Readback Pilot Gate (30s)' }));

    await waitFor(() => {
      expectLatestResultStatus('No-Readback Pilot Gate (30s)', 'passed');
    });

    expect(setPilotSpy).toHaveBeenCalledWith(true);
    const lastPilotCall = setPilotSpy.mock.calls[setPilotSpy.mock.calls.length - 1];
    expect(lastPilotCall?.[0]).toBe(false);
    expect(clearLayerSpy).toHaveBeenCalled();
    expect(replaySpy).toHaveBeenCalled();
  });

  it('No-Readback Pilot Gate 缺失 pilot API 时失败', async () => {
    const user = userEvent.setup();
    delete (window as TestWindow).__gpuBrushNoReadbackPilotSet;

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Run No-Readback Pilot Gate (30s)' }));

    await waitFor(() => {
      expectLatestResultStatus('No-Readback Pilot Gate (30s)', 'failed');
    });
  });

  it('Phase6B Perf Gate 缺失 commit metrics API 时失败', async () => {
    const user = userEvent.setup();
    delete (window as TestWindow).__gpuBrushCommitMetrics;

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Run Phase6B Perf Gate (30s)' }));

    await waitFor(() => {
      expectLatestResultStatus('Phase6B Perf Gate (30s)', 'failed');
    });
    expect(screen.getAllByText('Phase6B Perf Gate (30s)')).toHaveLength(1);
  });

  it('支持通过右下角 resize handle 调整面板尺寸', async () => {
    const { container } = render(
      <DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />
    );
    const panel = container.querySelector('.debug-panel') as HTMLDivElement;
    const handle = container.querySelector('.resize-handle') as HTMLDivElement;

    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 680,
      bottom: 820,
      width: 680,
      height: 820,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(handle, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(handle, 'releasePointerCapture', {
      configurable: true,
      value: vi.fn(),
    });

    fireEvent.mouseDown(handle, {
      clientX: 680,
      clientY: 820,
      pageX: 680,
      pageY: 820,
      screenX: 680,
      screenY: 820,
    });
    fireEvent.mouseMove(window, {
      clientX: 760,
      clientY: 900,
      pageX: 760,
      pageY: 900,
      screenX: 760,
      screenY: 900,
    });
    fireEvent.mouseUp(window);

    const expectedWidth = Math.min(760, Math.max(320, window.innerWidth - 16));
    const expectedHeight = Math.min(900, Math.max(300, window.innerHeight - 16));

    await waitFor(() => {
      expect(panel.style.width).toBe(`${expectedWidth}px`);
      expect(panel.style.height).toBe(`${expectedHeight}px`);
    });
  });
});
