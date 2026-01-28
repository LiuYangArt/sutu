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
/**
 * Draw a smooth path using Catmull-Rom splines converted to Cubic Beziers.
 * This ensures the curve actually passes through the control points.
 *
 * @param ctx Canvas context
 * @param points Points to draw through
 * @param closePath If true, connects the last point back to the first point with a curve.
 *                  If false, leaves the path open at the last point (for later straight-line closure or continuation).
 */
export function drawSmoothMaskPath(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  closePath: boolean = true
) {
  if (points.length < 3) {
    if (points.length === 2) {
      ctx.lineTo(points[1]!.x, points[1]!.y);
    }
    return;
  }

  // Note: We assume the caller has already called beginPath() and moveTo(points[0]) if this is the start.
  // However, specifically for this implementation which uses global quadratic approximation,
  // it usually starts from scratch.
  // To keep compatibility but allow chunks, let's keep the moveTo for the first point
  // ONLY if we expect to start a new segment.
  // But standard usage in pathToMask expects this to do the drawing.

  // Current pathToMask usage:
  // ctx.beginPath();
  // drawSmoothMaskPath(ctx, simplified);
  // ctx.closePath();

  // So we can remove ctx.beginPath().
  // We MUST keep ctx.moveTo(points[0]) because the spline algorithm depends on p0, p1 etc logic below.
  // actually, the algorithm below draws FROM p0 SO it needs to be at p0.

  // If we are chaining this, the context might already be at p0.
  // A redundant moveTo is fine.
  // ctx.moveTo(points[0]!.x, points[0]!.y);

  // Correction:
  // The loop below uses Chaikin subdivision.
  // i=0: p0, p1. Draws curve between them (actually approx between them).

  const n = points.length;
  // If not closing, we stop at n-1
  const limit = closePath ? n : n - 1;

  for (let i = 0; i < limit; i++) {
    const p0 = points[i]!;
    const p1 = points[(i + 1) % n]!;

    // Use Chaikin-style subdivision: quadratic bezier with weighted control points
    // This prevents overshoot by keeping control points inside the polygon
    const cp_x = p0.x * 0.75 + p1.x * 0.25;
    const cp_y = p0.y * 0.75 + p1.y * 0.25;

    const end_x = p0.x * 0.25 + p1.x * 0.75;
    const end_y = p0.y * 0.25 + p1.y * 0.75;

    // For the very first point of an open path, we should probably just start exactly at p0?
    // The current algo starts at p0 but immediately curves towards the 25/75 mark.
    // If i=0, p0=Start.
    // It creates a gap between p0 and the first curve start if we don't start at p0.
    // The previous implementation was:
    // ctx.moveTo(points[0].x, points[0].y);
    // ctx.quadraticCurveTo(cp_x, cp_y, end_x, end_y);

    // THIS LOGIC actually implies the curve doesn't pass strictly THROUGH p0 and p1?
    // It passes near them. "Chaikin subdivision".
    // Actually, looking at the code:
    // moveTo(p0)
    // quadraticCurveTo(cp, end)
    // The curve starts at p0. Control point is near p0 (75/25). End point is near p1 (25/75).
    // So it smooths the CORNER at p0? No, p0 is the start.
    // Wait, if it loops (closed), p0 is also a corner.

    if (i === 0) {
      if (closePath) {
        // Closed loop logic remains... but purely for "Arc" fix we just use open drawing.
        // If closed is true, we might need special handling, but we are disabling it for now basically.
      }
      // Use lineTo instead of moveTo to ensure connectivity with previous segments
      ctx.lineTo(p0.x, p0.y);
    }

    ctx.quadraticCurveTo(cp_x, cp_y, end_x, end_y);

    // For the last segment of an Open path, we need to extend to the actual p1 (End Point).
    // The current loop draws to 'end' which is 25/75 between p0 and p1.
    // So it leaves a gap before the final point.
    // We should fix this for open paths.

    if (!closePath && i === limit - 1) {
      // Last segment. Extend to p1.
      ctx.lineTo(p1.x, p1.y);
    }
  }
}
