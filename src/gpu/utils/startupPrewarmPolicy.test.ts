import { describe, expect, it } from 'vitest';
import { decideDualStartupPrewarmPolicy } from './startupPrewarmPolicy';

describe('decideDualStartupPrewarmPolicy', () => {
  it('skips when canvas area reaches threshold (5000x5000)', () => {
    const result = decideDualStartupPrewarmPolicy({
      width: 5000,
      height: 5000,
      maxBufferSize: 2_147_483_648,
    });

    expect(result.skip).toBe(true);
    expect(result.reasons.some((reason) => reason.startsWith('large-canvas-area:'))).toBe(true);
  });

  it('skips when maxBufferSize is at or below threshold', () => {
    const result = decideDualStartupPrewarmPolicy({
      width: 2048,
      height: 2048,
      maxBufferSize: 536_870_912,
    });

    expect(result.skip).toBe(true);
    expect(result.reasons.some((reason) => reason.startsWith('max-buffer-size:'))).toBe(true);
  });

  it('does not skip when both limits are within safe range', () => {
    const result = decideDualStartupPrewarmPolicy({
      width: 4096,
      height: 3072,
      maxBufferSize: 1_073_741_824,
    });

    expect(result.skip).toBe(false);
    expect(result.reasons).toEqual([]);
  });
});
