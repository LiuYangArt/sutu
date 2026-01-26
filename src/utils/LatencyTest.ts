import { Channel, invoke } from '@tauri-apps/api/core';

export interface LatencyResult {
  avgJitter: number;
  maxJitter: number;
  msgCount: number;
  duration: number;
}

export async function runLatencyBenchmark(
  freqHz: number = 240,
  durationMs: number = 2000
): Promise<LatencyResult> {
  const channel = new Channel<Uint8Array>();
  let lastTime: number | null = null;
  const jitters: number[] = [];
  let msgCount = 0;

  // Expected interval in ms
  const expectedInterval = 1000 / freqHz;

  channel.onmessage = (_msg) => {
    const now = performance.now();
    msgCount++;

    if (lastTime !== null) {
      const delta = now - lastTime;
      // Calculate jitter: difference between actual interval and expected interval
      // We take absolute value to measure stability
      // Since we are batching (e.g. 10 at a time), the time between batches should be
      // batch_size * expected_interval approximately?
      // Wait, the Rust side simulates a loop with sleep.
      // If batch_size is 10, then Rust sends a packet every (10 * 1/freqHz) seconds?
      // No, looking at Rust code:
      // while start.elapsed() < duration {
      //    make batch (size 10)
      //    send batch
      //    sleep remainder of (1/freqHz)
      // }
      // This means Rust attempts to send a BATCH every 1/freqHz?
      // "let interval = Duration::from_micros(1_000_000 / freq_hz);"
      // "thread::sleep(interval - work_time);"
      // So yes, it sends a message (containing 10 mock points) every `interval`.
      // So the frontend should receive 1 message every `interval`.

      const jitter = Math.abs(delta - expectedInterval);
      jitters.push(jitter);
    }
    lastTime = now;
  };

  await invoke('start_benchmark', {
    onEvent: channel,
    freqHz,
    durationMs,
  });

  // Give a small buffer for last messages to arrive locally
  await new Promise((resolve) => setTimeout(resolve, 100));

  if (jitters.length === 0) {
    return { avgJitter: 0, maxJitter: 0, msgCount, duration: durationMs };
  }

  const sum = jitters.reduce((a, b) => a + b, 0);
  const avg = sum / jitters.length;
  const max = Math.max(...jitters);

  return {
    avgJitter: avg,
    maxJitter: max,
    msgCount,
    duration: durationMs,
  };
}
