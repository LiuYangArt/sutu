import { useToolStore } from '@/stores/tool';
import { RealisticInputSimulator } from './RealisticInputSimulator';
import { LatencyProfiler } from './LatencyProfiler';
import { FPSCounter } from './FPSCounter';
import { LagometerMonitor } from './LagometerMonitor';
import { LatencyProfilerStats, FrameStats, LagometerStats } from './types';

export interface BenchmarkScenario {
  name: string;
  brushSize: number;
  hardness: number; // 0-100
  inputFrequency: number; // Hz
  strokeLength: number; // pixels
  strokeSpeed: 'slow' | 'medium' | 'fast';
}

export interface ScenarioResult {
  scenario: BenchmarkScenario;
  fps: FrameStats;
  latency: LatencyProfilerStats;
  lagometer: LagometerStats;
  duration: number;
}

export interface BenchmarkReport {
  timestamp: string;
  gitCommit?: string;
  scenarios: ScenarioResult[];
  summary: {
    avgFps: number;
    avgRenderLatency: number;
    maxVisualLag: number;
  };
}

// Predefined test scenarios
export const DEFAULT_SCENARIOS: BenchmarkScenario[] = [
  {
    name: 'Small Fast',
    brushSize: 20,
    hardness: 100,
    inputFrequency: 240,
    strokeLength: 500,
    strokeSpeed: 'fast',
  },
  {
    name: 'Medium Soft',
    brushSize: 100,
    hardness: 50,
    inputFrequency: 120,
    strokeLength: 800,
    strokeSpeed: 'medium',
  },
  {
    name: 'Large Soft',
    brushSize: 400,
    hardness: 20,
    inputFrequency: 60,
    strokeLength: 600,
    strokeSpeed: 'slow',
  },
  {
    name: 'Stress Test',
    brushSize: 800,
    hardness: 0,
    inputFrequency: 240,
    strokeLength: 1000,
    strokeSpeed: 'fast',
  },
];

export class BenchmarkRunner {
  private canvas: HTMLCanvasElement;
  private simulator: RealisticInputSimulator;
  private onProgress?: (progress: number, scenarioName: string) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.simulator = new RealisticInputSimulator(canvas);
  }

  setProgressCallback(cb: (progress: number, scenarioName: string) => void): void {
    this.onProgress = cb;
  }

  async runScenarios(
    scenarios: BenchmarkScenario[],
    profilers: {
      latencyProfiler: LatencyProfiler;
      fpsCounter: FPSCounter;
      lagometer: LagometerMonitor;
    }
  ): Promise<BenchmarkReport> {
    const results: ScenarioResult[] = [];

    for (let i = 0; i < scenarios.length; i++) {
      const scenario = scenarios[i]!;
      this.onProgress?.(i / scenarios.length, scenario.name);

      // Reset profilers before each scenario
      profilers.latencyProfiler.reset();
      profilers.lagometer.reset();

      // Configure brush settings
      this.applyBrushSettings(scenario);

      // Wait for settings to apply
      await this.delay(100);

      // Run the stroke
      const startTime = performance.now();
      await this.runStroke(scenario);
      const duration = performance.now() - startTime;

      // Wait for GPU to complete
      await this.delay(200);

      // Collect results
      results.push({
        scenario,
        fps: profilers.fpsCounter.getStats(),
        latency: profilers.latencyProfiler.getStats(),
        lagometer: profilers.lagometer.getStats(),
        duration,
      });

      // Brief pause between scenarios
      await this.delay(300);
    }

    this.onProgress?.(1, 'Complete');

    return this.generateReport(results);
  }

  private applyBrushSettings(scenario: BenchmarkScenario): void {
    useToolStore.setState({
      brushSize: scenario.brushSize,
      brushHardness: scenario.hardness,
    });
  }

  private async runStroke(scenario: BenchmarkScenario): Promise<void> {
    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;

    // Calculate stroke path (diagonal across canvas)
    const margin = 100;
    const startX = margin;
    const startY = margin;
    const endX = Math.min(startX + scenario.strokeLength, canvasWidth - margin);
    const endY = Math.min(startY + scenario.strokeLength * 0.6, canvasHeight - margin);

    // Calculate steps based on speed
    const speedMultiplier =
      scenario.strokeSpeed === 'fast' ? 0.5 : scenario.strokeSpeed === 'medium' ? 1 : 2;
    const steps = Math.floor((scenario.strokeLength / 5) * speedMultiplier);

    await this.simulator.drawStroke(
      { x: startX, y: startY, pressure: 0.5 },
      { x: endX, y: endY, pressure: 0.5 },
      {
        frequencyHz: scenario.inputFrequency,
        steps,
        jitter: false,
        pressureNoise: 0,
      }
    );
  }

  private generateReport(results: ScenarioResult[]): BenchmarkReport {
    // Calculate summary
    let totalFps = 0;
    let totalLatency = 0;
    let maxLag = 0;

    for (const r of results) {
      totalFps += r.fps.fps;
      totalLatency += r.latency.avgTotalRenderLatency;
      if (r.lagometer.maxLagDistance > maxLag) {
        maxLag = r.lagometer.maxLagDistance;
      }
    }

    return {
      timestamp: new Date().toISOString(),
      scenarios: results,
      summary: {
        avgFps: totalFps / results.length,
        avgRenderLatency: totalLatency / results.length,
        maxVisualLag: maxLag,
      },
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export report as JSON file using Tauri fs API
export async function downloadBenchmarkReport(report: BenchmarkReport): Promise<void> {
  const content = JSON.stringify(report, null, 2);
  const filename = `benchmark-${new Date().toISOString().split('T')[0]}.json`;

  try {
    // Try Tauri dialog + fs API
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');

    const path = await save({
      defaultPath: filename,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (path) {
      await writeTextFile(path, content);
    }
  } catch {
    // Fallback to browser download
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
