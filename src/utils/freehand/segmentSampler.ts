export interface SegmentSamplerRequest {
  distancePx: number;
  durationMs: number;
  spacingPx: number;
  maxIntervalMs: number;
}

export type SegmentSamplerTriggerKind = 'distance' | 'time';

export interface SegmentSamplerDetailSample {
  sampleIndex: number;
  t: number;
  triggerKind: SegmentSamplerTriggerKind;
  distanceCarryBefore: number;
  distanceCarryAfter: number;
  timeCarryBefore: number;
  timeCarryAfter: number;
}

export interface SegmentSamplerDetailedResult {
  samples: SegmentSamplerDetailSample[];
  distanceCarryBefore: number;
  distanceCarryAfter: number;
  timeCarryBefore: number;
  timeCarryAfter: number;
}

const EPSILON = 1e-6;

function clampPositive(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function normalizeCarry(value: number, step: number): number {
  if (step <= EPSILON) return 0;
  const carry = value % step;
  if (carry < EPSILON || Math.abs(carry - step) < EPSILON) {
    return 0;
  }
  return carry;
}

export class SegmentSampler {
  private distanceCarryPx = 0;
  private timeCarryMs = 0;

  reset(): void {
    this.distanceCarryPx = 0;
    this.timeCarryMs = 0;
  }

  getCarryState(): { distanceCarryPx: number; timeCarryMs: number } {
    return {
      distanceCarryPx: this.distanceCarryPx,
      timeCarryMs: this.timeCarryMs,
    };
  }

  sampleSegment(input: SegmentSamplerRequest): number[] {
    return this.sampleSegmentDetailed(input).samples.map((sample) => sample.t);
  }

  sampleSegmentDetailed(input: SegmentSamplerRequest): SegmentSamplerDetailedResult {
    const distancePx = Math.max(0, input.distancePx);
    const durationMs = Math.max(0, input.durationMs);
    const spacingPx = clampPositive(input.spacingPx, 1);
    const maxIntervalMs = clampPositive(input.maxIntervalMs, 16);
    const distanceCarryBefore = this.distanceCarryPx;
    const timeCarryBefore = this.timeCarryMs;

    if (distancePx <= EPSILON && durationMs <= EPSILON) {
      return {
        samples: [],
        distanceCarryBefore,
        distanceCarryAfter: this.distanceCarryPx,
        timeCarryBefore,
        timeCarryAfter: this.timeCarryMs,
      };
    }

    const rawSamples: Array<{ t: number; triggerKind: SegmentSamplerTriggerKind }> = [];

    if (distancePx > EPSILON) {
      const firstT = (spacingPx - this.distanceCarryPx) / distancePx;
      const stepT = spacingPx / distancePx;
      for (let t = firstT; t <= 1 + EPSILON; t += stepT) {
        if (t > EPSILON) {
          rawSamples.push({
            t: Math.min(1, Math.max(0, t)),
            triggerKind: 'distance',
          });
        }
      }
    }

    if (durationMs > EPSILON) {
      const firstT = (maxIntervalMs - this.timeCarryMs) / durationMs;
      const stepT = maxIntervalMs / durationMs;
      for (let t = firstT; t <= 1 + EPSILON; t += stepT) {
        if (t > EPSILON) {
          rawSamples.push({
            t: Math.min(1, Math.max(0, t)),
            triggerKind: 'time',
          });
        }
      }
    }

    this.distanceCarryPx = normalizeCarry(this.distanceCarryPx + distancePx, spacingPx);
    this.timeCarryMs = normalizeCarry(this.timeCarryMs + durationMs, maxIntervalMs);

    if (rawSamples.length === 0) {
      return {
        samples: [],
        distanceCarryBefore,
        distanceCarryAfter: this.distanceCarryPx,
        timeCarryBefore,
        timeCarryAfter: this.timeCarryMs,
      };
    }

    rawSamples.sort((a, b) => a.t - b.t);
    const deduped: Array<{ t: number; triggerKind: SegmentSamplerTriggerKind }> = [];
    for (const sample of rawSamples) {
      const last = deduped[deduped.length - 1];
      if (!last) {
        deduped.push({ ...sample });
        continue;
      }
      if (Math.abs(sample.t - last.t) <= 1e-4) {
        if (last.triggerKind !== 'distance' && sample.triggerKind === 'distance') {
          last.triggerKind = 'distance';
        }
        continue;
      }
      deduped.push({ ...sample });
    }

    const distanceCarryAfter = this.distanceCarryPx;
    const timeCarryAfter = this.timeCarryMs;
    const samples = deduped.map((sample, index) => ({
      sampleIndex: index,
      t: sample.t,
      triggerKind: sample.triggerKind,
      distanceCarryBefore,
      distanceCarryAfter,
      timeCarryBefore,
      timeCarryAfter,
    }));

    return {
      samples,
      distanceCarryBefore,
      distanceCarryAfter,
      timeCarryBefore,
      timeCarryAfter,
    };
  }
}
