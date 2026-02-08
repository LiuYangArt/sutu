import { describe, expect, it } from 'vitest';
import { applyScatter, forEachScatter } from './scatterDynamics';

function makeRandom(sequence: number[]): () => number {
  let i = 0;
  return () => {
    if (i >= sequence.length) {
      throw new Error('Random sequence exhausted');
    }
    const v = sequence[i]!;
    i += 1;
    return v;
  };
}

describe('forEachScatter', () => {
  it('matches applyScatter (bothAxes=false, no jitter)', () => {
    const input = {
      x: 10,
      y: 20,
      strokeAngle: 0.25,
      diameter: 100,
      dynamics: {
        pressure: 0.5,
        tiltX: 0,
        tiltY: 0,
        rotation: 0,
        direction: 0,
        initialDirection: 0,
        fadeProgress: 0,
      },
    };

    const settings = {
      scatter: 200,
      scatterControl: 'off' as const,
      bothAxes: false,
      count: 4,
      countControl: 'off' as const,
      countJitter: 0,
    };

    // applyScatter always consumes 1 random for count jitter, even if countJitter=0.
    const seq = [0.1, 0.2, 0.3, 0.4, 0.5];
    const expected = applyScatter(input, settings, makeRandom(seq));

    const got: Array<{ x: number; y: number }> = [];
    const actualCount = forEachScatter(input, settings, (dab) => got.push(dab), makeRandom(seq));

    expect(actualCount).toBe(expected.length);
    expect(got).toEqual(expected);
  });

  it('matches applyScatter (bothAxes=true, with jitter)', () => {
    const input = {
      x: 3.5,
      y: 7.25,
      strokeAngle: 1.1,
      diameter: 42,
      dynamics: {
        pressure: 0.9,
        tiltX: 0.2,
        tiltY: -0.1,
        rotation: 0,
        direction: 0,
        initialDirection: 0,
        fadeProgress: 0,
      },
    };

    const settings = {
      scatter: 350,
      scatterControl: 'off' as const,
      bothAxes: true,
      count: 6,
      countControl: 'off' as const,
      countJitter: 50,
    };

    const seq = Array.from({ length: 64 }, (_v, i) => (i + 1) / 100);
    const expected = applyScatter(input, settings, makeRandom(seq));

    const got: Array<{ x: number; y: number }> = [];
    const actualCount = forEachScatter(input, settings, (dab) => got.push(dab), makeRandom(seq));

    expect(actualCount).toBe(expected.length);
    expect(got).toEqual(expected);
  });

  it('scatter control 在 countJitter=0 时直接作用 scatter 主属性', () => {
    const input = {
      x: 0,
      y: 0,
      strokeAngle: 0, // perpendicular is +Y
      diameter: 100,
      dynamics: {
        pressure: 1,
        tiltX: 0.5,
        tiltY: 0,
        rotation: 0,
        direction: 0,
        initialDirection: 0,
        fadeProgress: 0,
      },
    };

    const settings = {
      scatter: 100,
      scatterControl: 'penTilt' as const,
      bothAxes: false,
      count: 1,
      countControl: 'off' as const,
      countJitter: 0,
    };

    const got = applyScatter(input, settings, makeRandom([0.1, 1.0]));
    expect(got).toHaveLength(1);
    // scatterAmount = 100/100 * 100 * 0.5 * control(0.5) = 25
    expect(got[0]!.x).toBeCloseTo(0, 6);
    expect(got[0]!.y).toBeCloseTo(25, 6);
  });

  it('count control 在 jitter=0 时直接作用 count 主属性', () => {
    const input = {
      x: 1,
      y: 2,
      strokeAngle: 0.5,
      diameter: 40,
      dynamics: {
        pressure: 0.3,
        tiltX: 0,
        tiltY: 0,
        rotation: 0,
        direction: 0,
        initialDirection: 0,
        fadeProgress: 0,
      },
    };

    const settings = {
      scatter: 0,
      scatterControl: 'off' as const,
      bothAxes: false,
      count: 10,
      countControl: 'penPressure' as const,
      countJitter: 0,
    };

    const got = applyScatter(input, settings, makeRandom([0.1, 0.5, 0.5, 0.5]));
    // baseCount = round(10 * 0.3) = 3
    expect(got).toHaveLength(3);
  });
});
