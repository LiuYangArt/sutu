import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrushQuickPanel } from '../BrushQuickPanel';
import { useToolStore } from '@/stores/tool';
import { useBrushLibraryStore, type BrushLibraryPreset } from '@/stores/brushLibrary';
import { DEFAULT_ROUND_BRUSH } from '@/components/BrushPanel/types';

function createPreset(id: string, name: string, group: string | null): BrushLibraryPreset {
  return {
    ...DEFAULT_ROUND_BRUSH,
    id,
    name,
    tipId: null,
    group,
    source: 'test',
    contentHash: `hash-${id}`,
  };
}

function seedToolStore(): void {
  useToolStore.setState({
    currentTool: 'brush',
    brushSize: 32,
    eraserSize: 20,
    brushColor: '#112233',
    backgroundColor: '#ffffff',
  });
}

describe('BrushQuickPanel', () => {
  beforeEach(() => {
    seedToolStore();
  });

  it('filters presets with local search and applies selected preset', () => {
    const applyPresetById = vi.fn();
    const loadLibrary = vi.fn();

    useBrushLibraryStore.setState((state) => ({
      ...state,
      presets: [
        createPreset('soft-round', 'Soft Round', 'Basics'),
        createPreset('hard-chalk', 'Hard Chalk', 'Texture'),
      ],
      groups: [
        { name: 'Basics', presetIds: ['soft-round'] },
        { name: 'Texture', presetIds: ['hard-chalk'] },
      ],
      selectedPresetByTool: { brush: null, eraser: null },
      searchQuery: '',
      isLoading: false,
      error: null,
      applyPresetById,
      loadLibrary,
      clearError: vi.fn(),
    }));

    render(<BrushQuickPanel isOpen anchorX={120} anchorY={120} onRequestClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Soft Round/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hard Chalk/ })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search brushes...'), {
      target: { value: 'chalk' },
    });

    expect(screen.queryByRole('button', { name: /Soft Round/ })).not.toBeInTheDocument();
    const chalkButton = screen.getByRole('button', { name: /Hard Chalk/ });
    expect(chalkButton).toBeInTheDocument();

    fireEvent.click(chalkButton);
    expect(applyPresetById).toHaveBeenCalledWith('hard-chalk');
  });

  it('removes color card and keeps size value directly editable', async () => {
    useBrushLibraryStore.setState((state) => ({
      ...state,
      presets: [createPreset('soft-round', 'Soft Round', 'Basics')],
      groups: [{ name: 'Basics', presetIds: ['soft-round'] }],
      selectedPresetByTool: { brush: null, eraser: null },
      searchQuery: '',
      isLoading: false,
      error: null,
      loadLibrary: vi.fn(),
      applyPresetById: vi.fn(),
      clearError: vi.fn(),
    }));

    render(<BrushQuickPanel isOpen anchorX={120} anchorY={120} onRequestClose={vi.fn()} />);

    expect(screen.queryByText('Color')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('32px'));
    const input = screen.getByDisplayValue('32');
    fireEvent.change(input, { target: { value: '48' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(useToolStore.getState().brushSize).toBe(48);
    });
    expect(screen.getByText('48px')).toBeInTheDocument();
  });

  it('打开时以锚点为中心定位面板', () => {
    useBrushLibraryStore.setState((state) => ({
      ...state,
      presets: [createPreset('soft-round', 'Soft Round', 'Basics')],
      groups: [{ name: 'Basics', presetIds: ['soft-round'] }],
      selectedPresetByTool: { brush: null, eraser: null },
      searchQuery: '',
      isLoading: false,
      error: null,
      loadLibrary: vi.fn(),
      applyPresetById: vi.fn(),
      clearError: vi.fn(),
    }));

    const { container } = render(
      <BrushQuickPanel isOpen anchorX={600} anchorY={500} onRequestClose={vi.fn()} />
    );
    const panel = container.querySelector('.brush-quick-panel') as HTMLDivElement;
    expect(panel).toBeTruthy();
    const width = Number.parseFloat(panel.style.width);
    const height = Number.parseFloat(panel.style.height);
    const margin = 12;
    const expectedLeft = Math.min(
      Math.max(margin, 600 - width / 2),
      Math.max(margin, window.innerWidth - width - margin)
    );
    const expectedTop = Math.min(
      Math.max(margin, 500 - height / 2),
      Math.max(margin, window.innerHeight - height - margin)
    );
    expect(panel.style.left).toBe(`${expectedLeft}px`);
    expect(panel.style.top).toBe(`${expectedTop}px`);
  });

  it('按工具切换 selected preset 高亮', async () => {
    useToolStore.setState((state) => ({
      ...state,
      currentTool: 'brush',
    }));

    useBrushLibraryStore.setState((state) => ({
      ...state,
      presets: [
        createPreset('soft-round', 'Soft Round', 'Basics'),
        createPreset('hard-chalk', 'Hard Chalk', 'Texture'),
      ],
      groups: [
        { name: 'Basics', presetIds: ['soft-round'] },
        { name: 'Texture', presetIds: ['hard-chalk'] },
      ],
      selectedPresetByTool: { brush: 'soft-round', eraser: 'hard-chalk' },
      searchQuery: '',
      isLoading: false,
      error: null,
      loadLibrary: vi.fn(),
      applyPresetById: vi.fn(),
      clearError: vi.fn(),
    }));

    render(<BrushQuickPanel isOpen anchorX={120} anchorY={120} onRequestClose={vi.fn()} />);

    const softButton = screen.getByRole('button', { name: /Soft Round/ });
    const hardButton = screen.getByRole('button', { name: /Hard Chalk/ });
    expect(softButton.className).toContain('selected');
    expect(hardButton.className).not.toContain('selected');

    act(() => {
      useToolStore.getState().setTool('eraser');
    });

    await waitFor(() => {
      expect(softButton.className).not.toContain('selected');
      expect(hardButton.className).toContain('selected');
    });
  });

  it('closes on Escape and outside pointerdown', () => {
    useBrushLibraryStore.setState((state) => ({
      ...state,
      presets: [createPreset('soft-round', 'Soft Round', 'Basics')],
      groups: [{ name: 'Basics', presetIds: ['soft-round'] }],
      selectedPresetByTool: { brush: null, eraser: null },
      searchQuery: '',
      isLoading: false,
      error: null,
      loadLibrary: vi.fn(),
      applyPresetById: vi.fn(),
      clearError: vi.fn(),
    }));

    const onRequestClose = vi.fn();
    render(<BrushQuickPanel isOpen anchorX={220} anchorY={180} onRequestClose={onRequestClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onRequestClose).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(document.body);
    expect(onRequestClose).toHaveBeenCalledTimes(2);
  });

  it('loads brush library when panel opens and local cache is empty', async () => {
    const loadLibrary = vi.fn().mockResolvedValue(undefined);
    useBrushLibraryStore.setState((state) => ({
      ...state,
      presets: [],
      groups: [],
      selectedPresetByTool: { brush: null, eraser: null },
      searchQuery: '',
      isLoading: false,
      error: null,
      loadLibrary,
      applyPresetById: vi.fn(),
      clearError: vi.fn(),
    }));

    render(<BrushQuickPanel isOpen anchorX={100} anchorY={100} onRequestClose={vi.fn()} />);

    await waitFor(() => {
      expect(loadLibrary).toHaveBeenCalledTimes(1);
    });
  });

  it('shows a visible group toggle button and collapses from title row', () => {
    useBrushLibraryStore.setState((state) => ({
      ...state,
      presets: [createPreset('soft-round', 'Soft Round', 'Basics')],
      groups: [{ name: 'Basics', presetIds: ['soft-round'] }],
      selectedPresetByTool: { brush: null, eraser: null },
      searchQuery: '',
      isLoading: false,
      error: null,
      loadLibrary: vi.fn(),
      applyPresetById: vi.fn(),
      clearError: vi.fn(),
    }));

    render(<BrushQuickPanel isOpen anchorX={100} anchorY={100} onRequestClose={vi.fn()} />);

    const collapseBtn = screen.getByRole('button', { name: /Collapse group Basics/i });
    expect(collapseBtn).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Soft Round/ })).toBeInTheDocument();

    fireEvent.click(collapseBtn);
    expect(screen.queryByRole('button', { name: /Soft Round/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Expand group Basics/i })).toBeInTheDocument();
  });

  it('在滚动条区域按下指针时不应启动面板拖拽', () => {
    useBrushLibraryStore.setState((state) => ({
      ...state,
      presets: [
        createPreset('soft-round', 'Soft Round', 'Basics'),
        createPreset('hard-round', 'Hard Round', 'Basics'),
      ],
      groups: [{ name: 'Basics', presetIds: ['soft-round', 'hard-round'] }],
      selectedPresetByTool: { brush: null, eraser: null },
      searchQuery: '',
      isLoading: false,
      error: null,
      loadLibrary: vi.fn(),
      applyPresetById: vi.fn(),
      clearError: vi.fn(),
    }));

    const { container } = render(
      <BrushQuickPanel isOpen anchorX={120} anchorY={120} onRequestClose={vi.fn()} />
    );

    const panel = container.querySelector('.brush-quick-panel') as HTMLDivElement;
    const library = container.querySelector('.brush-quick-library') as HTMLDivElement;
    expect(panel).toBeTruthy();
    expect(library).toBeTruthy();

    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperty(panel, 'setPointerCapture', {
      value: setPointerCapture,
      configurable: true,
    });
    Object.defineProperty(panel, 'releasePointerCapture', {
      value: releasePointerCapture,
      configurable: true,
    });

    Object.defineProperty(panel, 'getBoundingClientRect', {
      value: () =>
        ({
          left: 50,
          top: 50,
          right: 610,
          bottom: 484,
          width: 560,
          height: 434,
          x: 50,
          y: 50,
          toJSON: () => ({}),
        }) as DOMRect,
      configurable: true,
    });

    Object.defineProperty(library, 'getBoundingClientRect', {
      value: () =>
        ({
          left: 100,
          top: 100,
          right: 400,
          bottom: 300,
          width: 300,
          height: 200,
          x: 100,
          y: 100,
          toJSON: () => ({}),
        }) as DOMRect,
      configurable: true,
    });
    Object.defineProperty(library, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(library, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(library, 'offsetHeight', { value: 200, configurable: true });
    Object.defineProperty(library, 'scrollWidth', { value: 280, configurable: true });
    Object.defineProperty(library, 'clientWidth', { value: 280, configurable: true });
    Object.defineProperty(library, 'offsetWidth', { value: 296, configurable: true });

    const initialLeft = panel.style.left;
    const initialTop = panel.style.top;

    fireEvent.pointerDown(panel, {
      pointerId: 21,
      button: 0,
      buttons: 1,
      clientX: 395,
      clientY: 150,
    });
    fireEvent.pointerMove(panel, {
      pointerId: 21,
      buttons: 1,
      clientX: 420,
      clientY: 190,
    });

    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(panel.className).not.toContain('dragging');
    expect(panel.style.left).toBe(initialLeft);
    expect(panel.style.top).toBe(initialTop);
  });
});
