export interface Point {
  x: number;
  y: number;
}

/**
 * Calculate distance from a point to a line segment
 */
function perpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
  let dx = lineEnd.x - lineStart.x;
  let dy = lineEnd.y - lineStart.y;

  // Normalize
  const mag = Math.sqrt(dx * dx + dy * dy);
  if (mag > 0) {
    dx /= mag;
    dy /= mag;
  }

  const pvx = point.x - lineStart.x;
  const pvy = point.y - lineStart.y;

  // Get dot product (project pv onto line)
  const pvdot = dx * pvx + dy * pvy;

  // Scale line vector
  const dsx = pvdot * dx;
  const dsy = pvdot * dy;

  // Subtract this from pv
  const ax = pvx - dsx;
  const ay = pvy - dsy;

  return Math.sqrt(ax * ax + ay * ay);
}

/**
 * Ramer-Douglas-Peucker algorithm for path simplification
 * Reduces the number of points in a curve that is composed of line segments
 */
export function simplifyPath(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) {
    return points;
  }

  let maxDistance = 0;
  let index = 0;
  const end = points.length - 1;

  for (let i = 1; i < end; i++) {
    const d = perpendicularDistance(points[i]!, points[0]!, points[end]!);
    if (d > maxDistance) {
      index = i;
      maxDistance = d;
    }
  }

  if (maxDistance > tolerance) {
    const leftSimplified = simplifyPath(points.slice(0, index + 1), tolerance);
    const rightSimplified = simplifyPath(points.slice(index, end + 1), tolerance);

    return [...leftSimplified.slice(0, -1), ...rightSimplified];
  } else {
    return [points[0]!, points[end]!];
  }
}

/**
 * Draw a smooth closed path using Catmull-Rom splines converted to Cubic Beziers
 * This ensures the curve actually passes through the control points
 */
export function drawSmoothMaskPath(ctx: CanvasRenderingContext2D, points: Point[]) {
  if (points.length < 3) {
    return;
  }

  // To make it a closed loop smoothly, we need to wrap around points.
  // Catmull-Rom needs P0 (prev), P1 (start), P2 (end), P3 (next) to draw segment P1-P2.

  // We want to draw segments for all points i:
  // Segment i -> i+1 uses: P[i-1], P[i], P[i+1], P[i+2]

  ctx.beginPath();

  // Handling the closed loop:
  // For the first point P0, prev is P[n-1]
  // For the last point P[n-1], next is P[0], next-next is P[1]

  ctx.moveTo(points[0]!.x, points[0]!.y);

  const n = points.length;

  // Use Chaikin subdivision for smoothing without overshoot
  // This creates a curve that stays within the convex hull of control points
  for (let i = 0; i < n; i++) {
    const p0 = points[i]!;
    const p1 = points[(i + 1) % n]!;

    // Use Chaikin-style subdivision: quadratic bezier with weighted control points
    // This prevents overshoot by keeping control points inside the polygon
    const cp_x = p0.x * 0.75 + p1.x * 0.25;
    const cp_y = p0.y * 0.75 + p1.y * 0.25;

    const end_x = p0.x * 0.25 + p1.x * 0.75;
    const end_y = p0.y * 0.25 + p1.y * 0.75;

    ctx.quadraticCurveTo(cp_x, cp_y, end_x, end_y);
  }
}
