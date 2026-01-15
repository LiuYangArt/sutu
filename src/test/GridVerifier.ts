/**
 * Grid Verifier for post-test pixel validation
 * Verifies that expected points have been rendered on the canvas
 * Called AFTER test completes to avoid interfering with rendering
 */

import type { Point } from './InputSimulator';

export interface VerificationResult {
  total: number;
  found: number;
  missing: Point[];
  passed: boolean;
  successRate: number;
}

export interface VerifyOptions {
  /** Minimum alpha value to consider a pixel as "painted" (0-255) */
  threshold?: number;
  /** Radius to search around each expected point */
  sampleRadius?: number;
}

/**
 * Verify that all expected points have pixels on the canvas
 * Should be called after test completes and rendering is idle
 */
export async function verifyGrid(
  canvas: HTMLCanvasElement,
  expectedPoints: Point[],
  options: VerifyOptions = {}
): Promise<VerificationResult> {
  const { threshold = 10, sampleRadius = 3 } = options;

  // Wait for rendering to be completely idle (double frame to be safe)
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r));

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Cannot get canvas 2d context');

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const missing: Point[] = [];

  for (const pt of expectedPoints) {
    const hasPixel = checkPixelArea(imgData, pt.x, pt.y, sampleRadius, threshold);
    if (!hasPixel) {
      missing.push(pt);
    }
  }

  const found = expectedPoints.length - missing.length;
  return {
    total: expectedPoints.length,
    found,
    missing,
    passed: missing.length === 0,
    successRate: expectedPoints.length > 0 ? found / expectedPoints.length : 1,
  };
}

/**
 * Check if there's any non-transparent pixel within a radius
 */
function checkPixelArea(
  imgData: ImageData,
  centerX: number,
  centerY: number,
  radius: number,
  threshold: number
): boolean {
  const { width, height, data } = imgData;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = Math.round(centerX) + dx;
      const y = Math.round(centerY) + dy;

      if (x < 0 || x >= width || y < 0 || y >= height) continue;

      const i = (y * width + x) * 4;
      const alpha = data[i + 3] ?? 0;

      if (alpha > threshold) {
        return true; // Found a non-transparent pixel
      }
    }
  }

  return false;
}

/**
 * Generate a visual report of verification results
 */
export function formatVerificationReport(result: VerificationResult): string {
  const lines: string[] = [
    '=== Grid Verification Report ===',
    `Total Points: ${result.total}`,
    `Found: ${result.found}`,
    `Missing: ${result.missing.length}`,
    `Success Rate: ${(result.successRate * 100).toFixed(1)}%`,
    `Status: ${result.passed ? '✅ PASSED' : '❌ FAILED'}`,
  ];

  if (result.missing.length > 0 && result.missing.length <= 10) {
    lines.push('Missing Points:');
    result.missing.forEach((p, i) => {
      lines.push(`  ${i + 1}. (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
    });
  } else if (result.missing.length > 10) {
    lines.push(`Missing Points: ${result.missing.length} (too many to list)`);
  }

  return lines.join('\n');
}
