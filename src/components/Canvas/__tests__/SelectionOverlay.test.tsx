import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { SelectionOverlay } from '../SelectionOverlay';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';
import { useToolStore } from '@/stores/tool';

type MockCanvasContext = {
  fillStyle: string;
  clearRect: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  translate: ReturnType<typeof vi.fn>;
  scale: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  closePath: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  setLineDash: ReturnType<typeof vi.fn>;
  lineDashOffset: number;
  strokeStyle: string;
  lineWidth: number;
};

function createMockContext(): MockCanvasContext {
  return {
    fillStyle: '',
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    lineDashOffset: 0,
    strokeStyle: '',
    lineWidth: 1,
  };
}

function setCreatingTriangle(): void {
  useSelectionStore.getState().deselectAll();
  useSelectionStore.setState({
    isCreating: true,
    creationPoints: [
      { x: 10, y: 10, type: 'freehand' },
      { x: 60, y: 10, type: 'freehand' },
      { x: 30, y: 50, type: 'freehand' },
    ],
    previewPoint: null,
  });
}

describe('SelectionOverlay', () => {
  let ctx: MockCanvasContext;

  beforeEach(() => {
    ctx = createMockContext();

    useSettingsStore.setState((state) => ({
      ...state,
      general: {
        ...state.general,
        selectionAutoFillEnabled: false,
        selectionPreviewTranslucent: true,
      },
    }));
    useToolStore.setState({ brushColor: '#00AA33' });
    setCreatingTriangle();

    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe = vi.fn();
        disconnect = vi.fn();
      }
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((contextId: string) => {
      if (contextId === '2d') {
        return ctx as unknown as CanvasRenderingContext2D;
      }
      return null;
    }) as typeof HTMLCanvasElement.prototype.getContext);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 320,
      height: 240,
      top: 0,
      left: 0,
      right: 320,
      bottom: 240,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not fill preview when selection auto fill is disabled', async () => {
    render(<SelectionOverlay scale={1} offsetX={0} offsetY={0} />);

    await waitFor(() => {
      expect(ctx.fill).not.toHaveBeenCalled();
    });
  });

  it('uses translucent alpha for preview fill when enabled', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      general: {
        ...state.general,
        selectionAutoFillEnabled: true,
        selectionPreviewTranslucent: true,
      },
    }));

    render(<SelectionOverlay scale={1} offsetX={0} offsetY={0} />);

    await waitFor(() => {
      expect(ctx.fill).toHaveBeenCalled();
      expect(ctx.fillStyle).toBe('rgba(0, 170, 51, 0.28)');
    });
  });

  it('uses opaque alpha for preview fill when translucent option is off', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      general: {
        ...state.general,
        selectionAutoFillEnabled: true,
        selectionPreviewTranslucent: false,
      },
    }));

    render(<SelectionOverlay scale={1} offsetX={0} offsetY={0} />);

    await waitFor(() => {
      expect(ctx.fill).toHaveBeenCalled();
      expect(ctx.fillStyle).toBe('rgba(0, 170, 51, 1)');
    });
  });

  it('renders latched fill preview while selection creation is already finished', async () => {
    const latchedPath = [
      { x: 16, y: 16, type: 'freehand' as const },
      { x: 80, y: 16, type: 'freehand' as const },
      { x: 48, y: 72, type: 'freehand' as const },
    ];

    useSettingsStore.setState((state) => ({
      ...state,
      general: {
        ...state.general,
        selectionAutoFillEnabled: true,
        selectionPreviewTranslucent: true,
      },
    }));
    useSelectionStore.setState({
      isCreating: false,
      creationPoints: [],
      previewPoint: null,
      hasSelection: true,
      selectionPath: [latchedPath],
    });

    render(
      <SelectionOverlay
        scale={1}
        offsetX={0}
        offsetY={0}
        latchedFillPreview={{
          path: latchedPath,
          color: '#112233',
          startedAt: 1,
        }}
      />
    );

    await waitFor(() => {
      expect(ctx.fill).toHaveBeenCalled();
      expect(ctx.fillStyle).toBe('rgba(17, 34, 51, 0.28)');
    });
  });
});
