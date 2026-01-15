import { FrameStats } from './types';

export class FPSCounter {
  private frameTimes: number[] = [];
  private lastFrameTime: number = 0;
  private isRunning: boolean = false;
  private droppedFrameThreshold: number = 33.33; // ~30FPS

  start() {
    this.isRunning = true;
    this.frameTimes = [];
    this.lastFrameTime = performance.now();
  }

  stop() {
    this.isRunning = false;
  }

  // Call at start of each frame (or end of rAF processing)
  tick() {
    if (!this.isRunning) return;

    const now = performance.now();
    const delta = now - this.lastFrameTime;

    // Ignore first frame potentially if delta is huge
    if (this.frameTimes.length > 0 || delta < 1000) {
      this.frameTimes.push(delta);
    }

    this.lastFrameTime = now;
  }

  getStats(): FrameStats {
    if (this.frameTimes.length === 0) {
      return {
        fps: 0,
        avgFrameTime: 0,
        minFrameTime: 0,
        maxFrameTime: 0,
        frameTimeStdDev: 0,
        p99FrameTime: 0,
        droppedFrames: 0,
        consecutiveDrops: 0,
      };
    }

    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let dropped = 0;
    let currentConsecutiveDrops = 0;
    let maxConsecutiveDrops = 0;

    for (const t of this.frameTimes) {
      sum += t;
      if (t < min) min = t;
      if (t > max) max = t;

      if (t > this.droppedFrameThreshold) {
        dropped++;
        currentConsecutiveDrops++;
      } else {
        maxConsecutiveDrops = Math.max(maxConsecutiveDrops, currentConsecutiveDrops);
        currentConsecutiveDrops = 0;
      }
    }
    maxConsecutiveDrops = Math.max(maxConsecutiveDrops, currentConsecutiveDrops);

    const avg = sum / this.frameTimes.length;
    const fps = 1000 / avg;

    // StdDev
    const variance =
      this.frameTimes.reduce((acc, t) => acc + Math.pow(t - avg, 2), 0) / this.frameTimes.length;
    const stdDev = Math.sqrt(variance);

    // P99
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p99Index = Math.floor(sorted.length * 0.99);
    const p99 = sorted[p99Index];

    return {
      fps,
      avgFrameTime: avg,
      minFrameTime: min,
      maxFrameTime: max,
      frameTimeStdDev: stdDev,
      p99FrameTime: p99 ?? 0,

      droppedFrames: dropped,
      consecutiveDrops: maxConsecutiveDrops,
    };
  }

  reset() {
    this.frameTimes = [];
    this.lastFrameTime = performance.now();
  }
}
