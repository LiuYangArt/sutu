export interface SegmentSamplerRequest {
  distance_px: number;
  duration_us: number;
  spacing_px: number;
  max_interval_us: number;
  timed_spacing_enabled?: boolean;
}

const EPSILON = 1e-6;
const MAX_SEGMENT_SAMPLES = 8192;
const MIN_STEP_T = 1 / MAX_SEGMENT_SAMPLES;

function clampPositive(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
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

export class KritaSegmentSampler {
  private distanceCarryPx = 0;
  private timeCarryUs = 0;

  reset(): void {
    this.distanceCarryPx = 0;
    this.timeCarryUs = 0;
  }

  getCarryState(): { distance_carry_px: number; time_carry_us: number } {
    return {
      distance_carry_px: this.distanceCarryPx,
      time_carry_us: this.timeCarryUs,
    };
  }

  sampleSegment(input: SegmentSamplerRequest): number[] {
    const distancePx = Math.max(0, input.distance_px);
    const durationUs = Math.max(0, input.duration_us);
    const spacingPx = clampPositive(input.spacing_px, 1);
    const maxIntervalUs = clampPositive(input.max_interval_us, 16_000);
    // Keep backward compatibility: timed spacing is enabled unless explicitly disabled.
    const timedSpacingEnabled = input.timed_spacing_enabled !== false;

    if (distancePx <= EPSILON && durationUs <= EPSILON) {
      return [];
    }

    const samples: number[] = [];

    if (distancePx > EPSILON) {
      const firstT = (spacingPx - this.distanceCarryPx) / distancePx;
      const stepT = spacingPx / distancePx;
      if (Number.isFinite(firstT) && Number.isFinite(stepT) && stepT > EPSILON) {
        const safeStepT = Math.max(stepT, MIN_STEP_T);
        for (let i = 0; i < MAX_SEGMENT_SAMPLES; i += 1) {
          const t = firstT + safeStepT * i;
          if (t > 1 + EPSILON) {
            break;
          }
          if (t > EPSILON) {
            samples.push(Math.min(1, Math.max(0, t)));
          }
        }
      }
    }

    if (timedSpacingEnabled && durationUs > EPSILON) {
      const firstT = (maxIntervalUs - this.timeCarryUs) / durationUs;
      const stepT = maxIntervalUs / durationUs;
      if (Number.isFinite(firstT) && Number.isFinite(stepT) && stepT > EPSILON) {
        const safeStepT = Math.max(stepT, MIN_STEP_T);
        for (let i = 0; i < MAX_SEGMENT_SAMPLES; i += 1) {
          const t = firstT + safeStepT * i;
          if (t > 1 + EPSILON) {
            break;
          }
          if (t > EPSILON) {
            samples.push(Math.min(1, Math.max(0, t)));
          }
        }
      }
    }

    this.distanceCarryPx = normalizeCarry(this.distanceCarryPx + distancePx, spacingPx);
    this.timeCarryUs = timedSpacingEnabled
      ? normalizeCarry(this.timeCarryUs + durationUs, maxIntervalUs)
      : 0;

    if (samples.length <= 1) return samples;

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
