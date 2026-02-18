export type KritaPressureShadowStageKey =
  | 'input'
  | 'global_curve'
  | 'speed'
  | 'sampling'
  | 'mix'
  | 'sensor'
  | 'final_dab';

const STAGE_KEYS: KritaPressureShadowStageKey[] = [
  'input',
  'global_curve',
  'speed',
  'sampling',
  'mix',
  'sensor',
  'final_dab',
];

export interface KritaPressurePipelineMode {
  pressurePipelineV2Primary: boolean;
  pressurePipelineV2Shadow: boolean;
  stageDiffLogEnabled: boolean;
  maxRecentEntries: number;
}

export interface KritaPressureShadowDiffEntry {
  timestamp_ms: number;
  source: 'wintab' | 'macnative' | 'pointerevent';
  phase: 'down' | 'move' | 'up' | 'hover';
  stage: Partial<Record<KritaPressureShadowStageKey, number>>;
}

export interface KritaPressureShadowStageSummary {
  count: number;
  abs_mae: number;
  abs_max: number;
}

export interface KritaPressureShadowDiffSnapshot {
  mode: KritaPressurePipelineMode;
  total_samples: number;
  stage: Record<KritaPressureShadowStageKey, KritaPressureShadowStageSummary>;
  recent: KritaPressureShadowDiffEntry[];
}

interface StageAccumulator {
  count: number;
  absSum: number;
  absMax: number;
}

const runtimeModeState: KritaPressurePipelineMode = {
  pressurePipelineV2Primary: true,
  pressurePipelineV2Shadow: false,
  stageDiffLogEnabled: true,
  maxRecentEntries: 200,
};

let totalSamples = 0;
const recentEntries: KritaPressureShadowDiffEntry[] = [];
const stageAccumulators: Record<KritaPressureShadowStageKey, StageAccumulator> = {
  input: { count: 0, absSum: 0, absMax: 0 },
  global_curve: { count: 0, absSum: 0, absMax: 0 },
  speed: { count: 0, absSum: 0, absMax: 0 },
  sampling: { count: 0, absSum: 0, absMax: 0 },
  mix: { count: 0, absSum: 0, absMax: 0 },
  sensor: { count: 0, absSum: 0, absMax: 0 },
  final_dab: { count: 0, absSum: 0, absMax: 0 },
};

function normalizeMaxRecentEntries(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return runtimeModeState.maxRecentEntries;
  return Math.max(0, Math.min(10_000, Math.round(value)));
}

function toSummary(acc: StageAccumulator): KritaPressureShadowStageSummary {
  return {
    count: acc.count,
    abs_mae: acc.count > 0 ? acc.absSum / acc.count : 0,
    abs_max: acc.absMax,
  };
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function trimRecentEntries(): void {
  const keep = runtimeModeState.maxRecentEntries;
  if (keep <= 0) {
    recentEntries.length = 0;
    return;
  }
  if (recentEntries.length <= keep) return;
  recentEntries.splice(0, recentEntries.length - keep);
}

function updateStageAccumulator(stage: KritaPressureShadowStageKey, delta: number): void {
  const acc = stageAccumulators[stage];
  if (!acc) return;
  const absDelta = Math.abs(delta);
  acc.count += 1;
  acc.absSum += absDelta;
  if (absDelta > acc.absMax) {
    acc.absMax = absDelta;
  }
}

export function getKritaPressurePipelineMode(): KritaPressurePipelineMode {
  return { ...runtimeModeState };
}

export function updateKritaPressurePipelineMode(
  patch: Partial<KritaPressurePipelineMode>
): KritaPressurePipelineMode {
  if (typeof patch.pressurePipelineV2Primary === 'boolean') {
    // Full rebuild mode: production path is permanently V2 primary.
    runtimeModeState.pressurePipelineV2Primary = true;
  }
  if (typeof patch.pressurePipelineV2Shadow === 'boolean') {
    runtimeModeState.pressurePipelineV2Shadow = patch.pressurePipelineV2Shadow;
  }
  if (typeof patch.stageDiffLogEnabled === 'boolean') {
    runtimeModeState.stageDiffLogEnabled = patch.stageDiffLogEnabled;
  }
  if (typeof patch.maxRecentEntries !== 'undefined') {
    runtimeModeState.maxRecentEntries = normalizeMaxRecentEntries(patch.maxRecentEntries);
    trimRecentEntries();
  }
  return getKritaPressurePipelineMode();
}

export function resetKritaPressureShadowDiff(): void {
  totalSamples = 0;
  recentEntries.length = 0;
  for (const stage of STAGE_KEYS) {
    stageAccumulators[stage] = { count: 0, absSum: 0, absMax: 0 };
  }
}

export function recordKritaPressureShadowDiff(entry: KritaPressureShadowDiffEntry): void {
  totalSamples += 1;

  for (const stage of STAGE_KEYS) {
    const value = normalizeNumber(entry.stage[stage]);
    if (value === null) continue;
    updateStageAccumulator(stage, value);
  }

  if (!runtimeModeState.stageDiffLogEnabled || runtimeModeState.maxRecentEntries <= 0) {
    return;
  }

  const stageRecord: Partial<Record<KritaPressureShadowStageKey, number>> = {};
  for (const stage of STAGE_KEYS) {
    const value = normalizeNumber(entry.stage[stage]);
    if (value === null) continue;
    stageRecord[stage] = value;
  }

  recentEntries.push({
    timestamp_ms: entry.timestamp_ms,
    source: entry.source,
    phase: entry.phase,
    stage: stageRecord,
  });
  trimRecentEntries();
}

export function getKritaPressureShadowDiffSnapshot(options?: {
  recentLimit?: number;
}): KritaPressureShadowDiffSnapshot {
  const stage: Record<KritaPressureShadowStageKey, KritaPressureShadowStageSummary> = {
    input: toSummary(stageAccumulators.input),
    global_curve: toSummary(stageAccumulators.global_curve),
    speed: toSummary(stageAccumulators.speed),
    sampling: toSummary(stageAccumulators.sampling),
    mix: toSummary(stageAccumulators.mix),
    sensor: toSummary(stageAccumulators.sensor),
    final_dab: toSummary(stageAccumulators.final_dab),
  };

  const recentLimit = normalizeMaxRecentEntries(options?.recentLimit);
  const recent =
    recentLimit > 0 ? recentEntries.slice(Math.max(0, recentEntries.length - recentLimit)) : [];

  return {
    mode: getKritaPressurePipelineMode(),
    total_samples: totalSamples,
    stage,
    recent,
  };
}
