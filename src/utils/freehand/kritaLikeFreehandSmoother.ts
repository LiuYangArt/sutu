export interface FreehandPoint {
  x: number;
  y: number;
  pressure: number;
  timestampMs: number;
}

export interface SmoothedSegment {
  from: FreehandPoint;
  to: FreehandPoint;
}

const EPSILON = 1e-6;

function clonePoint(point: FreehandPoint): FreehandPoint {
  return {
    x: point.x,
    y: point.y,
    pressure: point.pressure,
    timestampMs: point.timestampMs,
  };
}

function interpolatePoint(a: FreehandPoint, b: FreehandPoint, t: number): FreehandPoint {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    pressure: a.pressure + (b.pressure - a.pressure) * t,
    timestampMs: a.timestampMs + (b.timestampMs - a.timestampMs) * t,
  };
}

function isSamePoint(a: FreehandPoint, b: FreehandPoint): boolean {
  return (
    Math.abs(a.x - b.x) <= EPSILON &&
    Math.abs(a.y - b.y) <= EPSILON &&
    Math.abs(a.pressure - b.pressure) <= EPSILON &&
    Math.abs(a.timestampMs - b.timestampMs) <= EPSILON
  );
}

/**
 * Krita-like freehand smoother:
 * - never extrapolates past the final real point
 * - keeps a midpoint anchor on each latest real segment
 * - flushes the remaining half-segment on stroke end
 */
export class KritaLikeFreehandSmoother {
  private previousRealPoint: FreehandPoint | null = null;
  private currentRealPoint: FreehandPoint | null = null;
  private lastOutputPoint: FreehandPoint | null = null;

  reset(): void {
    this.previousRealPoint = null;
    this.currentRealPoint = null;
    this.lastOutputPoint = null;
  }

  processPoint(point: FreehandPoint): SmoothedSegment[] {
    if (!this.currentRealPoint) {
      this.currentRealPoint = clonePoint(point);
      this.lastOutputPoint = clonePoint(point);
      return [];
    }

    if (!this.previousRealPoint) {
      const from = this.currentRealPoint;
      const to = clonePoint(point);
      this.previousRealPoint = from;
      this.currentRealPoint = to;
      this.lastOutputPoint = clonePoint(to);
      if (isSamePoint(from, to)) {
        return [];
      }
      return [{ from: clonePoint(from), to: clonePoint(to) }];
    }

    this.previousRealPoint = this.currentRealPoint;
    this.currentRealPoint = clonePoint(point);

    const nextAnchor = interpolatePoint(this.previousRealPoint, this.currentRealPoint, 0.5);
    const from = this.lastOutputPoint ?? this.previousRealPoint;
    this.lastOutputPoint = clonePoint(nextAnchor);

    if (isSamePoint(from, nextAnchor)) {
      return [];
    }

    return [{ from: clonePoint(from), to: clonePoint(nextAnchor) }];
  }

  finishStrokeSegment(): SmoothedSegment | null {
    if (!this.currentRealPoint || !this.lastOutputPoint) {
      return null;
    }
    if (isSamePoint(this.lastOutputPoint, this.currentRealPoint)) {
      return null;
    }
    return {
      from: clonePoint(this.lastOutputPoint),
      to: clonePoint(this.currentRealPoint),
    };
  }
}
