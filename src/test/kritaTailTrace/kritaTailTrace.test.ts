import { describe, expect, it } from 'vitest';
import { validateKritaTailTrace, isKritaTailTrace } from './schema';
import { compareKritaTailTrace, type KritaTailThresholds } from './compare';
import { buildKritaTailReport, stageDiffRowsToCsv } from './report';
import {
  KRITA_TAIL_TRACE_SCHEMA_VERSION,
  type KritaTailTrace,
  type KritaTailTraceMeta,
} from './types';

const baseMeta: KritaTailTraceMeta = {
  caseId: 'unit_case',
  canvas: {
    width: 1024,
    height: 768,
    dpi: 72,
  },
  brushPreset: 'unit-brush',
  inputBackend: 'windows_winink_pointer',
  runtimeFlags: {
    trajectorySmoothingEnabled: false,
    speedIsolationEnabled: true,
    pressureHeuristicsEnabled: false,
  },
  build: {
    appCommit: 'test',
    kritaCommit: 'test',
    platform: 'unit',
    inputBackend: 'windows_winink_pointer',
  },
};

function createTrace(strokeId: string): KritaTailTrace {
  return {
    schemaVersion: KRITA_TAIL_TRACE_SCHEMA_VERSION,
    strokeId,
    meta: baseMeta,
    stages: {
      input_raw: [
        {
          seq: 1,
          seqSource: 'native',
          timestampMs: 0,
          x: 10,
          y: 10,
          pressureRaw: 0.7,
          phase: 'down',
        },
        {
          seq: 2,
          seqSource: 'native',
          timestampMs: 16,
          x: 20,
          y: 20,
          pressureRaw: 0.4,
          phase: 'move',
        },
        {
          seq: 3,
          seqSource: 'fallback',
          timestampMs: 32,
          x: 30,
          y: 30,
          pressureRaw: 0.1,
          phase: 'up',
        },
      ],
      pressure_mapped: [
        {
          seq: 1,
          pressureAfterGlobalCurve: 0.7,
          pressureAfterBrushCurve: 0.7,
          pressureAfterHeuristic: 0.7,
          speedPxPerMs: 0,
          normalizedSpeed: 0,
        },
        {
          seq: 2,
          pressureAfterGlobalCurve: 0.4,
          pressureAfterBrushCurve: 0.4,
          pressureAfterHeuristic: 0.4,
          speedPxPerMs: 0.7,
          normalizedSpeed: 0.03,
        },
        {
          seq: 3,
          pressureAfterGlobalCurve: 0.1,
          pressureAfterBrushCurve: 0.1,
          pressureAfterHeuristic: 0.1,
          speedPxPerMs: 0.2,
          normalizedSpeed: 0.01,
        },
      ],
      sampler_t: [
        {
          segmentId: 0,
          segmentStartSeq: 1,
          segmentEndSeq: 2,
          sampleIndex: 0,
          t: 0.5,
          triggerKind: 'distance',
          distanceCarryBefore: 0,
          distanceCarryAfter: 0.4,
          timeCarryBefore: 0,
          timeCarryAfter: 6,
        },
        {
          segmentId: 1,
          segmentStartSeq: 2,
          segmentEndSeq: 3,
          sampleIndex: 0,
          t: 0.5,
          triggerKind: 'time',
          distanceCarryBefore: 0.4,
          distanceCarryAfter: 0.6,
          timeCarryBefore: 6,
          timeCarryAfter: 2,
        },
      ],
      dab_emit: [
        {
          dabIndex: 0,
          segmentId: 0,
          sampleIndex: 0,
          x: 15,
          y: 15,
          pressure: 0.58,
          spacingUsedPx: 3.6,
          timestampMs: 8,
          source: 'normal',
          fallbackPressurePolicy: 'none',
        },
        {
          dabIndex: 1,
          segmentId: 1,
          sampleIndex: 0,
          x: 25,
          y: 25,
          pressure: 0.08,
          spacingUsedPx: 3.5,
          timestampMs: 24,
          source: 'pointerup_fallback',
          fallbackPressurePolicy: 'last_nonzero',
        },
      ],
    },
  };
}

const strictThresholds: KritaTailThresholds = {
  pressure_tail_mae: 0.02,
  pressure_tail_p95: 0.04,
  sampler_t_emd: 0.08,
  sampler_t_missing_ratio: 0.05,
  dab_tail_count_delta: 1,
  dab_tail_mean_spacing_delta_px: 0.8,
  dab_tail_pressure_slope_delta: 0.08,
  terminal_sample_drop_count: 0,
};

describe('kritaTailTrace schema and compare', () => {
  it('accepts valid trace payload', () => {
    const trace = createTrace('stroke-valid');
    const errors = validateKritaTailTrace(trace);
    expect(errors).toEqual([]);
    expect(isKritaTailTrace(trace)).toBe(true);
  });

  it('rejects invalid stage field type', () => {
    const trace = createTrace('stroke-invalid') as unknown as Record<string, unknown>;
    const stage = (trace.stages as Record<string, unknown>).input_raw as Array<
      Record<string, unknown>
    >;
    stage[0]!.seqSource = 'unexpected';
    const errors = validateKritaTailTrace(trace);
    expect(errors.some((item) => item.includes('seqSource'))).toBe(true);
  });

  it('compares identical traces as pass', () => {
    const sutu = createTrace('stroke-a');
    const krita = createTrace('stroke-b');
    const result = compareKritaTailTrace(sutu, krita, strictThresholds);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('reports speed warning without failing gate', () => {
    const sutu = createTrace('stroke-sutu');
    const krita = createTrace('stroke-krita');
    krita.stages.pressure_mapped = krita.stages.pressure_mapped.map((sample) => ({
      ...sample,
      normalizedSpeed: sample.normalizedSpeed + 0.4,
    }));
    const result = compareKritaTailTrace(sutu, krita, strictThresholds);
    expect(result.passed).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('kritaTailTrace report helpers', () => {
  it('builds report and exports csv rows', () => {
    const trace = createTrace('stroke-report');
    const gateResult = compareKritaTailTrace(trace, trace, strictThresholds);
    const report = buildKritaTailReport(trace, gateResult);
    expect(report.caseId).toBe('unit_case');
    const csv = stageDiffRowsToCsv([
      {
        stage: 'pressure_mapped',
        key: 'seq:1',
        metric: 'pressureAfterHeuristic',
        sutu: 0.6,
        krita: 0.55,
        delta: 0.05,
      },
    ]);
    expect(csv.startsWith('stage,key,metric')).toBe(true);
    expect(csv.includes('seq:1')).toBe(true);
  });
});
