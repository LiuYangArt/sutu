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

    let distanceCarry = this.distanceCarryPx;
    let timeCarry = this.timeCarryMs;
    let currentT = 0;
    const samples: SegmentSamplerDetailSample[] = [];

    while (currentT < 1 - EPSILON) {
      const canUseDistance = distancePx > EPSILON;
      const canUseTime = durationMs > EPSILON;
      if (!canUseDistance && !canUseTime) {
        break;
      }

      const remainingDistanceToNext = Math.max(0, spacingPx - distanceCarry);
      const remainingTimeToNext = Math.max(0, maxIntervalMs - timeCarry);
      const deltaTDistance = canUseDistance ? remainingDistanceToNext / distancePx : Number.POSITIVE_INFINITY;
      const deltaTTime = canUseTime ? remainingTimeToNext / durationMs : Number.POSITIVE_INFINITY;
      const deltaT = Math.min(deltaTDistance, deltaTTime);
      if (!Number.isFinite(deltaT)) {
        break;
      }

      const remainingT = 1 - currentT;
      if (deltaT > remainingT + EPSILON) {
        break;
      }

      const stepT = Math.max(0, Math.min(remainingT, deltaT));
      const sampleDistanceCarryBefore = distanceCarry;
      const sampleTimeCarryBefore = timeCarry;
      distanceCarry += distancePx * stepT;
      timeCarry += durationMs * stepT;

      const hitDistance = canUseDistance && distanceCarry + EPSILON >= spacingPx;
      const hitTime = canUseTime && timeCarry + EPSILON >= maxIntervalMs;
      if (!hitDistance && !hitTime) {
        break;
      }

      if (hitDistance) {
        distanceCarry = normalizeCarry(distanceCarry, spacingPx);
      }
      if (hitTime) {
        timeCarry = normalizeCarry(timeCarry, maxIntervalMs);
      }

      currentT += stepT;
      samples.push({
        sampleIndex: samples.length,
        t: Math.min(1, Math.max(0, currentT)),
        // When both channels hit together, distance wins to avoid duplicate emit at same t.
        triggerKind: hitDistance ? 'distance' : 'time',
        distanceCarryBefore: sampleDistanceCarryBefore,
        distanceCarryAfter: distanceCarry,
        timeCarryBefore: sampleTimeCarryBefore,
        timeCarryAfter: timeCarry,
      });
    }

    const restT = Math.max(0, 1 - currentT);
    if (restT > EPSILON) {
      distanceCarry += distancePx * restT;
      timeCarry += durationMs * restT;
    }

    this.distanceCarryPx = normalizeCarry(distanceCarry, spacingPx);
    this.timeCarryMs = normalizeCarry(timeCarry, maxIntervalMs);
    const distanceCarryAfter = this.distanceCarryPx;
    const timeCarryAfter = this.timeCarryMs;

    return {
      samples,
      distanceCarryBefore,
      distanceCarryAfter,
      timeCarryBefore,
      timeCarryAfter,
    };
  }
}
