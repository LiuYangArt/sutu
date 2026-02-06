import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DebugPanel } from './index';

describe('DebugPanel', () => {
  beforeEach(() => {
    (
      window as Window & {
        __gpuBrushDiagnosticsReset?: () => boolean;
        __gpuBrushDiagnostics?: () => unknown;
      }
    ).__gpuBrushDiagnosticsReset = vi.fn(() => true);
    (
      window as Window & {
        __gpuBrushDiagnosticsReset?: () => boolean;
        __gpuBrushDiagnostics?: () => unknown;
      }
    ).__gpuBrushDiagnostics = vi.fn(() => ({ diagnosticsSessionId: 2 }));
  });

  afterEach(() => {
    delete (window as Window & { __gpuBrushDiagnosticsReset?: () => boolean })
      .__gpuBrushDiagnosticsReset;
    delete (window as Window & { __gpuBrushDiagnostics?: () => unknown }).__gpuBrushDiagnostics;
  });

  it('calls diagnostics reset from GPU Brush panel button', async () => {
    const user = userEvent.setup();
    const resetSpy = vi.fn(() => true);
    (window as Window & { __gpuBrushDiagnosticsReset?: () => boolean }).__gpuBrushDiagnosticsReset =
      resetSpy;
    (window as Window & { __gpuBrushDiagnostics?: () => unknown }).__gpuBrushDiagnostics = vi.fn(
      () => ({ diagnosticsSessionId: 7 })
    );

    render(<DebugPanel canvas={document.createElement('canvas')} onClose={() => undefined} />);
    const resetButton = screen.getByRole('button', { name: 'Reset GPU Diag' });
    await user.click(resetButton);

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Diagnostics reset OK (session 7)')).toBeInTheDocument();
  });
});
