import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ColorPanel } from './index';
import { useToolStore } from '@/stores/tool';
import { useToastStore } from '@/stores/toast';

interface MockHsvaColor {
  h: number;
  s: number;
  v: number;
  a: number;
}

interface MockSaturationSquareProps {
  hsva: MockHsvaColor;
  onChange: (newHsva: MockHsvaColor) => void;
}

interface MockVerticalHueSliderProps {
  hue: number;
  onChange: (newHue: number) => void;
}

vi.mock('./SaturationSquare', () => ({
  SaturationSquare: ({ hsva, onChange }: MockSaturationSquareProps) => (
    <div data-testid="mock-saturation-square" data-hue={`${hsva.h}`}>
      <button
        type="button"
        data-testid="mock-saturation-change"
        onClick={() => onChange({ ...hsva, s: 1, v: 50 })}
      >
        saturation-change
      </button>
    </div>
  ),
}));

vi.mock('./VerticalHueSlider', () => ({
  VerticalHueSlider: ({ hue, onChange }: MockVerticalHueSliderProps) => (
    <button
      type="button"
      data-testid="mock-hue-slider"
      data-hue={`${hue}`}
      onClick={() => onChange(180)}
    >
      hue-change
    </button>
  ),
}));

describe('ColorPanel', () => {
  beforeEach(() => {
    useToolStore.setState({
      brushColor: '#112233',
      backgroundColor: '#AABBCC',
      recentSwatches: [],
    });
    useToastStore.setState({ toasts: [] });
    vi.restoreAllMocks();
  });

  it('copies canonical HEX via clipboard API and shows success toast', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<ColorPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'HEX' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(writeText).toHaveBeenCalledWith('#112233');

    const toasts = useToastStore.getState().toasts;
    expect(toasts[toasts.length - 1]?.message).toBe('Copied #112233');
    expect(toasts[toasts.length - 1]?.variant).toBe('success');
  });

  it('falls back to execCommand when clipboard API fails', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('clipboard blocked');
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    render(<ColorPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'HEX' }));

    await waitFor(() => {
      expect(execCommand).toHaveBeenCalledWith('copy');
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts[toasts.length - 1]?.message).toBe('Copied #112233');
  });

  it('keeps recent swatch list at 6 items after adding 7 colors', () => {
    render(<ColorPanel />);
    const addButton = screen.getByRole('button', { name: 'Add Swatch' });
    const colors = ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777'];

    for (const color of colors) {
      act(() => {
        useToolStore.getState().setBrushColor(color);
      });
      fireEvent.click(addButton);
    }

    expect(useToolStore.getState().recentSwatches).toEqual([
      '#777777',
      '#666666',
      '#555555',
      '#444444',
      '#333333',
      '#222222',
    ]);
  });

  it('moves duplicate swatch color to the first slot instead of appending', () => {
    useToolStore.setState({
      recentSwatches: ['#AA0000', '#BB0000', '#CC0000'],
      brushColor: '#BB0000',
    });
    render(<ColorPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Swatch' }));

    expect(useToolStore.getState().recentSwatches).toEqual(['#BB0000', '#AA0000', '#CC0000']);
  });

  it('clicking a swatch only changes foreground color', () => {
    useToolStore.setState({
      brushColor: '#123456',
      backgroundColor: '#654321',
      recentSwatches: ['#F0F0F0'],
    });
    render(<ColorPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Swatch 1: #F0F0F0' }));

    expect(useToolStore.getState().brushColor).toBe('#F0F0F0');
    expect(useToolStore.getState().backgroundColor).toBe('#654321');
  });

  it('always renders a fixed 3x2 swatch grid', () => {
    useToolStore.setState({
      recentSwatches: ['#101010', '#202020'],
    });
    render(<ColorPanel />);

    expect(screen.getAllByTestId('recent-swatch-slot')).toHaveLength(6);
  });

  it('updates saturation square hue when brush color is grayscale and hue slider changes', () => {
    useToolStore.setState({
      brushColor: '#808080',
      backgroundColor: '#ffffff',
      recentSwatches: [],
    });
    render(<ColorPanel />);

    expect(screen.getByTestId('mock-saturation-square')).toHaveAttribute('data-hue', '0');
    fireEvent.click(screen.getByTestId('mock-hue-slider'));

    expect(screen.getByTestId('mock-saturation-square')).toHaveAttribute('data-hue', '180');
    expect(useToolStore.getState().brushColor).toBe('#808080');
  });

  it('keeps previous hue when external color changes to grayscale', () => {
    useToolStore.setState({
      brushColor: '#00FF00',
      backgroundColor: '#ffffff',
      recentSwatches: [],
    });
    render(<ColorPanel />);

    expect(screen.getByTestId('mock-hue-slider')).toHaveAttribute('data-hue', '120');
    act(() => {
      useToolStore.getState().setBrushColor('#808080');
    });

    expect(screen.getByTestId('mock-hue-slider')).toHaveAttribute('data-hue', '120');
  });

  it('does not move hue slider when saturation square updates color', () => {
    useToolStore.setState({
      brushColor: '#00FF00',
      backgroundColor: '#ffffff',
      recentSwatches: [],
    });
    render(<ColorPanel />);

    expect(screen.getByTestId('mock-hue-slider')).toHaveAttribute('data-hue', '120');
    fireEvent.click(screen.getByTestId('mock-saturation-change'));

    expect(screen.getByTestId('mock-hue-slider')).toHaveAttribute('data-hue', '120');
  });
});
