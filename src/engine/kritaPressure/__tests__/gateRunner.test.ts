import { describe, expect, it } from 'vitest';
import type { StrokeCaptureData } from '@/test/StrokeCapture';
import { runKritaPressureGate } from '../testing/gateRunner';

function createCapture(): StrokeCaptureData {
  return {
    version: 1,
    createdAt: new Date('2026-02-18T00:00:00.000Z').toISOString(),
    metadata: {
      canvasWidth: 1024,
      canvasHeight: 1024,
      viewportScale: 1,
      tool: {
        currentTool: 'brush',
        brushSize: 24,
        brushSpacing: 0.1,
        buildupEnabled: false,
      },
    },
    samples: [
      {
        type: 'pointerdown',
        timeMs: 0,
        x: 100,
        y: 100,
        pressure: 0.15,
        tiltX: 0,
        tiltY: 0,
        pointerType: 'pen',
        pointerId: 1,
        buttons: 1,
      },
      {
        type: 'pointermove',
        timeMs: 4,
        x: 110,
        y: 115,
        pressure: 0.28,
        tiltX: 1,
        tiltY: 0,
        pointerType: 'pen',
        pointerId: 1,
        buttons: 1,
      },
      {
        type: 'pointermove',
        timeMs: 8,
        x: 130,
        y: 150,
        pressure: 0.62,
        tiltX: 2,
        tiltY: 1,
        pointerType: 'pen',
        pointerId: 1,
        buttons: 1,
      },
      {
        type: 'pointermove',
        timeMs: 13,
        x: 150,
        y: 210,
        pressure: 0.5,
        tiltX: 3,
        tiltY: 1,
        pointerType: 'pen',
        pointerId: 1,
        buttons: 1,
      },
      {
        type: 'pointermove',
        timeMs: 18,
        x: 160,
        y: 260,
        pressure: 0.2,
        tiltX: 2,
        tiltY: 0,
        pointerType: 'pen',
        pointerId: 1,
        buttons: 1,
      },
      {
        type: 'pointerup',
        timeMs: 22,
        x: 162,
        y: 280,
        pressure: 0,
        tiltX: 0,
        tiltY: 0,
        pointerType: 'pen',
        pointerId: 1,
        buttons: 0,
      },
    ],
  };
}

describe('runKritaPressureGate', () => {
  it('outputs case and preset artifacts', () => {
    const result = runKritaPressureGate(createCapture(), {
      baseline_version: 'krita-5.2-default-wintab',
    });

    expect(result.case_results.length).toBe(8);
    expect(result.preset_results.length).toBe(5);
    expect(result.summary.case_total).toBe(8);
    expect(result.summary.preset_total).toBe(5);
    expect(result.semantic_checks.disable_pressure_bridge_matches_contract).toBe('pass');
  });

  it('keeps deterministic metrics for same input', () => {
    const capture = createCapture();
    const left = runKritaPressureGate(capture, {
      baseline_version: 'krita-5.2-default-wintab',
    });
    const right = runKritaPressureGate(capture, {
      baseline_version: 'krita-5.2-default-wintab',
    });

    expect(left.stage_metrics).toEqual(right.stage_metrics);
    expect(left.final_metrics).toEqual(right.final_metrics);
    expect(left.fast_windows_metrics).toEqual(right.fast_windows_metrics);
    expect(left.case_results).toEqual(right.case_results);
    expect(left.preset_results).toEqual(right.preset_results);
  });
});
