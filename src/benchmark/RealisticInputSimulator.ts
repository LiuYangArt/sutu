import { Point } from '@/utils/interpolation';

export interface SimulatorOptions {
  frequencyHz?: number; // Sampling rate, default 120Hz
  jitter?: boolean; // Simulate jitter
  pressureNoise?: number; // Pressure noise amplitude (0-1)
  steps?: number; // Total steps (points)
}

export class RealisticInputSimulator {
  constructor(private canvas: HTMLCanvasElement) {}

  // Real input simulation with timer drift correction
  async drawStroke(from: Point, to: Point, options: SimulatorOptions): Promise<void> {
    const frequencyHz = options.frequencyHz ?? 120;
    const steps = options.steps ?? 100;
    const interval = 1000 / frequencyHz;

    const points = this.interpolatePoints(from, to, steps);
    const startTime = performance.now();

    // Start stroke with pointerdown
    const firstPt = points[0];
    if (firstPt) {
      const pressure = firstPt.pressure ?? 0.5;
      this.dispatchPointerEvent(firstPt.x, firstPt.y, pressure, 'pointerdown');
      await new Promise((r) => setTimeout(r, 16)); // Wait for stroke init
    }

    for (let i = 1; i < points.length; i++) {
      // 1. Dispatch Event
      const pt = points[i]!;
      const finalPoint = options.jitter ? this.applyJitter(pt) : pt;
      // Synthesize simplified pressure if not present
      const pressure =
        finalPoint.pressure ??
        (options.pressureNoise ? 0.5 + (Math.random() - 0.5) * options.pressureNoise : 0.5);

      this.dispatchPointerEvent(finalPoint.x, finalPoint.y, pressure, 'pointermove');

      // 2. Calculate next expected time
      const nextExpectedTime = startTime + (i + 1) * interval;

      // 3. Calculate wait time (compensating for drift)
      const now = performance.now();
      const wait = Math.max(0, nextExpectedTime - now);

      // 4. Wait
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    // Dispatch PointerUp at end
    const lastPt = points[points.length - 1];
    if (lastPt) {
      this.dispatchPointerEvent(lastPt.x, lastPt.y, 0, 'pointerup');
    }

    // Wait for stroke to complete
    await new Promise((r) => setTimeout(r, 100));
  }

  private interpolatePoints(from: Point, to: Point, steps: number): Point[] {
    const points: Point[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      points.push({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        pressure:
          from.pressure !== undefined && to.pressure !== undefined
            ? from.pressure + (to.pressure - from.pressure) * t
            : 0.5,
      });
    }
    return points;
  }

  private applyJitter(pt: Point): Point {
    // Simple jitter +/- 1px
    return {
      ...pt,
      x: pt.x + (Math.random() - 0.5) * 2,
      y: pt.y + (Math.random() - 0.5) * 2,
    };
  }

  private dispatchPointerEvent(
    x: number,
    y: number,
    pressure: number,
    type: 'pointerdown' | 'pointermove' | 'pointerup' = 'pointermove'
  ): void {
    const rect = this.canvas.getBoundingClientRect();
    const screenX = rect.left + x;
    const screenY = rect.top + y;

    const event = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: screenX,
      clientY: screenY,
      pressure: pressure,
      pointerId: 1,
      pointerType: 'pen',
      isPrimary: true,
    });

    this.canvas.dispatchEvent(event);
  }
}
