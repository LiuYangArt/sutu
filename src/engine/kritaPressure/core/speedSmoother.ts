import { clamp01, clampFinite } from './types';

const DEFAULT_DT_US = 8_000;
const MAX_VALID_DT_US = 120_000;
const MIN_TRACKING_DISTANCE_PX = 5;
const DT_WINDOW_SIZE = 200;
const DT_EFFECTIVE_PORTION = 0.8;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function computeFilteredMean(values: readonly number[]): number {
  if (values.length === 0) return DEFAULT_DT_US;
  if (values.length === 1) {
    return Math.max(1, clampFinite(values[0] ?? DEFAULT_DT_US, DEFAULT_DT_US));
  }

  const usefulCount = Math.max(1, Math.round(values.length * DT_EFFECTIVE_PORTION));
  const cutTotal = Math.max(0, values.length - usefulCount);
  if (cutTotal <= 0) {
    const sum = values.reduce((acc, value) => acc + value, 0);
    return Math.max(1, sum / values.length);
  }

  const sorted = [...values].sort((a, b) => a - b);
  const cutMin = Math.round(cutTotal * 0.5);
  const cutMax = cutTotal - cutMin;
  const start = cutMin;
  const end = Math.max(start + 1, sorted.length - cutMax);
  const sliced = sorted.slice(start, end);
  if (sliced.length === 0) return DEFAULT_DT_US;

  const sum = sliced.reduce((acc, value) => acc + value, 0);
  return Math.max(1, sum / sliced.length);
}

export interface KritaSpeedSmootherConfig {
  use_device_time: boolean;
  max_allowed_speed_px_per_ms: number;
  smoothing_samples: number;
}

export interface SpeedSmootherInput {
  x_px: number;
  y_px: number;
  device_time_us: number;
  host_time_us: number;
}

interface DistanceSample {
  distance_px: number;
}

export class KritaSpeedSmoother {
  private readonly config: KritaSpeedSmootherConfig;
  private lastPoint: { x_px: number; y_px: number } | null = null;
  private lastTimeUs = 0;
  private lastSpeedPxPerMs = 0;
  private distanceHistory: DistanceSample[] = [];
  private dtHistoryUs: number[] = [];

  constructor(config: KritaSpeedSmootherConfig) {
    this.config = {
      use_device_time: config.use_device_time,
      max_allowed_speed_px_per_ms: Math.max(1, config.max_allowed_speed_px_per_ms),
      smoothing_samples: clampInt(config.smoothing_samples, 3, 100),
    };
  }

  reset(): void {
    this.lastPoint = null;
    this.lastTimeUs = 0;
    this.lastSpeedPxPerMs = 0;
    this.distanceHistory = [];
    this.dtHistoryUs = [];
  }

  updateConfig(config: Partial<KritaSpeedSmootherConfig>): void {
    if (typeof config.use_device_time === 'boolean') {
      this.config.use_device_time = config.use_device_time;
    }
    if (typeof config.max_allowed_speed_px_per_ms === 'number') {
      this.config.max_allowed_speed_px_per_ms = Math.max(1, config.max_allowed_speed_px_per_ms);
    }
    if (typeof config.smoothing_samples === 'number') {
      this.config.smoothing_samples = clampInt(config.smoothing_samples, 3, 100);
    }
  }

  getLastSpeedPxPerMs(): number {
    return this.lastSpeedPxPerMs;
  }

  getNextSpeed01(sample: SpeedSmootherInput): number {
    return clamp01(this.getNextSpeedPxPerMs(sample) / this.config.max_allowed_speed_px_per_ms);
  }

  getNextSpeedPxPerMs(sample: SpeedSmootherInput): number {
    const selectedTimeUs =
      this.config.use_device_time && Number.isFinite(sample.device_time_us)
        ? sample.device_time_us
        : sample.host_time_us;
    const safeTimeUs = Number.isFinite(selectedTimeUs) ? Number(selectedTimeUs) : 0;

    if (!this.lastPoint) {
      this.lastPoint = { x_px: sample.x_px, y_px: sample.y_px };
      this.lastTimeUs = safeTimeUs;
      this.lastSpeedPxPerMs = 0;
      return 0;
    }

    const dx = sample.x_px - this.lastPoint.x_px;
    const dy = sample.y_px - this.lastPoint.y_px;
    const distancePx = Math.hypot(dx, dy);
    const dtUs = safeTimeUs - this.lastTimeUs;
    if (Number.isFinite(dtUs) && dtUs > 0 && dtUs <= MAX_VALID_DT_US) {
      this.dtHistoryUs.push(dtUs);
      if (this.dtHistoryUs.length > DT_WINDOW_SIZE) {
        this.dtHistoryUs.shift();
      }
    }

    const avgDtUs = computeFilteredMean(this.dtHistoryUs);

    this.lastPoint = { x_px: sample.x_px, y_px: sample.y_px };
    this.lastTimeUs = safeTimeUs;

    this.distanceHistory.push({ distance_px: distancePx });
    if (this.distanceHistory.length > 512) {
      this.distanceHistory.shift();
    }

    let totalDistancePx = 0;
    let totalTimeUs = 0;
    let items = 0;

    for (let i = this.distanceHistory.length - 1; i >= 0; i -= 1) {
      const entry = this.distanceHistory[i]!;
      items += 1;
      totalDistancePx += entry.distance_px;
      totalTimeUs += avgDtUs;
      if (items > this.config.smoothing_samples && totalDistancePx > MIN_TRACKING_DISTANCE_PX) {
        break;
      }
    }

    if (totalDistancePx > MIN_TRACKING_DISTANCE_PX && totalTimeUs > 0) {
      this.lastSpeedPxPerMs = totalDistancePx / (totalTimeUs / 1000);
    }
    return this.lastSpeedPxPerMs;
  }
}
