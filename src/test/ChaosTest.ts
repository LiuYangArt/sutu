/**
 * Chaos Testing for PaintBoard
 * Randomly generates input to test robustness and edge cases
 */

import { InputSimulator } from './InputSimulator';

export interface ChaosTestResult {
  duration: number;
  clicks: number;
  strokes: number;
  errors: number;
  errorMessages: string[];
}

export interface ChaosTestOptions {
  /** Test duration in milliseconds */
  duration?: number;
  /** Probability of stroke vs tap (0-1), set to 0 for clicks-only */
  strokeProbability?: number;
  /** Minimum interval between actions (ms) */
  minInterval?: number;
  /** Maximum interval between actions (ms) */
  maxInterval?: number;
  /** Progress callback */
  onProgress?: (progress: number) => void;
}

/**
 * Run chaos clicking test - random taps at varying intervals
 */
export function chaosClicker(
  canvas: HTMLCanvasElement,
  options: ChaosTestOptions = {}
): Promise<ChaosTestResult> {
  return chaosMixed(canvas, { ...options, strokeProbability: 0 });
}

/**
 * Run chaos mixed test - random mix of taps and strokes
 */
export async function chaosMixed(
  canvas: HTMLCanvasElement,
  options: ChaosTestOptions = {}
): Promise<ChaosTestResult> {
  const {
    duration = 5000,
    strokeProbability = 0.3,
    minInterval = 5,
    maxInterval = 100,
    onProgress,
  } = options;

  const simulator = new InputSimulator(canvas);
  const startTime = performance.now();
  let clicks = 0;
  let strokes = 0;
  let errors = 0;
  const errorMessages: string[] = [];

  while (performance.now() - startTime < duration) {
    try {
      const isStroke = strokeProbability > 0 && Math.random() < strokeProbability;

      if (isStroke) {
        await simulator.drawStroke(
          { x: Math.random() * canvas.width, y: Math.random() * canvas.height },
          { x: Math.random() * canvas.width, y: Math.random() * canvas.height },
          { pressure: 0.3 + Math.random() * 0.7, steps: 5 + Math.floor(Math.random() * 20) }
        );
        strokes++;
      } else {
        await simulator.tap(Math.random() * canvas.width, Math.random() * canvas.height, {
          pressure: 0.1 + Math.random() * 0.9,
          durationMs: 1 + Math.random() * 10,
        });
        clicks++;
      }

      const interval = minInterval + Math.random() * (maxInterval - minInterval);
      await new Promise((r) => setTimeout(r, interval));

      if (onProgress) {
        onProgress(Math.min((performance.now() - startTime) / duration, 1));
      }
    } catch (e) {
      errors++;
      if (errorMessages.length < 10) {
        errorMessages.push(e instanceof Error ? e.message : String(e));
      }
    }
  }

  return {
    duration: performance.now() - startTime,
    clicks,
    strokes,
    errors,
    errorMessages,
  };
}

/**
 * Format chaos test results for display
 */
export function formatChaosReport(result: ChaosTestResult): string {
  const lines: string[] = [
    '=== Chaos Test Report ===',
    `Duration: ${(result.duration / 1000).toFixed(1)}s`,
    `Clicks: ${result.clicks}`,
    `Strokes: ${result.strokes}`,
    `Total Actions: ${result.clicks + result.strokes}`,
    `Errors: ${result.errors}`,
    `Status: ${result.errors === 0 ? '✅ PASSED' : '❌ ERRORS OCCURRED'}`,
  ];

  if (result.errorMessages.length > 0) {
    lines.push('', 'Error Messages:');
    result.errorMessages.forEach((msg, i) => {
      lines.push(`  ${i + 1}. ${msg}`);
    });
  }

  return lines.join('\n');
}
