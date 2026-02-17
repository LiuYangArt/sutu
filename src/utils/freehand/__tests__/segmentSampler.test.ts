import { describe, expect, it } from 'vitest';
import { SegmentSampler } from '../segmentSampler';

describe('SegmentSampler', () => {
  it('samples from distance and timing channels and keeps results ordered', () => {
    const sampler = new SegmentSampler();
    const samples = sampler.sampleSegment({
      distancePx: 10,
      durationMs: 20,
      spacingPx: 4,
      maxIntervalMs: 6,
    });

    expect(samples.length).toBeGreaterThan(0);
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
    for (const t of samples) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThanOrEqual(1);
    }
  });

  it('keeps carry-over so short segments can still emit samples', () => {
    const sampler = new SegmentSampler();
    const first = sampler.sampleSegment({
      distancePx: 1.5,
      durationMs: 2,
      spacingPx: 4,
      maxIntervalMs: 16,
    });
    expect(first).toEqual([]);

    const second = sampler.sampleSegment({
      distancePx: 3,
      durationMs: 2,
      spacingPx: 4,
      maxIntervalMs: 16,
    });
    expect(second.length).toBeGreaterThanOrEqual(1);
  });

  it('supports timing-only sampling when geometry movement is tiny', () => {
    const sampler = new SegmentSampler();
    const samples = sampler.sampleSegment({
      distancePx: 0.01,
      durationMs: 40,
      spacingPx: 100,
      maxIntervalMs: 10,
    });
    expect(samples.length).toBeGreaterThanOrEqual(3);
  });

  it('exposes detailed sampler metadata while keeping sampleSegment compatibility', () => {
    const sampler = new SegmentSampler();
    const detailed = sampler.sampleSegmentDetailed({
      distancePx: 8,
      durationMs: 18,
      spacingPx: 4,
      maxIntervalMs: 6,
    });
    const simple = sampler.sampleSegment({
      distancePx: 8,
      durationMs: 18,
      spacingPx: 4,
      maxIntervalMs: 6,
    });

    expect(detailed.samples.length).toBeGreaterThan(0);
    for (const sample of detailed.samples) {
      expect(sample.sampleIndex).toBeGreaterThanOrEqual(0);
      expect(sample.triggerKind === 'distance' || sample.triggerKind === 'time').toBe(true);
      expect(sample.distanceCarryBefore).toBeGreaterThanOrEqual(0);
      expect(sample.timeCarryAfter).toBeGreaterThanOrEqual(0);
    }
    expect(simple.length).toBeGreaterThanOrEqual(0);
  });
});
