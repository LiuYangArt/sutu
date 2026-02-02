import { useMemo } from 'react';
import {
  countToSliderProgress,
  sliderProgressToValue,
  NonLinearSliderConfig,
} from '@/utils/sliderScales';

interface UseNonLinearSliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  nonLinearConfig?: NonLinearSliderConfig;
}

/**
 * Hook to manage non-linear slider state.
 * Maps an external value (e.g., 1-1000) to an internal linear slider position (0-10000).
 */
export function useNonLinearSlider({
  value,
  min,
  max,
  step = 1,
  nonLinearConfig,
}: UseNonLinearSliderProps) {
  const INTERNAL_MAX = 10000;

  // Calculate the current slider position (0-INTERNAL_MAX) based on external value
  const sliderPosition = useMemo(() => {
    const progress = countToSliderProgress(value, min, max, nonLinearConfig);
    return Math.round(progress * INTERNAL_MAX);
  }, [value, min, max, nonLinearConfig]);

  // Transform internal slider position back to external value
  const calculateValue = (newInternalValue: number): number => {
    const progress = newInternalValue / INTERNAL_MAX;
    return sliderProgressToValue(progress, min, max, step, nonLinearConfig);
  };

  return {
    sliderPosition,
    internalMax: INTERNAL_MAX,
    calculateValue,
  };
}
