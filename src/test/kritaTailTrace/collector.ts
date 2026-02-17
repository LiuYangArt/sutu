import {
  KRITA_TAIL_TRACE_SCHEMA_VERSION,
  type KritaTailDabEmitSample,
  type KritaTailInputRawSample,
  type KritaTailPressureMappedSample,
  type KritaTailSamplerSample,
  type KritaTailTrace,
  type KritaTailTraceStartOptions,
} from './types';

type MutableTrace = {
  strokeId: string;
  meta: KritaTailTrace['meta'];
  inputRaw: KritaTailInputRawSample[];
  pressureBySeq: Map<number, KritaTailPressureMappedSample>;
  sampler: KritaTailSamplerSample[];
  dabs: KritaTailDabEmitSample[];
  nextDabIndex: number;
};

function toFiniteNumber(value: number, fallback: number = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function nowStrokeId(): string {
  return `stroke-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

class KritaTailTraceCollector {
  private active: MutableTrace | null = null;
  private last: KritaTailTrace | null = null;

  start(options: KritaTailTraceStartOptions): KritaTailTrace {
    const strokeId = options.strokeId?.trim() || nowStrokeId();
    this.active = {
      strokeId,
      meta: options.meta,
      inputRaw: [],
      pressureBySeq: new Map<number, KritaTailPressureMappedSample>(),
      sampler: [],
      dabs: [],
      nextDabIndex: 0,
    };
    const trace = this.snapshotCurrent();
    this.last = trace;
    return trace;
  }

  stop(): KritaTailTrace | null {
    if (!this.active) {
      return this.last;
    }
    const trace = this.snapshotCurrent();
    this.last = trace;
    this.active = null;
    return trace;
  }

  getLast(): KritaTailTrace | null {
    return this.last;
  }

  isActive(): boolean {
    return this.active !== null;
  }

  pushInputRaw(sample: KritaTailInputRawSample): void {
    const state = this.active;
    if (!state) return;
    if (!Number.isInteger(sample.seq)) return;
    state.inputRaw.push({
      seq: sample.seq,
      seqSource: sample.seqSource,
      timestampMs: toFiniteNumber(sample.timestampMs),
      x: toFiniteNumber(sample.x),
      y: toFiniteNumber(sample.y),
      pressureRaw: clamp01(sample.pressureRaw),
      phase: sample.phase,
    });
  }

  pushPressureMapped(sample: KritaTailPressureMappedSample): void {
    const state = this.active;
    if (!state) return;
    if (!Number.isInteger(sample.seq)) return;
    const prev = state.pressureBySeq.get(sample.seq);
    state.pressureBySeq.set(sample.seq, {
      seq: sample.seq,
      pressureAfterGlobalCurve: clamp01(
        sample.pressureAfterGlobalCurve ?? prev?.pressureAfterGlobalCurve ?? 0
      ),
      pressureAfterBrushCurve: clamp01(
        sample.pressureAfterBrushCurve ?? prev?.pressureAfterBrushCurve ?? 0
      ),
      pressureAfterHeuristic: clamp01(
        sample.pressureAfterHeuristic ?? prev?.pressureAfterHeuristic ?? 0
      ),
      speedPxPerMs: toFiniteNumber(sample.speedPxPerMs ?? prev?.speedPxPerMs ?? 0),
      normalizedSpeed: clamp01(sample.normalizedSpeed ?? prev?.normalizedSpeed ?? 0),
    });
  }

  pushSampler(sample: KritaTailSamplerSample): void {
    const state = this.active;
    if (!state) return;
    state.sampler.push({
      segmentId: Number.isInteger(sample.segmentId) ? sample.segmentId : -1,
      segmentStartSeq: Number.isInteger(sample.segmentStartSeq) ? sample.segmentStartSeq : -1,
      segmentEndSeq: Number.isInteger(sample.segmentEndSeq) ? sample.segmentEndSeq : -1,
      sampleIndex: Number.isInteger(sample.sampleIndex) ? sample.sampleIndex : -1,
      t: clamp01(sample.t),
      triggerKind: sample.triggerKind,
      distanceCarryBefore: Math.max(0, toFiniteNumber(sample.distanceCarryBefore)),
      distanceCarryAfter: Math.max(0, toFiniteNumber(sample.distanceCarryAfter)),
      timeCarryBefore: Math.max(0, toFiniteNumber(sample.timeCarryBefore)),
      timeCarryAfter: Math.max(0, toFiniteNumber(sample.timeCarryAfter)),
    });
  }

  pushDab(sample: Omit<KritaTailDabEmitSample, 'dabIndex'> & { dabIndex?: number }): void {
    const state = this.active;
    if (!state) return;
    const dabIndex = Number.isInteger(sample.dabIndex) ? sample.dabIndex! : state.nextDabIndex;
    state.nextDabIndex = Math.max(state.nextDabIndex, dabIndex + 1);
    state.dabs.push({
      dabIndex,
      segmentId: Number.isInteger(sample.segmentId) ? sample.segmentId : -1,
      sampleIndex: Number.isInteger(sample.sampleIndex) ? sample.sampleIndex : -1,
      x: toFiniteNumber(sample.x),
      y: toFiniteNumber(sample.y),
      pressure: clamp01(sample.pressure),
      spacingUsedPx: Math.max(0, toFiniteNumber(sample.spacingUsedPx)),
      timestampMs: toFiniteNumber(sample.timestampMs),
      source: sample.source,
    });
  }

  private snapshotCurrent(): KritaTailTrace {
    const state = this.active;
    if (!state) {
      return (
        this.last ?? {
          schemaVersion: KRITA_TAIL_TRACE_SCHEMA_VERSION,
          strokeId: nowStrokeId(),
          meta: {
            caseId: 'unknown',
            canvas: { width: 0, height: 0, dpi: 0 },
            brushPreset: 'unknown',
            runtimeFlags: {},
            build: {
              appCommit: 'unknown',
              kritaCommit: 'unknown',
              platform: 'unknown',
              inputBackend: 'unknown',
            },
          },
          stages: {
            input_raw: [],
            pressure_mapped: [],
            sampler_t: [],
            dab_emit: [],
          },
        }
      );
    }

    const pressureMapped = [...state.pressureBySeq.values()].sort((a, b) => a.seq - b.seq);
    const inputRaw = [...state.inputRaw].sort((a, b) => a.seq - b.seq);
    const sampler = [...state.sampler].sort((a, b) => {
      if (a.segmentId !== b.segmentId) return a.segmentId - b.segmentId;
      return a.sampleIndex - b.sampleIndex;
    });
    const dabs = [...state.dabs].sort((a, b) => a.dabIndex - b.dabIndex);

    return {
      schemaVersion: KRITA_TAIL_TRACE_SCHEMA_VERSION,
      strokeId: state.strokeId,
      meta: state.meta,
      stages: {
        input_raw: inputRaw,
        pressure_mapped: pressureMapped,
        sampler_t: sampler,
        dab_emit: dabs,
      },
    };
  }
}

const collector = new KritaTailTraceCollector();

export function startKritaTailTraceSession(options: KritaTailTraceStartOptions): KritaTailTrace {
  return collector.start(options);
}

export function stopKritaTailTraceSession(): KritaTailTrace | null {
  return collector.stop();
}

export function getLastKritaTailTrace(): KritaTailTrace | null {
  return collector.getLast();
}

export function isKritaTailTraceSessionActive(): boolean {
  return collector.isActive();
}

export function recordKritaTailInputRaw(sample: KritaTailInputRawSample): void {
  collector.pushInputRaw(sample);
}

export function recordKritaTailPressureMapped(sample: KritaTailPressureMappedSample): void {
  collector.pushPressureMapped(sample);
}

export function recordKritaTailSampler(sample: KritaTailSamplerSample): void {
  collector.pushSampler(sample);
}

export function recordKritaTailDabEmit(
  sample: Omit<KritaTailDabEmitSample, 'dabIndex'> & { dabIndex?: number }
): void {
  collector.pushDab(sample);
}
