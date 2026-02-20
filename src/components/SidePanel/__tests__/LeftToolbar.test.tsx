import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { LeftToolbar } from '../LeftToolbar';
import { useSelectionStore } from '@/stores/selection';
import { useToolStore } from '@/stores/tool';

describe('LeftToolbar', () => {
  beforeEach(() => {
    useSelectionStore.getState().setSelectionShape('rect');
    useToolStore.setState((state) => ({
      ...state,
      currentTool: 'brush',
    }));
  });

  it('updates marquee icon when selection shape changes', () => {
    const { rerender } = render(<LeftToolbar />);
    const marqueeButton = screen.getByTitle(/M\)$/);

    const rectIcon = marqueeButton.querySelector('svg');
    expect(rectIcon?.classList.contains('lucide-square-dashed')).toBe(true);

    act(() => {
      useSelectionStore.getState().setSelectionShape('circle');
    });
    rerender(<LeftToolbar />);

    const circleIcon = marqueeButton.querySelector('svg');
    expect(circleIcon?.classList.contains('lucide-circle-dashed')).toBe(true);
  });
});
