import type {
  KritaTailDabEmitSample,
  KritaTailPressureMappedSample,
  KritaTailSamplerSample,
  KritaTailTrace,
} from './types';

export interface KritaTailThresholds {
  pressure_tail_mae: number;
  pressure_tail_p95: number;
  sampler_t_emd: number;
  sampler_t_missing_ratio: number;
  dab_tail_count_delta: number;
  dab_tail_mean_spacing_delta_px: number;
  dab_tail_pressure_slope_delta: number;
  terminal_sample_drop_count: number;
}

export interface KritaTailSpeedMetrics {
  speedPxPerMs_mae: number;
  normalizedSpeed_mae: number;
  normalizedSpeed_p95: number;
}

export interface KritaTailMetrics {
  pressure_tail_mae: number;
  pressure_tail_p95: number;
  sampler_t_emd: number;
  sampler_t_missing_ratio: number;
  dab_tail_count_delta: number;
  dab_tail_mean_spacing_delta_px: number;
  dab_tail_pressure_slope_delta: number;
  terminal_sample_drop_count: number;
  speed: KritaTailSpeedMetrics;
}

export interface KritaTailGateResult {
  passed: boolean;
  failures: string[];
  warnings: string[];
  metrics: KritaTailMetrics;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[idx] ?? 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function calcMeanSpacing(dabs: KritaTailDabEmitSample[]): number {
  if (dabs.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < dabs.length; i += 1) {
    const prev = dabs[i - 1]!;
    const curr = dabs[i]!;
    gaps.push(Math.hypot(curr.x - prev.x, curr.y - prev.y));
  }
  return mean(gaps);
}

function calcPressureSlope(dabs: KritaTailDabEmitSample[]): number {
  if (dabs.length < 2) return 0;
  const n = dabs.length;
  const xs = dabs.map((_, index) => index);
  const ys = dabs.map((item) => item.pressure);
  const xMean = mean(xs);
  const yMean = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - xMean;
    num += dx * (ys[i]! - yMean);
    den += dx * dx;
  }
  return den > 0 ? num / den : 0;
}

function calcTailStartByArc(dabs: KritaTailDabEmitSample[]): number {
  if (dabs.length <= 1) return 0;
  const cumulative: number[] = [0];
  for (let i = 1; i < dabs.length; i += 1) {
    const prev = dabs[i - 1]!;
    const curr = dabs[i]!;
    cumulative.push(cumulative[i - 1]! + Math.hypot(curr.x - prev.x, curr.y - prev.y));
  }
  const total = cumulative[cumulative.length - 1] ?? 0;
  const threshold = total * 0.85;
  const idx = cumulative.findIndex((value) => value >= threshold);
  return idx < 0 ? 0 : idx;
}

function getTailSlice(dabs: KritaTailDabEmitSample[]): KritaTailDabEmitSample[] {
  if (dabs.length === 0) return [];
  const last20Start = Math.max(0, dabs.length - 20);
  const arcStart = calcTailStartByArc(dabs);
  const start = Math.min(last20Start, arcStart);
  return dabs.slice(start);
}

function normalizeQuantile(values: number[], n: number): number[] {
  if (values.length === 0) return new Array(n).fill(0);
  const sorted = [...values].sort((a, b) => a - b);
  if (n <= 1) return [sorted[0] ?? 0];
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const ratio = i / (n - 1);
    const idx = Math.round(ratio * (sorted.length - 1));
    out.push(sorted[idx] ?? 0);
  }
  return out;
}

function calcTEmd(sutu: KritaTailSamplerSample[], krita: KritaTailSamplerSample[]): number {
  if (sutu.length === 0 && krita.length === 0) return 0;
  const n = Math.max(2, sutu.length, krita.length);
  const a = normalizeQuantile(
    sutu.map((item) => item.t),
    n
  );
  const b = normalizeQuantile(
    krita.map((item) => item.t),
    n
  );
  const abs = a.map((value, index) => Math.abs(value - (b[index] ?? 0)));
  return mean(abs);
}

function calcSamplerMissingRatio(
  sutu: KritaTailSamplerSample[],
  krita: KritaTailSamplerSample[]
): number {
  const keyOf = (item: KritaTailSamplerSample) => `${item.segmentId}:${item.sampleIndex}`;
  const sutuKeys = new Set(sutu.map(keyOf));
  const kritaKeys = new Set(krita.map(keyOf));
  let mismatch = 0;
  for (const key of sutuKeys) {
    if (!kritaKeys.has(key)) mismatch += 1;
  }
  for (const key of kritaKeys) {
    if (!sutuKeys.has(key)) mismatch += 1;
  }
  const denom = Math.max(1, sutu.length, krita.length);
  return mismatch / denom;
}

function alignPressure(
  sutu: KritaTailPressureMappedSample[],
  krita: KritaTailPressureMappedSample[]
): Array<{ sutu: KritaTailPressureMappedSample; krita: KritaTailPressureMappedSample }> {
  const kritaBySeq = new Map(krita.map((item) => [item.seq, item]));
  const aligned: Array<{
    sutu: KritaTailPressureMappedSample;
    krita: KritaTailPressureMappedSample;
  }> = [];
  for (const sample of sutu) {
    const other = kritaBySeq.get(sample.seq);
    if (!other) continue;
    aligned.push({ sutu: sample, krita: other });
  }
  return aligned;
}

export function compareKritaTailTrace(
  sutuTrace: KritaTailTrace,
  kritaTrace: KritaTailTrace,
  thresholds: KritaTailThresholds
): KritaTailGateResult {
  const sutuTail = getTailSlice(sutuTrace.stages.dab_emit);
  const kritaTail = getTailSlice(kritaTrace.stages.dab_emit);
  const tailLen = Math.min(sutuTail.length, kritaTail.length);
  const pressureDiffs: number[] = [];
  for (let i = 0; i < tailLen; i += 1) {
    pressureDiffs.push(Math.abs((sutuTail[i]?.pressure ?? 0) - (kritaTail[i]?.pressure ?? 0)));
  }

  const pressureTailMae = mean(pressureDiffs);
  const pressureTailP95 = percentile(pressureDiffs, 0.95);
  const samplerEmd = calcTEmd(sutuTrace.stages.sampler_t, kritaTrace.stages.sampler_t);
  const samplerMissingRatio = calcSamplerMissingRatio(
    sutuTrace.stages.sampler_t,
    kritaTrace.stages.sampler_t
  );
  const dabTailCountDelta = Math.abs(sutuTail.length - kritaTail.length);
  const dabTailMeanSpacingDelta = Math.abs(calcMeanSpacing(sutuTail) - calcMeanSpacing(kritaTail));
  const dabTailPressureSlopeDelta = Math.abs(
    calcPressureSlope(sutuTail) - calcPressureSlope(kritaTail)
  );
  const hasTerminalLowPressure = sutuTrace.stages.input_raw
    .slice(-8)
    .some((sample) => sample.pressureRaw <= 0.1 && sample.phase !== 'down');
  const hasTailLowPressureDab = sutuTail.some((sample) => sample.pressure <= 0.12);
  const terminalSampleDropCount = hasTerminalLowPressure && !hasTailLowPressureDab ? 1 : 0;

  const alignedPressure = alignPressure(
    sutuTrace.stages.pressure_mapped,
    kritaTrace.stages.pressure_mapped
  );
  const speedDiffs = alignedPressure.map(({ sutu, krita }) =>
    Math.abs(sutu.speedPxPerMs - krita.speedPxPerMs)
  );
  const normalizedSpeedDiffs = alignedPressure.map(({ sutu, krita }) =>
    Math.abs(sutu.normalizedSpeed - krita.normalizedSpeed)
  );

  const metrics: KritaTailMetrics = {
    pressure_tail_mae: pressureTailMae,
    pressure_tail_p95: pressureTailP95,
    sampler_t_emd: samplerEmd,
    sampler_t_missing_ratio: samplerMissingRatio,
    dab_tail_count_delta: dabTailCountDelta,
    dab_tail_mean_spacing_delta_px: dabTailMeanSpacingDelta,
    dab_tail_pressure_slope_delta: dabTailPressureSlopeDelta,
    terminal_sample_drop_count: terminalSampleDropCount,
    speed: {
      speedPxPerMs_mae: mean(speedDiffs),
      normalizedSpeed_mae: mean(normalizedSpeedDiffs),
      normalizedSpeed_p95: percentile(normalizedSpeedDiffs, 0.95),
    },
  };

  const failures: string[] = [];
  if (metrics.pressure_tail_mae > thresholds.pressure_tail_mae) {
    failures.push('pressure_tail_mae');
  }
  if (metrics.pressure_tail_p95 > thresholds.pressure_tail_p95) {
    failures.push('pressure_tail_p95');
  }
  if (metrics.sampler_t_emd > thresholds.sampler_t_emd) {
    failures.push('sampler_t_emd');
  }
  if (metrics.sampler_t_missing_ratio > thresholds.sampler_t_missing_ratio) {
    failures.push('sampler_t_missing_ratio');
  }
  if (metrics.dab_tail_count_delta > thresholds.dab_tail_count_delta) {
    failures.push('dab_tail_count_delta');
  }
  if (metrics.dab_tail_mean_spacing_delta_px > thresholds.dab_tail_mean_spacing_delta_px) {
    failures.push('dab_tail_mean_spacing_delta_px');
  }
  if (metrics.dab_tail_pressure_slope_delta > thresholds.dab_tail_pressure_slope_delta) {
    failures.push('dab_tail_pressure_slope_delta');
  }
  if (metrics.terminal_sample_drop_count > thresholds.terminal_sample_drop_count) {
    failures.push('terminal_sample_drop_count');
  }

  const warnings: string[] = [];
  if (metrics.speed.normalizedSpeed_mae > 0.15) {
    warnings.push('normalizedSpeed_mae');
  }
  if (metrics.speed.normalizedSpeed_p95 > 0.25) {
    warnings.push('normalizedSpeed_p95');
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
    metrics,
  };
}
