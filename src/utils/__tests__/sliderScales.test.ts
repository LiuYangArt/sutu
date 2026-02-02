import { describe, it, expect } from 'vitest';
import { countToSliderProgress, sliderProgressToValue } from '../sliderScales';

describe('sliderScales', () => {
  describe('Linear mode (no config)', () => {
    it('converts value to progress linearly', () => {
      expect(countToSliderProgress(50, 0, 100)).toBe(0.5);
      expect(countToSliderProgress(0, 0, 100)).toBe(0);
      expect(countToSliderProgress(100, 0, 100)).toBe(1);
    });

    it('converts progress to value linearly', () => {
      expect(sliderProgressToValue(0.5, 0, 100)).toBe(50);
      expect(sliderProgressToValue(0, 0, 100)).toBe(0);
      expect(sliderProgressToValue(1, 0, 100)).toBe(100);
    });
  });

  describe('Non-linear mode (Piecewise)', () => {
    const config = { midValue: 100 }; // 1-1000 range, mid is 100 (at 0.5)

    it('maps min value to 0 progress', () => {
      expect(countToSliderProgress(1, 1, 1000, config)).toBe(0);
    });

    it('maps max value to 1 progress', () => {
      expect(countToSliderProgress(1000, 1, 1000, config)).toBe(1);
    });

    it('maps midValue to midPositionRatio (default 0.5)', () => {
      expect(countToSliderProgress(100, 1, 1000, config)).toBe(0.5);
    });

    it('interpolates correctly within first segment (1-100)', () => {
      // 50.5 is halfway between 1 and 100
      // So progress should be 0.25 (half of 0.5)
      const val = (1 + 100) / 2;
      expect(countToSliderProgress(val, 1, 1000, config)).toBeCloseTo(0.25);
    });

    it('interpolates correctly within second segment (100-1000)', () => {
      // 550 is halfway between 100 and 1000
      // So progress should be 0.75 (0.5 + half of remaining 0.5)
      const val = (100 + 1000) / 2;
      expect(countToSliderProgress(val, 1, 1000, config)).toBeCloseTo(0.75);
    });

    describe('Inverse transformation (Progress -> Value)', () => {
      it('reverses 0 to min', () => {
        expect(sliderProgressToValue(0, 1, 1000, undefined, config)).toBe(1);
      });

      it('reverses 1 to max', () => {
        expect(sliderProgressToValue(1, 1, 1000, undefined, config)).toBe(1000);
      });

      it('reverses 0.5 to midValue', () => {
        expect(sliderProgressToValue(0.5, 1, 1000, undefined, config)).toBe(100);
      });

      it('reverses 0.25 to first segment midpoint', () => {
        const expected = (1 + 100) / 2;
        expect(sliderProgressToValue(0.25, 1, 1000, undefined, config)).toBe(expected);
      });
    });

    describe('With Step', () => {
      it('rounds to nearest step', () => {
        // Linear case
        expect(sliderProgressToValue(0.501, 0, 100, 1)).toBe(50);
        expect(sliderProgressToValue(0.509, 0, 100, 1)).toBe(51);

        // Non-linear case
        // 0.5 -> 100
        expect(sliderProgressToValue(0.5, 1, 1000, 1, config)).toBe(100);
      });
    });
  });
});
