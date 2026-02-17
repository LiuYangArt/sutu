import {
  KRITA_TAIL_TRACE_SCHEMA_VERSION,
  type KritaTailTrace,
  type KritaTailTracePhase,
  type KritaTailDabSource,
  type KritaTailSamplerTriggerKind,
  type KritaTailSeqSource,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPhase(value: unknown): value is KritaTailTracePhase {
  return value === 'down' || value === 'move' || value === 'up';
}

function isSeqSource(value: unknown): value is KritaTailSeqSource {
  return value === 'native' || value === 'fallback';
}

function isTriggerKind(value: unknown): value is KritaTailSamplerTriggerKind {
  return value === 'distance' || value === 'time';
}

function isDabSource(value: unknown): value is KritaTailDabSource {
  return value === 'normal' || value === 'finalize' || value === 'pointerup_fallback';
}

export function validateKritaTailTrace(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ['trace must be an object'];
  }

  if (value.schemaVersion !== KRITA_TAIL_TRACE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${KRITA_TAIL_TRACE_SCHEMA_VERSION}`);
  }
  if (typeof value.strokeId !== 'string' || value.strokeId.length === 0) {
    errors.push('strokeId must be non-empty string');
  }

  if (!isRecord(value.meta)) {
    errors.push('meta must be object');
  }

  if (!isRecord(value.stages)) {
    errors.push('stages must be object');
    return errors;
  }

  const inputRaw = value.stages.input_raw;
  if (!Array.isArray(inputRaw)) {
    errors.push('stages.input_raw must be array');
  } else {
    inputRaw.forEach((sample, index) => {
      if (!isRecord(sample)) {
        errors.push(`input_raw[${index}] must be object`);
        return;
      }
      if (!Number.isInteger(sample.seq)) errors.push(`input_raw[${index}].seq must be int`);
      if (sample.seqSource !== undefined && !isSeqSource(sample.seqSource))
        errors.push(`input_raw[${index}].seqSource invalid`);
      if (!isFiniteNumber(sample.timestampMs))
        errors.push(`input_raw[${index}].timestampMs must be number`);
      if (!isFiniteNumber(sample.x)) errors.push(`input_raw[${index}].x must be number`);
      if (!isFiniteNumber(sample.y)) errors.push(`input_raw[${index}].y must be number`);
      if (!isFiniteNumber(sample.pressureRaw))
        errors.push(`input_raw[${index}].pressureRaw must be number`);
      if (!isPhase(sample.phase)) errors.push(`input_raw[${index}].phase invalid`);
    });
  }

  const pressureMapped = value.stages.pressure_mapped;
  if (!Array.isArray(pressureMapped)) {
    errors.push('stages.pressure_mapped must be array');
  } else {
    pressureMapped.forEach((sample, index) => {
      if (!isRecord(sample)) {
        errors.push(`pressure_mapped[${index}] must be object`);
        return;
      }
      if (!Number.isInteger(sample.seq)) errors.push(`pressure_mapped[${index}].seq must be int`);
      if (!isFiniteNumber(sample.pressureAfterGlobalCurve))
        errors.push(`pressure_mapped[${index}].pressureAfterGlobalCurve must be number`);
      if (!isFiniteNumber(sample.pressureAfterBrushCurve))
        errors.push(`pressure_mapped[${index}].pressureAfterBrushCurve must be number`);
      if (!isFiniteNumber(sample.pressureAfterHeuristic))
        errors.push(`pressure_mapped[${index}].pressureAfterHeuristic must be number`);
      if (!isFiniteNumber(sample.speedPxPerMs))
        errors.push(`pressure_mapped[${index}].speedPxPerMs must be number`);
      if (!isFiniteNumber(sample.normalizedSpeed))
        errors.push(`pressure_mapped[${index}].normalizedSpeed must be number`);
    });
  }

  const sampler = value.stages.sampler_t;
  if (!Array.isArray(sampler)) {
    errors.push('stages.sampler_t must be array');
  } else {
    sampler.forEach((sample, index) => {
      if (!isRecord(sample)) {
        errors.push(`sampler_t[${index}] must be object`);
        return;
      }
      if (!Number.isInteger(sample.segmentId))
        errors.push(`sampler_t[${index}].segmentId must be int`);
      if (!Number.isInteger(sample.segmentStartSeq))
        errors.push(`sampler_t[${index}].segmentStartSeq must be int`);
      if (!Number.isInteger(sample.segmentEndSeq))
        errors.push(`sampler_t[${index}].segmentEndSeq must be int`);
      if (!Number.isInteger(sample.sampleIndex))
        errors.push(`sampler_t[${index}].sampleIndex must be int`);
      if (!isFiniteNumber(sample.t)) errors.push(`sampler_t[${index}].t must be number`);
      if (!isTriggerKind(sample.triggerKind))
        errors.push(`sampler_t[${index}].triggerKind invalid`);
    });
  }

  const dabs = value.stages.dab_emit;
  if (!Array.isArray(dabs)) {
    errors.push('stages.dab_emit must be array');
  } else {
    dabs.forEach((sample, index) => {
      if (!isRecord(sample)) {
        errors.push(`dab_emit[${index}] must be object`);
        return;
      }
      if (!Number.isInteger(sample.dabIndex))
        errors.push(`dab_emit[${index}].dabIndex must be int`);
      if (!Number.isInteger(sample.segmentId))
        errors.push(`dab_emit[${index}].segmentId must be int`);
      if (!Number.isInteger(sample.sampleIndex))
        errors.push(`dab_emit[${index}].sampleIndex must be int`);
      if (!isFiniteNumber(sample.x)) errors.push(`dab_emit[${index}].x must be number`);
      if (!isFiniteNumber(sample.y)) errors.push(`dab_emit[${index}].y must be number`);
      if (!isFiniteNumber(sample.pressure))
        errors.push(`dab_emit[${index}].pressure must be number`);
      if (!isFiniteNumber(sample.spacingUsedPx))
        errors.push(`dab_emit[${index}].spacingUsedPx must be number`);
      if (!isFiniteNumber(sample.timestampMs))
        errors.push(`dab_emit[${index}].timestampMs must be number`);
      if (!isDabSource(sample.source)) errors.push(`dab_emit[${index}].source invalid`);
    });
  }

  return errors;
}

export function isKritaTailTrace(value: unknown): value is KritaTailTrace {
  return validateKritaTailTrace(value).length === 0;
}
