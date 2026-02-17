export interface SegmentSamplerRequest {
  distancePx: number;
  durationMs: number;
  spacingPx: number;
  maxIntervalMs: number;
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
    const distancePx = Math.max(0, input.distancePx);
    const durationMs = Math.max(0, input.durationMs);
    const spacingPx = clampPositive(input.spacingPx, 1);
    const maxIntervalMs = clampPositive(input.maxIntervalMs, 16);

    if (distancePx <= EPSILON && durationMs <= EPSILON) {
      return [];
    }

    const samples: number[] = [];

    if (distancePx > EPSILON) {
      const firstT = (spacingPx - this.distanceCarryPx) / distancePx;
      const stepT = spacingPx / distancePx;
      for (let t = firstT; t <= 1 + EPSILON; t += stepT) {
        if (t > EPSILON) {
          samples.push(Math.min(1, Math.max(0, t)));
        }
      }
    }

    if (durationMs > EPSILON) {
      const firstT = (maxIntervalMs - this.timeCarryMs) / durationMs;
      const stepT = maxIntervalMs / durationMs;
      for (let t = firstT; t <= 1 + EPSILON; t += stepT) {
        if (t > EPSILON) {
          samples.push(Math.min(1, Math.max(0, t)));
        }
      }
    }

    this.distanceCarryPx = normalizeCarry(this.distanceCarryPx + distancePx, spacingPx);
    this.timeCarryMs = normalizeCarry(this.timeCarryMs + durationMs, maxIntervalMs);

    if (samples.length <= 1) {
      return samples;
    }

    samples.sort((a, b) => a - b);
    const deduped: number[] = [];
    for (const sample of samples) {
      const last = deduped[deduped.length - 1];
      if (last === undefined || Math.abs(sample - last) > 1e-4) {
        deduped.push(sample);
      }
    }
    return deduped;
  }
}
