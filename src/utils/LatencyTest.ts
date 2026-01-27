import { Channel, invoke } from '@tauri-apps/api/core';

export interface LatencyResult {
  avgJitter: number;
  maxJitter: number;
  msgCount: number;
  duration: number;
}

/**
 * Tracks message arrival times and calculates jitter
 */
class JitterTracker {
  private jitters: number[] = [];
  private lastTime: number | null = null;
  private readonly expectedInterval: number;

  constructor(freqHz: number) {
    this.expectedInterval = 1000 / freqHz;
  }

  record() {
    const now = performance.now();
    if (this.lastTime !== null) {
      const delta = now - this.lastTime;
      const jitter = Math.abs(delta - this.expectedInterval);
      this.jitters.push(jitter);
    }
    this.lastTime = now;
  }

  getStats(durationMs: number, msgCount: number): LatencyResult {
    if (this.jitters.length === 0) {
      return { avgJitter: 0, maxJitter: 0, msgCount, duration: durationMs };
    }

    const sum = this.jitters.reduce((a, b) => a + b, 0);
    const avg = sum / this.jitters.length;
    const max = Math.max(...this.jitters);

    return {
      avgJitter: avg,
      maxJitter: max,
      msgCount,
      duration: durationMs,
    };
  }
}

export async function runLatencyBenchmark(
  freqHz: number = 240,
  durationMs: number = 2000
): Promise<LatencyResult> {
  const channel = new Channel<Uint8Array>();
  const tracker = new JitterTracker(freqHz);
  let msgCount = 0;

  channel.onmessage = () => {
    msgCount++;
    tracker.record();
  };

  await invoke('start_benchmark', {
    onEvent: channel,
    freqHz,
    durationMs,
  });

  // Small buffer for pending messages
  await new Promise((r) => setTimeout(r, 100));

  return tracker.getStats(durationMs, msgCount);
}
