import { describe, expect, it } from 'vitest';
import { compositeStrokePixel } from '../strokeBuffer';

describe('strokeBuffer composite mode', () => {
  it('paint mode follows source-over alpha compositing', () => {
    const out = compositeStrokePixel({
      dstR: 100,
      dstG: 120,
      dstB: 140,
      dstAlpha: 0.5,
      srcR: 200,
      srcG: 40,
      srcB: 20,
      srcAlpha: 0.5,
      mode: 'paint',
    });

    expect(out.alpha).toBeCloseTo(0.75, 5);
    expect(out.r).toBeGreaterThan(100);
    expect(out.g).toBeLessThan(120);
  });

  it('erase mode only reduces destination alpha while preserving destination color', () => {
    const out = compositeStrokePixel({
      dstR: 80,
      dstG: 90,
      dstB: 100,
      dstAlpha: 0.8,
      srcR: 255,
      srcG: 255,
      srcB: 255,
      srcAlpha: 0.25,
      mode: 'erase',
    });

    expect(out.r).toBe(80);
    expect(out.g).toBe(90);
    expect(out.b).toBe(100);
    expect(out.alpha).toBeCloseTo(0.6, 5);
  });

  it('erase mode clamps to fully transparent at full erase alpha', () => {
    const out = compositeStrokePixel({
      dstR: 10,
      dstG: 20,
      dstB: 30,
      dstAlpha: 0.42,
      srcR: 0,
      srcG: 0,
      srcB: 0,
      srcAlpha: 1,
      mode: 'erase',
    });

    expect(out.alpha).toBeCloseTo(0, 5);
  });
});
