import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DebugPanel } from './index';

type TestWindow = Window & {
  __gpuBrushDiagnosticsReset?: () => boolean;
  __gpuBrushDiagnostics?: () => unknown;
  __gpuBrushCommitMetrics?: () => unknown;
  __gpuBrushCommitMetricsReset?: () => boolean;
  __gpuBrushCommitReadbackMode?: () => 'enabled' | 'disabled';
  __gpuBrushCommitReadbackModeSet?: (mode: 'enabled' | 'disabled') => boolean;
  __gpuBrushNoReadbackPilot?: () => boolean;
  __gpuBrushNoReadbackPilotSet?: (enabled: boolean) => boolean;
  __strokeCaptureReplay?: (capture?: unknown) => Promise<unknown>;
  __canvasClearLayer?: () => void;
  showOpenFilePicker?: () => Promise<Array<{ getFile: () => Promise<File> }>>;
};

function getLatestResultNode(resultName: string): HTMLElement {
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
    delete (window as TestWindow).__strokeCaptureReplay;
    delete (window as TestWindow).__canvasClearLayer;
    delete (window as TestWindow).showOpenFilePicker;
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

    (window as TestWindow).showOpenFilePicker = vi.fn(async () => [
      {
        getFile: async () =>
          ({
            name: 'case-5000-04.json',
            text: async () =>
              JSON.stringify({
                version: 1,
                createdAt: new Date().toISOString(),
                metadata: {},
                samples: [],
              }),
          }) as File,
      },
    ]);

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);

    await user.click(screen.getByRole('button', { name: 'Run Phase6A Auto Gate' }));

    await waitFor(() => {
      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(clearLayerSpy).toHaveBeenCalledTimes(3);
      expect(replaySpy).toHaveBeenCalledTimes(3);
    });
    expectLatestResultStatus('Phase6A Auto Gate', 'passed');
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

    (window as TestWindow).showOpenFilePicker = vi.fn(async () => [
      {
        getFile: async () =>
          ({
            name: 'case-5000-04.json',
            text: async () =>
              JSON.stringify({
                version: 1,
                createdAt: new Date().toISOString(),
                metadata: {},
                samples: [],
              }),
          }) as File,
      },
    ]);

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

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 1,
        createdAt: new Date().toISOString(),
        metadata: {},
        samples: [{ type: 'pointerdown', timeMs: 0 }],
      }),
    } as unknown as Response);

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

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 1,
        createdAt: new Date().toISOString(),
        metadata: {},
        samples: [{ type: 'pointerdown', timeMs: 0 }],
      }),
    } as unknown as Response);

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

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 1,
        createdAt: new Date().toISOString(),
        metadata: {},
        samples: [{ type: 'pointerdown', timeMs: 0 }],
      }),
    } as unknown as Response);

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
});
