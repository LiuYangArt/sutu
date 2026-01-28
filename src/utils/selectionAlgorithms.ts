import { SelectionMode, SelectionPoint } from '@/stores/selection';

/**
 * Combine two selection masks based on the boolean operation mode.
 */
export function combineMasks(base: ImageData, added: ImageData, mode: SelectionMode): ImageData {
  const width = base.width;
  const height = base.height;
  const result = new ImageData(width, height);

  for (let i = 0; i < base.data.length; i += 4) {
    const baseAlpha = base.data[i + 3] ?? 0;
    const addedAlpha = added.data[i + 3] ?? 0;

    let finalAlpha = 0;

    switch (mode) {
      case 'new':
        finalAlpha = addedAlpha;
        break;
      case 'add':
        // Union: Max alpha
        finalAlpha = Math.max(baseAlpha, addedAlpha);
        break;
      case 'subtract':
        // Subtract: Base - Added (clamped)
        finalAlpha = Math.max(0, baseAlpha - addedAlpha);
        break;
      case 'intersect':
        // Intersect: Min alpha
        finalAlpha = Math.min(baseAlpha, addedAlpha);
        break;
    }

    // Set white color with calculated alpha
    if (finalAlpha > 0) {
      result.data[i] = 255; // R
      result.data[i + 1] = 255; // G
      result.data[i + 2] = 255; // B
      result.data[i + 3] = finalAlpha; // A
    } else {
      result.data[i] = 0;
      result.data[i + 1] = 0;
      result.data[i + 2] = 0;
      result.data[i + 3] = 0;
    }
  }

  return result;
}

/**
 * Trace the contours of a binary mask to generate vector paths.
 * Uses Moore-Neighbor Tracing algorithm to find all boundaries.
 * Returns an array of paths (polygons), where each path is an array of SelectionPoints.
 */
export function traceMaskToPaths(mask: ImageData): SelectionPoint[][] {
  const paths: SelectionPoint[][] = [];
  const width = mask.width;
  const height = mask.height;
  const data = mask.data;

  // Track visited pixels to avoid re-tracing the same contour
  // We only track the *start* pixels of contours to avoid loops,
  // but for full robustness with holes, we might need more complex tracking.
  // For simple implementation: we can modify a copy of the mask or use a visited set for boundary pixels.
  // Since we need to output paths for "marchants", we need all boundaries (external and holes).

  // Optimization: use a Uint8Array to track visited boundary start points
  const visitedStart = new Uint8Array(width * height);

  // Helper to checking pixel validity
  const isSelected = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const idx = (y * width + x) * 4 + 3;
    return (data[idx] ?? 0) > 128; // Threshold
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Find a starting point for a contour
      // A point is a start point if it is selected AND it has an empty neighbor (to be a boundary)
      // Standard Moore-Neighbor tracing usually starts at the first non-zero pixel found.

      const idx = y * width + x;
      if (isSelected(x, y) && !visitedStart[idx]) {
        // Must be an edge to start.
        // We define "edge" as having at least one non-selected 4-neighbor,
        // OR simply rely on the scanning order: if we hit a pixel and the one to its left (or above) was empty, it's an edge.

        // Scan logic: if current is 1 and left is 0 (or x=0), it's a potential outer boundary start.
        // What about holes? If current is 1 and right is 0, valid start for hole?
        // Let's stick to standard approach:
        // Find a white pixel. If captured in 'visited', skip.

        // But simply marking 'visited' for all internal pixels is hard without flood fill.
        // We will only mark the BOUNDARY pixels as visited in a specific direction?
        // Actually, Moore-Tracing works by walking the boundary.
        // We can just keep a set of "pixels already part of a boundary".

        // Simple heuristic: If (x,y) is 1, and we haven't processed this contour yet.
        // To handle holes correctly, we should look for 0->1 transitions (outer) and 1->0 transitions (inner).
        // But for "marching ants", we just need the lines.

        // Let's accept (x,y) as start if it is 1.
        // But we need to make sure we don't start tracing a contour we already traced.
        // A common trick is to mark the boundary pixels in a separate map.

        // BUT, a pixel can be part of multiple vertices? No, usually once per contour.
        // Let's try: scan until we find a pixel P that is 1 and is not in any existing path?
        // Too slow to check all paths.

        // Let's use the visitedStart map.
        // Only start if (x,y) is boundary.
        const isBoundary =
          !isSelected(x - 1, y) ||
          !isSelected(x + 1, y) ||
          !isSelected(x, y - 1) ||
          !isSelected(x, y + 1);

        if (isBoundary) {
          // Check if this pixel is already part of a known path
          // If not, trace it.
          // Since this check is expensive, maybe we can simplify:
          // Just scan for transitions.
          // Left-to-Right scan:
          // If we cross from 0 to 1, we found an Outer boundary.
          // If we cross from 1 to 0, we found a Hole boundary?

          // Let's implement the specific logic:
          // If data[x,y] == 1 and visitedStart[x,y] is false...
          // We assume visitedStart marks pixels that have been used as a START point.
          // But that's not enough. We might hit the middle of a contour.

          // Better approach: "Scheider's algorithm" or similar.
          // For this task, maybe we can rely on a simplified version:
          // Only distinct islands need distinct paths.
          // Holes are also paths.

          // Let's try to find a pixel that is 1, and verify if it's already 'traced'.
          // To do this efficiently, we can mark the boundary pixels in a bitmap 'tracedPixels' as we trace them.

          // Note: Selection uses '1' for selected.

          // Logic:
          // if (is 1) and (not traced):
          //    if (is boundary):
          //       trace() -> adds to paths, marks all boundary pixels as traced.

          // Wait, if we use a bitmap for 'traced', we are good.
          // But a pixel can be visited multiple times if the line doubles back?
          // In Moore tracing, we stop when we return to start.

          if (visitedStart[idx]) continue;

          // Valid start?
          // We need an "entry direction" for Moore.
          // If we come from left (x-1 is 0), enter from West.
          let backtrack = null;
          if (!isSelected(x - 1, y)) backtrack = { x: x - 1, y };
          else if (!isSelected(x, y - 1)) backtrack = { x, y: y - 1 };
          else if (!isSelected(x + 1, y)) backtrack = { x: x + 1, y };
          else if (!isSelected(x, y + 1)) backtrack = { x, y: y + 1 };

          if (backtrack) {
            const path = mooreNeighborTrace(mask, x, y, backtrack, visitedStart);
            if (path && path.length > 2) {
              paths.push(path);
            }
          }
        }
      }
    }
  }

  return paths;
}

function mooreNeighborTrace(
  mask: ImageData,
  startX: number,
  startY: number,
  startBacktrack: { x: number; y: number },
  visitedMap: Uint8Array
): SelectionPoint[] {
  const width = mask.width;
  const height = mask.height;
  const data = mask.data;
  const path: SelectionPoint[] = [];

  const isSelected = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const idx = (y * width + x) * 4 + 3;
    return (data[idx] ?? 0) > 128;
  };

  let cx = startX;
  let cy = startY;
  let bx = startBacktrack.x;
  let by = startBacktrack.y;

  // Moore-Neighbor tracing
  // B = backtrack (previous empty pixel)
  // C = current pixel (boundary pixel)

  path.push({ x: cx, y: cy });
  visitedMap[cy * width + cx] = 1; // Mark start as visited

  // Clockwise search around C starting from B
  // Neighbors indexed 0..7
  // 0: (x-1, y-1) ...

  // We need a loop until we return to start
  // Max iterations to prevent infinite loop
  let i = 0;
  const MAX_ITER = width * height * 4;

  while (i < MAX_ITER) {
    // Find next boundary pixel
    const neighbors = [
      { x: cx, y: cy - 1 }, // N
      { x: cx + 1, y: cy - 1 }, // NE
      { x: cx + 1, y: cy }, // E
      { x: cx + 1, y: cy + 1 }, // SE
      { x: cx, y: cy + 1 }, // S
      { x: cx - 1, y: cy + 1 }, // SW
      { x: cx - 1, y: cy }, // W
      { x: cx - 1, y: cy - 1 }, // NW
    ];

    // Find index of B in neighbors
    // Note: B might not be a direct 8-neighbor if we jumped?
    // In Moore, B is always one of the 8 neighbors of C.
    // Actually, B is the pixel we entered from.

    // Special handling: B might be outside if C is on edge.

    // Find the starting direction to search (clockwise from B)
    let bIdx = -1;
    for (let k = 0; k < 8; k++) {
      const n = neighbors[k];
      if (n && n.x === bx && n.y === by) {
        bIdx = k;
        break;
      }
    }

    if (bIdx === -1) {
      // Should not happen in standard Moore
      // Fallback or break
      console.warn('Lost backtracking neighbor');
      break;
    }

    let nextPixel = null;
    let nextBacktrack = null;

    // Scan clockwise from B
    for (let j = 0; j < 8; j++) {
      const idx = (bIdx + 1 + j) % 8; // Start from neighbor AFTER B
      const n = neighbors[idx];
      if (n && isSelected(n.x, n.y)) {
        nextPixel = n;
        // The previous neighbor (empty) becomes the new backtrack
        const prevIdx = (idx + 7) % 8; // (idx - 1 + 8) % 8
        nextBacktrack = neighbors[prevIdx];
        break;
      }
    }

    if (nextPixel) {
      if (nextPixel.x === startX && nextPixel.y === startY) {
        // Closed loop
        break;
      }

      path.push(nextPixel);
      // Mark as potential start point visited so we don't start new contours here?
      // Actually, we should mark boundary pixels in visitedMap.
      visitedMap[nextPixel.y * width + nextPixel.x] = 1;

      cx = nextPixel.x;
      cy = nextPixel.y;
      bx = nextBacktrack!.x;
      by = nextBacktrack!.y;
    } else {
      // Isolated pixel
      break;
    }

    i++;
  }

  return path;
}
