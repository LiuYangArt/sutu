import { LagometerStats } from './types';

export class LagometerMonitor {
  private lagDistances: number[] = [];
  private brushRadius: number = 20;
  private lagExceedMargin: number = 10; // pixels beyond brush radius

  setBrushRadius(radius: number): void {
    this.brushRadius = radius;
  }

  // Call in render loop
  measure(inputPos: { x: number; y: number }, brushPos: { x: number; y: number }): void {
    const lagDistance = Math.hypot(inputPos.x - brushPos.x, inputPos.y - brushPos.y);
    this.lagDistances.push(lagDistance);
  }

  getStats(): LagometerStats {
    if (this.lagDistances.length === 0) {
      return {
        avgLagDistance: 0,
        maxLagDistance: 0,
        lagExceedCount: 0,
        lagExceedThreshold: this.brushRadius + this.lagExceedMargin,
      };
    }

    const threshold = this.brushRadius + this.lagExceedMargin;
    let sum = 0;
    let max = 0;
    let exceedCount = 0;

    for (const d of this.lagDistances) {
      sum += d;
      if (d > max) max = d;
      if (d > threshold) exceedCount++;
    }

    return {
      avgLagDistance: sum / this.lagDistances.length,
      maxLagDistance: max,
      lagExceedCount: exceedCount,
      lagExceedThreshold: threshold,
    };
  }

  reset(): void {
    this.lagDistances = [];
  }
}
