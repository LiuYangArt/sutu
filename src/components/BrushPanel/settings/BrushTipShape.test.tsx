import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrushTipShape } from './BrushTipShape';
import { useToolStore } from '@/stores/tool';
import { useBrushLibraryStore } from '@/stores/brushLibrary';

vi.mock('../VirtualizedTipGrid', () => ({
  VirtualizedTipGrid: ({
    items,
    renderItem,
  }: {
    items: unknown[];
    renderItem: (item: unknown) => JSX.Element;
  }) => (
    <div data-testid="tip-grid">
      {items.map((item, index) => (
        <div key={index}>{renderItem(item)}</div>
      ))}
    </div>
  ),
}));

function getHardnessRange(): HTMLInputElement {
  const row = screen.getByText('Hardness').closest('.brush-setting-row');
  if (!row) {
    throw new Error('Hardness row not found');
  }
  const range = row.querySelector('input[type="range"]');
  if (!range) {
    throw new Error('Hardness range not found');
  }
  return range as HTMLInputElement;
}

describe('BrushTipShape', () => {
  beforeEach(() => {
    useBrushLibraryStore.setState({ tips: [] });
    useToolStore.setState({
      brushSize: 20,
      brushHardness: 42,
      brushRoundness: 100,
      brushAngle: 0,
      brushSpacing: 0.25,
      brushTexture: null,
    });
  });

  it('disables hardness when main tip is texture and shows placeholder value', () => {
    useToolStore.setState({
      brushTexture: {
        id: 'sample-tip',
        data: '',
        width: 64,
        height: 64,
      },
      brushHardness: 42,
    });

    render(<BrushTipShape />);

    expect(getHardnessRange()).toBeDisabled();
    expect(screen.getByText('--')).toBeInTheDocument();
  });

  it('enables hardness when main tip is procedural and shows numeric value', () => {
    render(<BrushTipShape />);

    expect(getHardnessRange()).not.toBeDisabled();
    expect(screen.getByText('42%')).toBeInTheDocument();
  });
});
