import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen, within } from '@testing-library/react';
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
    const win = window as Window & {
      __canvasPreviewLayerBlendMode?: (ids: string[], value: Layer['blendMode']) => number;
      __canvasClearLayerBlendModePreview?: () => number;
    };
    delete win.__canvasPreviewLayerBlendMode;
    delete win.__canvasClearLayerBlendModePreview;

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

  it('batch renames selected layers with F2 dialog from top to bottom', () => {
    render(<LayerPanel />);
    const items = screen.getAllByTestId('layer-item');

    fireEvent.click(items[0]!);
    fireEvent.click(items[1]!, { ctrlKey: true });
    fireEvent.keyDown(document, { key: 'F2' });
    expect(screen.getByRole('dialog', { name: /batch rename layers/i })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/base name/i), { target: { value: 'newname' } });
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    const state = useDocumentStore.getState();
    const top = state.layers.find((layer) => layer.id === 'layer_d');
    const next = state.layers.find((layer) => layer.id === 'layer_c');
    expect(top?.name).toBe('newname');
    expect(next?.name).toBe('newname_001');
    expect(screen.queryByRole('dialog', { name: /batch rename layers/i })).not.toBeInTheDocument();
  });

  it('shows key layer operations in context menu', () => {
    const mergeAllSpy = vi.fn(() => 1);
    const win = window as Window & { __canvasMergeAllLayers?: () => number };
    win.__canvasMergeAllLayers = mergeAllSpy;

    render(<LayerPanel />);
    const items = screen.getAllByTestId('layer-item');

    fireEvent.click(items[0]!);
    fireEvent.click(items[1]!, { ctrlKey: true });
    fireEvent.contextMenu(items[0]!);

    const contextMenu = document.querySelector('.layer-context-menu') as HTMLElement | null;
    expect(contextMenu).toBeTruthy();
    if (!contextMenu) return;
    const menu = within(contextMenu);
    expect(menu.getByRole('button', { name: /new layer/i })).toBeInTheDocument();
    expect(menu.getByRole('button', { name: /batch rename/i })).toBeInTheDocument();
    expect(menu.getByRole('button', { name: /merge selected layers/i })).toBeEnabled();
    expect(menu.getByRole('button', { name: /merge all layers/i })).toBeEnabled();

    fireEvent.click(menu.getByRole('button', { name: /merge all layers/i }));
    expect(mergeAllSpy).toHaveBeenCalledTimes(1);

    delete win.__canvasMergeAllLayers;
  });

  it('opens context menu on layer list empty area', () => {
    render(<LayerPanel />);
    const layerList = document.querySelector('.layer-list') as HTMLElement | null;
    expect(layerList).toBeTruthy();
    if (!layerList) return;

    fireEvent.contextMenu(layerList);

    const contextMenu = document.querySelector('.layer-context-menu') as HTMLElement | null;
    expect(contextMenu).toBeTruthy();
    if (!contextMenu) return;

    const menu = within(contextMenu);
    expect(menu.getByRole('button', { name: /new layer/i })).toBeInTheDocument();
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

  it('previews blend mode on hover and clears preview when leaving dropdown', () => {
    const previewSpy = vi.fn(() => 1);
    const clearSpy = vi.fn(() => 1);
    const win = window as Window & {
      __canvasPreviewLayerBlendMode?: (ids: string[], value: Layer['blendMode']) => number;
      __canvasClearLayerBlendModePreview?: () => number;
    };
    win.__canvasPreviewLayerBlendMode = previewSpy;
    win.__canvasClearLayerBlendModePreview = clearSpy;

    render(<LayerPanel />);

    fireEvent.click(screen.getByRole('button', { name: /normal/i }));
    fireEvent.mouseEnter(screen.getByRole('option', { name: /multiply/i }));
    expect(previewSpy).toHaveBeenCalledWith(['layer_d'], 'multiply');

    const dropdown = document.querySelector('.blend-mode-dropdown') as HTMLElement | null;
    expect(dropdown).toBeTruthy();
    if (!dropdown) return;

    fireEvent.mouseLeave(dropdown);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});
