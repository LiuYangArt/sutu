import { mixPaintInfo } from '../core/paintInfoMix';
import { PaintInfoBuilder, type PaintInfoBuilderConfig } from '../core/paintInfoBuilder';
import { KritaSegmentSampler } from '../core/segmentSampler';
import type { NormalizedInputPhase, PaintInfo, RawInputSample } from '../core/types';

const EPSILON = 1e-6;

export interface KritaPressurePipelineConfig extends PaintInfoBuilderConfig {
  spacing_px: number;
  max_interval_us: number;
}

export interface PipelineStepResult {
  paint_infos: PaintInfo[];
  current_info: PaintInfo;
}

export class KritaPressurePipeline {
  private readonly builder: PaintInfoBuilder;
  private readonly sampler = new KritaSegmentSampler();
  private lastInfo: PaintInfo | null = null;
  private lastPhase: NormalizedInputPhase | null = null;
  private seenPointerUp = false;
  private emittedDabCount = 0;
  private spacingPx: number;
  private maxIntervalUs: number;

  constructor(config: KritaPressurePipelineConfig) {
    this.builder = new PaintInfoBuilder(config);
    this.spacingPx = Math.max(0.5, config.spacing_px);
    this.maxIntervalUs = Math.max(1_000, config.max_interval_us);
  }

  reset(): void {
    this.builder.reset();
    this.sampler.reset();
    this.lastInfo = null;
    this.lastPhase = null;
    this.seenPointerUp = false;
    this.emittedDabCount = 0;
  }

  updateConfig(config: Partial<KritaPressurePipelineConfig>): void {
    this.builder.updateConfig(config);
    if (typeof config.spacing_px === 'number') {
      this.spacingPx = Math.max(0.5, config.spacing_px);
    }
    if (typeof config.max_interval_us === 'number') {
      this.maxIntervalUs = Math.max(1_000, config.max_interval_us);
    }
  }

  processSample(sample: RawInputSample): PipelineStepResult {
    const { info } = this.builder.build(sample);
    const phase = sample.phase;

    if (!this.lastInfo) {
      this.lastInfo = info;
      this.lastPhase = phase;
      this.seenPointerUp = phase === 'up';
      if (phase === 'up') {
        this.emittedDabCount += 1;
        return {
          paint_infos: [info],
          current_info: info,
        };
      }
      return {
        paint_infos: [],
        current_info: info,
      };
    }

    const from = this.lastInfo;
    const to = info;
    const dx = to.x_px - from.x_px;
    const dy = to.y_px - from.y_px;
    const distancePx = Math.hypot(dx, dy);
    const durationUs = Math.max(0, to.time_us - from.time_us);

    const ts = this.sampler.sampleSegment({
      distance_px: distancePx,
      duration_us: durationUs,
      spacing_px: this.spacingPx,
      max_interval_us: this.maxIntervalUs,
    });

    const mixed: PaintInfo[] = [];
    if (ts.length > 0) {
      for (const t of ts) {
        mixed.push(mixPaintInfo(from, to, t));
      }
    } else if (distancePx <= EPSILON && durationUs <= EPSILON && phase === 'up') {
      mixed.push(to);
    }

    if (phase === 'up') {
      const tail = mixed[mixed.length - 1];
      const needsAppendTerminal =
        !tail ||
        Math.abs(tail.x_px - to.x_px) > EPSILON ||
        Math.abs(tail.y_px - to.y_px) > EPSILON ||
        Math.abs(tail.time_us - to.time_us) > 1;
      if (needsAppendTerminal) {
        mixed.push(to);
      }
    }

    this.lastInfo = to;
    this.lastPhase = phase;
    this.seenPointerUp = this.seenPointerUp || phase === 'up';
    this.emittedDabCount += mixed.length;
    return {
      paint_infos: mixed,
      current_info: to,
    };
  }

  finalize(): PaintInfo[] {
    if (!this.lastInfo) return [];
    const finalPoint = this.lastInfo;
    const shouldEmitFinalPoint =
      this.emittedDabCount === 0 || (!this.seenPointerUp && this.lastPhase !== 'up');
    this.reset();
    return shouldEmitFinalPoint ? [finalPoint] : [];
  }
}
