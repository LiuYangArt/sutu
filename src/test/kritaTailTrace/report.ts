import type { KritaTailTrace } from './types';
import type { KritaTailGateResult } from './compare';

export interface KritaTailReport {
  caseId: string;
  strokeId: string;
  passed: boolean;
  failures: string[];
  warnings: string[];
  metrics: KritaTailGateResult['metrics'];
}

export interface KritaTailStageDiffRow {
  stage: 'pressure_mapped' | 'sampler_t' | 'dab_emit';
  key: string;
  metric: string;
  sutu: number;
  krita: number;
  delta: number;
  note?: string;
}

export function buildKritaTailReport(
  sutuTrace: KritaTailTrace,
  gateResult: KritaTailGateResult
): KritaTailReport {
  return {
    caseId: sutuTrace.meta.caseId,
    strokeId: sutuTrace.strokeId,
    passed: gateResult.passed,
    failures: gateResult.failures,
    warnings: gateResult.warnings,
    metrics: gateResult.metrics,
  };
}

export function stageDiffRowsToCsv(rows: KritaTailStageDiffRow[]): string {
  const header = ['stage', 'key', 'metric', 'sutu', 'krita', 'delta', 'note'].join(',');
  const lines = rows.map((row) =>
    [
      row.stage,
      row.key,
      row.metric,
      row.sutu.toFixed(6),
      row.krita.toFixed(6),
      row.delta.toFixed(6),
      row.note ?? '',
    ].join(',')
  );
  return [header, ...lines].join('\n');
}
