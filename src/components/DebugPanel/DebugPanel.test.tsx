import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DebugPanel } from './index';

type TestWindow = Window & {
  __gpuBrushDiagnosticsReset?: () => boolean;
  __gpuBrushDiagnostics?: () => unknown;
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
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    delete (window as TestWindow).__gpuBrushDiagnosticsReset;
    delete (window as TestWindow).__gpuBrushDiagnostics;
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
});
