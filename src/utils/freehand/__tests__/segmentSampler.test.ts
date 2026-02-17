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

  it('uses distance priority when distance/time trigger at the same t', () => {
    const sampler = new SegmentSampler();
    sampler.sampleSegment({
      distancePx: 1,
      durationMs: 1,
      spacingPx: 2,
      maxIntervalMs: 2,
    });
    const detailed = sampler.sampleSegmentDetailed({
      distancePx: 1,
      durationMs: 1,
      spacingPx: 2,
      maxIntervalMs: 2,
    });

    expect(detailed.samples.length).toBe(1);
    expect(detailed.samples[0]?.triggerKind).toBe('distance');
  });

  it('updates carry metadata incrementally for each emitted sample', () => {
    const sampler = new SegmentSampler();
    const detailed = sampler.sampleSegmentDetailed({
      distancePx: 10,
      durationMs: 20,
      spacingPx: 4,
      maxIntervalMs: 6,
    });

    expect(detailed.samples.length).toBeGreaterThan(0);
    for (let i = 0; i < detailed.samples.length; i += 1) {
      const sample = detailed.samples[i]!;
      expect(sample.sampleIndex).toBeGreaterThanOrEqual(0);
      expect(sample.triggerKind === 'distance' || sample.triggerKind === 'time').toBe(true);
      expect(sample.distanceCarryBefore).toBeGreaterThanOrEqual(0);
      expect(sample.distanceCarryAfter).toBeGreaterThanOrEqual(0);
      expect(sample.timeCarryBefore).toBeGreaterThanOrEqual(0);
      expect(sample.timeCarryAfter).toBeGreaterThanOrEqual(0);
      if (i > 0) {
        const prev = detailed.samples[i - 1]!;
        expect(sample.distanceCarryBefore).toBeCloseTo(prev.distanceCarryAfter, 6);
        expect(sample.timeCarryBefore).toBeCloseTo(prev.timeCarryAfter, 6);
      }
    }
  });

  it('keeps carry continuity across segments with the same sampler', () => {
    const sampler = new SegmentSampler();
    const first = sampler.sampleSegmentDetailed({
      distancePx: 3,
      durationMs: 4,
      spacingPx: 4,
      maxIntervalMs: 6,
    });
    const second = sampler.sampleSegmentDetailed({
      distancePx: 5,
      durationMs: 6,
      spacingPx: 4,
      maxIntervalMs: 6,
    });

    expect(second.distanceCarryBefore).toBeCloseTo(first.distanceCarryAfter, 6);
    expect(second.timeCarryBefore).toBeCloseTo(first.timeCarryAfter, 6);
  });
});
