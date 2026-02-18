import { sampleGlobalPressureCurve } from './globalPressureCurve';
import { KritaSpeedSmoother } from './speedSmoother';
import { clamp01, type PaintInfo, type PressureAnomalyFlags, type RawInputSample } from './types';

const TIMESTAMP_JUMP_US = 500_000;

export interface PaintInfoBuilderConfig {
  pressure_enabled: boolean;
  global_pressure_lut: Float32Array | null;
  use_device_time_for_speed: boolean;
  max_allowed_speed_px_per_ms: number;
  speed_smoothing_samples: number;
}

export interface BuildPaintInfoResult {
  info: PaintInfo;
  anomaly_flags: PressureAnomalyFlags;
}

function createDefaultAnomalyFlags(): PressureAnomalyFlags {
  return {
    timestamp_jump: false,
    non_monotonic_seq: false,
    invalid_pressure: false,
    source_alias_unresolved: false,
  };
}

export class PaintInfoBuilder {
  private config: PaintInfoBuilderConfig;
  private speedSmoother: KritaSpeedSmoother;
  private lastTimeUs: number | null = null;
  private lastSeq: number | null = null;

  constructor(config: PaintInfoBuilderConfig) {
    this.config = { ...config };
    this.speedSmoother = new KritaSpeedSmoother({
      use_device_time: config.use_device_time_for_speed,
      max_allowed_speed_px_per_ms: config.max_allowed_speed_px_per_ms,
      smoothing_samples: config.speed_smoothing_samples,
    });
  }

  updateConfig(config: Partial<PaintInfoBuilderConfig>): void {
    this.config = { ...this.config, ...config };
    this.speedSmoother.updateConfig({
      use_device_time: this.config.use_device_time_for_speed,
      max_allowed_speed_px_per_ms: this.config.max_allowed_speed_px_per_ms,
      smoothing_samples: this.config.speed_smoothing_samples,
    });
  }

  reset(): void {
    this.speedSmoother.reset();
    this.lastTimeUs = null;
    this.lastSeq = null;
  }

  private resolvePaintTimeUs(sample: RawInputSample): number {
    if (Number.isFinite(sample.host_time_us) && sample.host_time_us > 0) {
      return Math.round(sample.host_time_us);
    }
    if (Number.isFinite(sample.device_time_us) && sample.device_time_us > 0) {
      return Math.round(sample.device_time_us);
    }
    return 0;
  }

  build(sample: RawInputSample): BuildPaintInfoResult {
    const anomalyFlags = createDefaultAnomalyFlags();
    const rawPressure = sample.pressure_01;
    if (!Number.isFinite(rawPressure) || rawPressure < 0 || rawPressure > 1) {
      anomalyFlags.invalid_pressure = true;
    }

    const pressure01 = this.config.pressure_enabled
      ? sampleGlobalPressureCurve(this.config.global_pressure_lut, rawPressure)
      : 1;

    const drawingSpeed01 = this.speedSmoother.getNextSpeed01({
      x_px: sample.x_px,
      y_px: sample.y_px,
      device_time_us: sample.device_time_us,
      host_time_us: sample.host_time_us,
    });

    const timeUs = this.resolvePaintTimeUs(sample);
    if (this.lastTimeUs !== null) {
      if (timeUs < this.lastTimeUs) {
        anomalyFlags.non_monotonic_seq = true;
      }
      if (timeUs - this.lastTimeUs > TIMESTAMP_JUMP_US) {
        anomalyFlags.timestamp_jump = true;
      }
    }
    this.lastTimeUs = timeUs;

    if (typeof sample.seq === 'number') {
      if (this.lastSeq !== null && sample.seq <= this.lastSeq) {
        anomalyFlags.non_monotonic_seq = true;
      }
      this.lastSeq = sample.seq;
    }

    return {
      info: {
        x_px: sample.x_px,
        y_px: sample.y_px,
        pressure_01: clamp01(pressure01),
        drawing_speed_01: clamp01(drawingSpeed01),
        time_us: timeUs,
      },
      anomaly_flags: anomalyFlags,
    };
  }
}
