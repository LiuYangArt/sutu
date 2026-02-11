import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CurvesPanel } from '../index';

type TestWindow = Window & {
  __canvasCurvesBeginSession?: () => {
    sessionId: string;
    layerId: string;
    hasSelection: boolean;
    histogram: number[];
    renderMode: 'gpu' | 'cpu';
  } | null;
  __canvasCurvesPreview?: (sessionId: string, payload: unknown) => boolean;
  __canvasCurvesCommit?: (sessionId: string, payload: unknown) => Promise<boolean>;
  __canvasCurvesCancel?: (sessionId: string) => void;
};

const sessionId = 'curves-session-test';
const GRAPH_LEFT = -128;
const GRAPH_TOP = -128;
const GRAPH_WIDTH = 256;
const GRAPH_HEIGHT = 256;

function clientXFromCurveInput(input: number): number {
  return GRAPH_LEFT + (input / 255) * GRAPH_WIDTH;
}

function clientYFromCurveOutput(output: number): number {
  return GRAPH_TOP + ((255 - output) / 255) * GRAPH_HEIGHT;
}

describe('CurvesPanel', () => {
  const beginSpy = vi.fn<
    [],
    {
      sessionId: string;
      layerId: string;
      hasSelection: boolean;
      histogram: number[];
      renderMode: 'gpu' | 'cpu';
    } | null
  >();
  const previewSpy = vi.fn<[string, unknown], boolean>();
  const commitSpy = vi.fn<[string, unknown], Promise<boolean>>();
  const cancelSpy = vi.fn<[string], void>();

  beforeEach(() => {
    beginSpy.mockReset();
    previewSpy.mockReset();
    commitSpy.mockReset();
    cancelSpy.mockReset();

    beginSpy.mockReturnValue({
      sessionId,
      layerId: 'layer_1',
      hasSelection: false,
      histogram: new Array(256).fill(0),
      renderMode: 'cpu',
    });
    previewSpy.mockReturnValue(true);
    commitSpy.mockResolvedValue(true);

    (window as TestWindow).__canvasCurvesBeginSession = beginSpy;
    (window as TestWindow).__canvasCurvesPreview = previewSpy;
    (window as TestWindow).__canvasCurvesCommit = commitSpy;
    (window as TestWindow).__canvasCurvesCancel = cancelSpy;
    vi.stubGlobal('PointerEvent', MouseEvent as unknown as typeof PointerEvent);

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(16);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => {
      return {
        x: -128,
        y: -128,
        left: -128,
        top: -128,
        width: 256,
        height: 256,
        right: 128,
        bottom: 128,
        toJSON: () => ({}),
      } as DOMRect;
    });
  });

  afterEach(() => {
    delete (window as TestWindow).__canvasCurvesBeginSession;
    delete (window as TestWindow).__canvasCurvesPreview;
    delete (window as TestWindow).__canvasCurvesCommit;
    delete (window as TestWindow).__canvasCurvesCancel;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('点击曲线可新增控制点，并支持 Delete 删除', async () => {
    const { container } = render(<CurvesPanel />);
    const graph = screen.getByLabelText('Curves graph');

    expect(beginSpy).toHaveBeenCalledTimes(1);
    expect(previewSpy).toHaveBeenCalled();
    expect(container.querySelectorAll('circle').length).toBe(2);

    fireEvent.pointerDown(graph, { button: 0 });
    expect(container.querySelectorAll('circle').length).toBe(3);

    fireEvent.keyDown(window, { key: 'Delete', code: 'Delete' });
    expect(container.querySelectorAll('circle').length).toBe(2);
  });

  it('点击 OK 调用 Commit bridge', async () => {
    render(<CurvesPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'OK' }));

    await waitFor(() => {
      expect(commitSpy).toHaveBeenCalledTimes(1);
    });
    expect(commitSpy.mock.calls[0]?.[0]).toBe(sessionId);
  });

  it('点击 Cancel 调用 Cancel bridge', () => {
    render(<CurvesPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalledWith(sessionId);
  });

  it('Ctrl+Z / Ctrl+Y 只回滚面板内控制点状态', () => {
    const { container } = render(<CurvesPanel />);
    const graph = screen.getByLabelText('Curves graph');

    fireEvent.pointerDown(graph, { button: 0 });
    expect(container.querySelectorAll('circle').length).toBe(3);

    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(container.querySelectorAll('circle').length).toBe(2);

    fireEvent.keyDown(window, { key: 'y', code: 'KeyY', ctrlKey: true });
    expect(container.querySelectorAll('circle').length).toBe(3);
  });

  it('通道下拉包含 RGB / Red / Green / Blue', () => {
    render(<CurvesPanel />);

    const select = screen.getByRole('combobox');
    const optionTexts = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);

    expect(optionTexts).toEqual(['RGB', 'Red', 'Green', 'Blue']);
  });

  it('Input / Output 使用数字输入框并可精确修改选中控制点', () => {
    render(<CurvesPanel />);
    const graph = screen.getByLabelText('Curves graph');

    fireEvent.pointerDown(graph, { button: 0, clientX: 0, clientY: 0 });

    const inputField = screen.getByRole('spinbutton', { name: 'Input value' });
    const outputField = screen.getByRole('spinbutton', { name: 'Output value' });
    expect(inputField).toHaveValue(128);
    expect(outputField).toHaveValue(128);

    fireEvent.change(inputField, { target: { value: '150' } });
    fireEvent.blur(inputField);
    expect(inputField).toHaveValue(150);

    fireEvent.change(outputField, { target: { value: '210' } });
    fireEvent.blur(outputField);
    expect(outputField).toHaveValue(210);
  });

  it('拖动控制点到曲线框外并松手会删除该点', () => {
    const { container } = render(<CurvesPanel />);
    const graph = screen.getByLabelText('Curves graph');

    fireEvent.pointerDown(graph, { button: 0, clientX: 0, clientY: 0 });
    expect(container.querySelectorAll('circle').length).toBe(3);

    fireEvent.pointerDown(graph, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 360, clientY: 360 });
    fireEvent.pointerUp(window, { clientX: 360, clientY: 360 });

    expect(container.querySelectorAll('circle').length).toBe(2);
  });

  it('在曲线框内超过控制点极限 16px 并松手会删除该点', () => {
    const { container } = render(<CurvesPanel />);
    const graph = screen.getByLabelText('Curves graph');

    fireEvent.pointerDown(graph, {
      button: 0,
      clientX: clientXFromCurveInput(64),
      clientY: 0,
    });
    fireEvent.pointerDown(graph, {
      button: 0,
      clientX: clientXFromCurveInput(192),
      clientY: 0,
    });
    expect(container.querySelectorAll('circle').length).toBe(4);

    fireEvent.pointerDown(graph, {
      button: 0,
      clientX: clientXFromCurveInput(64),
      clientY: 0,
    });
    fireEvent.pointerMove(window, {
      clientX: clientXFromCurveInput(220),
      clientY: 0,
    });
    fireEvent.pointerUp(window, {
      clientX: clientXFromCurveInput(220),
      clientY: 0,
    });

    expect(container.querySelectorAll('circle').length).toBe(3);
  });

  it('超过控制点极限但不足 16px 时松手不删除', () => {
    const { container } = render(<CurvesPanel />);
    const graph = screen.getByLabelText('Curves graph');

    fireEvent.pointerDown(graph, {
      button: 0,
      clientX: clientXFromCurveInput(64),
      clientY: 0,
    });
    fireEvent.pointerDown(graph, {
      button: 0,
      clientX: clientXFromCurveInput(192),
      clientY: 0,
    });
    expect(container.querySelectorAll('circle').length).toBe(4);

    fireEvent.pointerDown(graph, {
      button: 0,
      clientX: clientXFromCurveInput(64),
      clientY: 0,
    });
    fireEvent.pointerMove(window, {
      clientX: clientXFromCurveInput(200),
      clientY: 0,
    });
    fireEvent.pointerUp(window, {
      clientX: clientXFromCurveInput(200),
      clientY: 0,
    });

    expect(container.querySelectorAll('circle').length).toBe(4);
  });

  it('RGB 视图会叠加显示已调整的单通道曲线', () => {
    const { container } = render(<CurvesPanel />);
    const graph = screen.getByLabelText('Curves graph');
    const channelSelect = screen.getByRole('combobox');

    fireEvent.change(channelSelect, { target: { value: 'green' } });
    fireEvent.pointerDown(graph, {
      button: 0,
      clientX: clientXFromCurveInput(96),
      clientY: -32,
    });

    fireEvent.change(channelSelect, { target: { value: 'rgb' } });

    expect(container.querySelector('path.curves-panel__curve--rgb')).toBeTruthy();
    expect(
      container.querySelector('path.curves-panel__curve--overlay.curves-panel__curve--green')
    ).toBeTruthy();
    expect(
      container.querySelector('path.curves-panel__curve--overlay.curves-panel__curve--red')
    ).toBeNull();
    expect(
      container.querySelector('path.curves-panel__curve--overlay.curves-panel__curve--blue')
    ).toBeNull();
  });

  it('RGB 曲线变化不应改变单通道叠加曲线形态', () => {
    const { container } = render(<CurvesPanel />);
    const graph = screen.getByLabelText('Curves graph');
    const channelSelect = screen.getByRole('combobox');

    fireEvent.change(channelSelect, { target: { value: 'red' } });
    fireEvent.pointerDown(graph, {
      button: 0,
      clientX: clientXFromCurveInput(176),
      clientY: clientYFromCurveOutput(96),
    });

    fireEvent.change(channelSelect, { target: { value: 'rgb' } });
    const redOverlay = container.querySelector(
      'path.curves-panel__curve--overlay.curves-panel__curve--red'
    ) as SVGPathElement | null;
    expect(redOverlay).toBeTruthy();
    const beforeRgbEditPath = redOverlay?.getAttribute('d');
    expect(beforeRgbEditPath).toBeTruthy();

    fireEvent.pointerDown(graph, {
      button: 0,
      clientX: clientXFromCurveInput(102),
      clientY: clientYFromCurveOutput(158),
    });

    const redOverlayAfterRgbEdit = container.querySelector(
      'path.curves-panel__curve--overlay.curves-panel__curve--red'
    ) as SVGPathElement | null;
    expect(redOverlayAfterRgbEdit).toBeTruthy();
    expect(redOverlayAfterRgbEdit?.getAttribute('d')).toBe(beforeRgbEditPath);
  });
});
