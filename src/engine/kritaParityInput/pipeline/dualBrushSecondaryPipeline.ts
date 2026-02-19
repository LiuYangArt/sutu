import type { PaintInfo, RawInputSample } from '../core/types';
import {
  KritaPressurePipeline,
  type KritaPressurePipelineConfig,
  type PipelineStepResult,
} from './kritaPressurePipeline';

export interface SecondaryDabPoint {
  x: number;
  y: number;
  pressure: number;
  timestampMs: number;
  normalizedSpeed: number;
  timeUs: number;
}

export interface SecondaryPipelineStepResult {
  paint_infos: SecondaryDabPoint[];
  current_info: SecondaryDabPoint;
}

function mapPaintInfoToSecondaryDab(info: PaintInfo): SecondaryDabPoint {
  return {
    x: info.x_px,
    y: info.y_px,
    pressure: info.pressure_01,
    timestampMs: info.time_us / 1000,
    normalizedSpeed: info.drawing_speed_01,
    timeUs: info.time_us,
  };
}

export class DualBrushSecondaryPipeline {
  private readonly pipeline: KritaPressurePipeline;

  constructor(config: KritaPressurePipelineConfig) {
    this.pipeline = new KritaPressurePipeline(config);
  }

  reset(): void {
    this.pipeline.reset();
  }

  updateConfig(config: Partial<KritaPressurePipelineConfig>): void {
    this.pipeline.updateConfig(config);
  }

  processSample(sample: RawInputSample): SecondaryPipelineStepResult {
    const result: PipelineStepResult = this.pipeline.processSample(sample);
    return {
      paint_infos: result.paint_infos.map(mapPaintInfoToSecondaryDab),
      current_info: mapPaintInfoToSecondaryDab(result.current_info),
    };
  }

  finalize(): SecondaryDabPoint[] {
    const infos = this.pipeline.finalize();
    return infos.map(mapPaintInfoToSecondaryDab);
  }
}
