interface BrushSpeedEstimatorOptions {
  smoothingSamples?: number;
}

interface DistanceSample {
  distance: number;
}

const MAX_DISTANCE_HISTORY = 512;
const TIME_DIFF_WINDOW_SIZE = 200;
const TIME_DIFF_EFFECTIVE_PORTION = 0.8;
const MIN_TRACKING_DISTANCE_PX = 5;
const DEFAULT_SMOOTHING_SAMPLES = 3;
const MIN_SMOOTHING_SAMPLES = 3;
const MAX_SMOOTHING_SAMPLES = 100;
const DEFAULT_DT_MS = 8;
const MAX_VALID_DT_MS = 120;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampPositive(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function computeFilteredMean(values: readonly number[]): number {
  if (values.length === 0) return DEFAULT_DT_MS;
  if (values.length === 1) return clampPositive(values[0] ?? DEFAULT_DT_MS, DEFAULT_DT_MS);

  const usefulCount = Math.max(1, Math.round(TIME_DIFF_EFFECTIVE_PORTION * values.length));
  const cutTotal = Math.max(0, values.length - usefulCount);
  if (cutTotal === 0) {
    const sum = values.reduce((acc, value) => acc + value, 0);
    return clampPositive(sum / values.length, DEFAULT_DT_MS);
  }

  const sorted = [...values].sort((a, b) => a - b);
  const cutMin = Math.round(0.5 * cutTotal);
  const cutMax = cutTotal - cutMin;
  const start = cutMin;
  const end = Math.max(start + 1, sorted.length - cutMax);
  const sliced = sorted.slice(start, end);
  if (sliced.length === 0) return DEFAULT_DT_MS;
  const sum = sliced.reduce((acc, value) => acc + value, 0);
  return clampPositive(sum / sliced.length, DEFAULT_DT_MS);
}

export class BrushSpeedEstimator {
  private lastPoint: { x: number; y: number } | null = null;
  private lastTimestampMs = 0;
  private lastSpeedPxPerMs = 0;
  private distanceHistory: DistanceSample[] = [];
  private dtHistoryMs: number[] = [];

  reset(): void {
    this.lastPoint = null;
    this.lastTimestampMs = 0;
    this.lastSpeedPxPerMs = 0;
    this.distanceHistory = [];
    this.dtHistoryMs = [];
  }

  getLastSpeedPxPerMs(): number {
    return this.lastSpeedPxPerMs;
  }

  getNextSpeedPxPerMs(
    x: number,
    y: number,
    timestampMs: number,
    options?: BrushSpeedEstimatorOptions
  ): number {
    const safeTimestamp = Number.isFinite(timestampMs) ? timestampMs : 0;
    const smoothingSamples = clampInt(
      options?.smoothingSamples ?? DEFAULT_SMOOTHING_SAMPLES,
      MIN_SMOOTHING_SAMPLES,
      MAX_SMOOTHING_SAMPLES
    );

    if (!this.lastPoint) {
      this.lastPoint = { x, y };
      this.lastTimestampMs = safeTimestamp;
      this.lastSpeedPxPerMs = 0;
      return 0;
    }

    const dx = x - this.lastPoint.x;
    const dy = y - this.lastPoint.y;
    const distance = Math.hypot(dx, dy);
    const dt = safeTimestamp - this.lastTimestampMs;
    if (Number.isFinite(dt) && dt > 0 && dt <= MAX_VALID_DT_MS) {
      this.dtHistoryMs.push(dt);
      if (this.dtHistoryMs.length > TIME_DIFF_WINDOW_SIZE) {
        this.dtHistoryMs.shift();
      }
    }

    const avgDtMs = computeFilteredMean(this.dtHistoryMs);
    this.lastPoint = { x, y };
    this.lastTimestampMs = safeTimestamp;

    this.distanceHistory.push({ distance });
    if (this.distanceHistory.length > MAX_DISTANCE_HISTORY) {
      this.distanceHistory.shift();
    }

    let totalDistance = 0;
    let totalTime = 0;
    let items = 0;
    for (let i = this.distanceHistory.length - 1; i >= 0; i -= 1) {
      const sample = this.distanceHistory[i]!;
      items += 1;
      totalDistance += sample.distance;
      totalTime += avgDtMs;
      if (items > smoothingSamples && totalDistance > MIN_TRACKING_DISTANCE_PX) {
        break;
      }
    }

    if (totalTime > 0 && totalDistance > MIN_TRACKING_DISTANCE_PX) {
      this.lastSpeedPxPerMs = totalDistance / totalTime;
    }
    return this.lastSpeedPxPerMs;
  }

  getNormalizedSpeed(maxBrushSpeedPxPerMs: number): number {
    const safeMax = clampPositive(maxBrushSpeedPxPerMs, 30);
    return Math.max(0, Math.min(1, this.lastSpeedPxPerMs / safeMax));
  }
}
