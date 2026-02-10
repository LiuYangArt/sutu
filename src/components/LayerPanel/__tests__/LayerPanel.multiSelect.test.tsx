import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { LayerPanel } from '../index';
import { useDocumentStore, type Layer } from '@/stores/document';
import { useToastStore } from '@/stores/toast';

function createLayer(id: string, name: string, overrides?: Partial<Layer>): Layer {
  return {
    id,
    name,
    type: 'raster',
    visible: true,
    locked: false,
    opacity: 100,
    blendMode: 'normal',
    ...overrides,
  };
}

describe('LayerPanel multi selection', () => {
  beforeEach(() => {
    useDocumentStore.getState().reset();
    useToastStore.setState({ toasts: [] });

    const layers: Layer[] = [
      createLayer('layer_a', 'A'),
      createLayer('layer_b', 'B', { isBackground: true }),
      createLayer('layer_c', 'C', { locked: true }),
      createLayer('layer_d', 'D'),
    ];
    useDocumentStore.setState({
      layers,
      activeLayerId: 'layer_d',
      selectedLayerIds: ['layer_d'],
      layerSelectionAnchorId: 'layer_d',
      width: 800,
      height: 600,
    });
  });

  it('supports Shift range select and Ctrl toggle', () => {
    render(<LayerPanel />);

    const items = screen.getAllByTestId('layer-item');
    expect(items).toHaveLength(4);

    fireEvent.click(items[0]!);
    fireEvent.click(items[3]!, { shiftKey: true });

    expect(useDocumentStore.getState().selectedLayerIds).toEqual([
      'layer_d',
      'layer_c',
      'layer_b',
      'layer_a',
    ]);

    fireEvent.click(items[1]!, { ctrlKey: true });
    expect(useDocumentStore.getState().selectedLayerIds).toEqual(['layer_d', 'layer_b', 'layer_a']);
  });

  it('batch renames selected layers with F2 prompt from top to bottom', () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('newname');

    render(<LayerPanel />);
    const items = screen.getAllByTestId('layer-item');

    fireEvent.click(items[0]!);
    fireEvent.click(items[1]!, { ctrlKey: true });
    fireEvent.keyDown(document, { key: 'F2' });

    const state = useDocumentStore.getState();
    const top = state.layers.find((layer) => layer.id === 'layer_d');
    const next = state.layers.find((layer) => layer.id === 'layer_c');
    expect(top?.name).toBe('newname');
    expect(next?.name).toBe('newname_001');
    expect(promptSpy).toHaveBeenCalledTimes(1);
  });

  it('applies batch opacity/blend and skips locked/background layers', () => {
    render(<LayerPanel />);
    const items = screen.getAllByTestId('layer-item');

    fireEvent.click(items[0]!);
    fireEvent.click(items[1]!, { ctrlKey: true });
    fireEvent.click(items[2]!, { ctrlKey: true });

    const opacitySlider = screen.getByRole('slider');
    fireEvent.change(opacitySlider, { target: { value: '40' } });

    let state = useDocumentStore.getState();
    expect(state.layers.find((layer) => layer.id === 'layer_d')?.opacity).toBe(40);
    expect(state.layers.find((layer) => layer.id === 'layer_c')?.opacity).toBe(100);
    expect(state.layers.find((layer) => layer.id === 'layer_b')?.opacity).toBe(100);

    fireEvent.click(screen.getByRole('button', { name: /normal/i }));
    fireEvent.click(screen.getByRole('option', { name: /multiply/i }));

    state = useDocumentStore.getState();
    expect(state.layers.find((layer) => layer.id === 'layer_d')?.blendMode).toBe('multiply');
    expect(state.layers.find((layer) => layer.id === 'layer_c')?.blendMode).toBe('normal');
    expect(state.layers.find((layer) => layer.id === 'layer_b')?.blendMode).toBe('normal');
    expect(useToastStore.getState().toasts.length).toBeGreaterThan(0);
  });
});
