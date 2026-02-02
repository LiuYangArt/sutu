/**
 * Utility functions for non-linear slider scaling.
 * Specifically implements "Piecewise Linear" scaling where a specific value
 * (e.g. 100) is mapped to a specific position (e.g. 50% of the slider).
 */

/**
 * Configuration for non-linear slider behavior.
 */
export interface NonLinearSliderConfig {
  /** The value that should appear at the 'midPositionRatio' point of the slider */
  midValue: number;
  /** The normalized position (0.0 to 1.0) where midValue should be placed. Defaults to 0.5 */
  midPositionRatio?: number;
  /**
   * For the second segment (midValue -> max), controls how values are distributed.
   * - 1.0: Linear (standard)
   * - > 1.0: Compressed towards start (values increase slowly then fast)
   * - < 1.0: Compressed towards end (values increase fast then slowly)
   * A value of ~2.6 approximates 250 being at 75% point between 100 and 1000.
   */
  secondHalfExponent?: number;
}

/**
 * Converts a real value to a normalized slider position (0.0 to 1.0).
 *
 * @param value The actual value (e.g., 100px)
 * @param min The minimum value of the slider
 * @param max The maximum value of the slider
 * @param config Configuration for non-linear mapping
 * @returns A value between 0.0 and 1.0 representing the slider position
 */
export function countToSliderProgress(
  value: number,
  min: number,
  max: number,
  config?: NonLinearSliderConfig
): number {
  // Linear fallback
  if (!config) {
    if (max === min) return 0;
    return (value - min) / (max - min);
  }

  const { midValue, midPositionRatio = 0.5 } = config;

  // Clamp value
  const clamped = Math.max(min, Math.min(max, value));

  if (clamped <= midValue) {
    // First segment: min -> midValue maps to 0.0 -> midPositionRatio
    const segmentRange = midValue - min;
    if (segmentRange === 0) return 0; // Should not happen if configured correctly
    const relativeProgress = (clamped - min) / segmentRange;
    return relativeProgress * midPositionRatio;
  } else {
    // Second segment: midValue -> max maps to midPositionRatio -> 1.0
    // If exponent is defined, apply inverse power curve (root)
    const segmentRange = max - midValue;
    if (segmentRange === 0) return 1;
    let relativeProgress = (clamped - midValue) / segmentRange;

    // Apply inverse curve (Value -> Slider Position)
    // If Value = t^k, then Slider Position t = Value^(1/k)
    const { secondHalfExponent = 1 } = config;
    if (secondHalfExponent !== 1) {
      relativeProgress = Math.pow(relativeProgress, 1 / secondHalfExponent);
    }

    return midPositionRatio + relativeProgress * (1 - midPositionRatio);
  }
}

/**
 * Converts a normalized slider position (0.0 to 1.0) back to a real value.
 *
 * @param progress The slider position (0.0 to 1.0)
 * @param min The minimum value
 * @param max The maximum value
 * @param step The step size (optional) - if provided, result is rounded to nearest step
 * @param config Configuration for non-linear mapping
 * @returns The calculated value
 */
export function sliderProgressToValue(
  progress: number,
  min: number,
  max: number,
  step?: number,
  config?: NonLinearSliderConfig
): number {
  let result: number;

  if (!config) {
    // Linear fallback
    result = min + progress * (max - min);
  } else {
    const { midValue, midPositionRatio = 0.5 } = config;
    const clampedProgress = Math.max(0, Math.min(1, progress));

    if (clampedProgress <= midPositionRatio) {
      // First segment
      const normalizedSegmentProgress = clampedProgress / midPositionRatio;
      result = min + normalizedSegmentProgress * (midValue - min);
    } else {
      // Second segment
      let normalizedSegmentProgress = (clampedProgress - midPositionRatio) / (1 - midPositionRatio);

      // Apply power curve (Slider Position -> Value)
      // Value = t^k
      const { secondHalfExponent = 1 } = config;
      if (secondHalfExponent !== 1) {
        normalizedSegmentProgress = Math.pow(normalizedSegmentProgress, secondHalfExponent);
      }

      result = midValue + normalizedSegmentProgress * (max - midValue);
    }
  }

  // Apply step logic if needed
  if (step && step > 0) {
    const steps = Math.round((result - min) / step);
    result = min + steps * step;
    // Verify clamping again after rounding
    result = Math.max(min, Math.min(max, result));
  }

  return result;
}
