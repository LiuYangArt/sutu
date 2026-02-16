import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PressureCurveEditor } from '../PressureCurveEditor';
import type { PressureCurveControlPoint } from '@/utils/pressureCurve';

const GRAPH_WIDTH = 256;
const GRAPH_HEIGHT = 256;

function clientXFromNormalized(x: number): number {
  return x * GRAPH_WIDTH;
}

function clientYFromNormalized(y: number): number {
  return GRAPH_HEIGHT - y * GRAPH_HEIGHT;
}

function Harness({ initialPoints }: { initialPoints: PressureCurveControlPoint[] }) {
  const [points, setPoints] = useState(initialPoints);
  return (
    <>
      <PressureCurveEditor points={points} onChange={setPoints} />
      <output data-testid="points-json">{JSON.stringify(points)}</output>
    </>
  );
}

function mockGraphRect(svg: SVGSVGElement, width = GRAPH_WIDTH, height = GRAPH_HEIGHT): void {
  Object.defineProperty(svg, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      width,
      height,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

function readPoints(): Array<{ x: number; y: number }> {
  return JSON.parse(screen.getByTestId('points-json').textContent ?? '[]') as Array<{
    x: number;
    y: number;
  }>;
}

describe('PressureCurveEditor', () => {
  beforeEach(() => {
    vi.stubGlobal('PointerEvent', MouseEvent as unknown as typeof PointerEvent);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('clamps internal point x within endpoints while dragging', () => {
    render(
      <Harness
        initialPoints={[
          { x: 0, y: 0 },
          { x: 0.5, y: 0.5 },
          { x: 1, y: 1 },
        ]}
      />
    );

    const svg = screen.getByLabelText('Pressure curve editor') as unknown as SVGSVGElement;
    mockGraphRect(svg);

    act(() => {
      fireEvent.pointerDown(svg, {
        pointerId: 1,
        clientX: clientXFromNormalized(0.5),
        clientY: clientYFromNormalized(0.5),
      });
    });
    act(() => {
      fireEvent.pointerMove(window, {
        pointerId: 1,
        clientX: clientXFromNormalized(0),
        clientY: clientYFromNormalized(0.8),
      });
    });
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });

    const points = readPoints();
    expect(points[1]?.x).toBeGreaterThan(0);
    expect(points[1]?.x).toBeLessThan(1);
  });

  it('renders editable points for provided curve', () => {
    render(
      <Harness
        initialPoints={[
          { x: 0, y: 0 },
          { x: 0.4, y: 0.7 },
          { x: 1, y: 1 },
        ]}
      />
    );

    const svg = screen.getByLabelText('Pressure curve editor');
    const circles = svg.querySelectorAll('circle');
    expect(circles.length).toBe(3);
  });

  it('supports add point and Delete removal', async () => {
    render(
      <Harness
        initialPoints={[
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ]}
      />
    );

    const svg = screen.getByLabelText('Pressure curve editor') as unknown as SVGSVGElement;
    mockGraphRect(svg);

    act(() => {
      fireEvent.pointerDown(svg, {
        pointerId: 1,
        clientX: clientXFromNormalized(0.5),
        clientY: clientYFromNormalized(0.5),
      });
    });

    await waitFor(() => {
      expect(readPoints().length).toBe(3);
    });

    act(() => {
      fireEvent.keyDown(window, { key: 'Delete', code: 'Delete' });
    });

    await waitFor(() => {
      expect(readPoints().length).toBe(2);
    });
  });

  it('deletes point when drag-out overshoot exceeds threshold', async () => {
    render(
      <Harness
        initialPoints={[
          { x: 0, y: 0 },
          { x: 0.35, y: 0.35 },
          { x: 0.75, y: 0.75 },
          { x: 1, y: 1 },
        ]}
      />
    );

    const svg = screen.getByLabelText('Pressure curve editor') as unknown as SVGSVGElement;
    mockGraphRect(svg);

    act(() => {
      fireEvent.pointerDown(svg, {
        pointerId: 1,
        clientX: clientXFromNormalized(0.35),
        clientY: clientYFromNormalized(0.35),
      });
    });
    act(() => {
      fireEvent.pointerMove(window, {
        pointerId: 1,
        clientX: clientXFromNormalized(0.95),
        clientY: clientYFromNormalized(0.35),
      });
    });
    act(() => {
      fireEvent.pointerUp(window, {
        pointerId: 1,
        clientX: clientXFromNormalized(0.95),
        clientY: clientYFromNormalized(0.35),
      });
    });

    await waitFor(() => {
      expect(readPoints().length).toBe(3);
    });
  });

  it('selects existing point instead of adding a new point when svg is scaled up', async () => {
    render(
      <Harness
        initialPoints={[
          { x: 0, y: 0 },
          { x: 0.5, y: 0.5 },
          { x: 1, y: 1 },
        ]}
      />
    );

    const svg = screen.getByLabelText('Pressure curve editor') as unknown as SVGSVGElement;
    mockGraphRect(svg, 420, 420);

    act(() => {
      fireEvent.pointerDown(svg, {
        pointerId: 1,
        clientX: 0.5 * 420,
        clientY: 0.5 * 420,
      });
      fireEvent.pointerUp(window, { pointerId: 1 });
    });

    expect(readPoints().length).toBe(3);

    act(() => {
      fireEvent.keyDown(window, { key: 'Delete', code: 'Delete' });
    });

    await waitFor(() => {
      expect(readPoints().length).toBe(2);
    });
  });

  it('keeps point when drag-out overshoot is below threshold', async () => {
    render(
      <Harness
        initialPoints={[
          { x: 0, y: 0 },
          { x: 0.35, y: 0.35 },
          { x: 0.75, y: 0.75 },
          { x: 1, y: 1 },
        ]}
      />
    );

    const svg = screen.getByLabelText('Pressure curve editor') as unknown as SVGSVGElement;
    mockGraphRect(svg);

    act(() => {
      fireEvent.pointerDown(svg, {
        pointerId: 1,
        clientX: clientXFromNormalized(0.35),
        clientY: clientYFromNormalized(0.35),
      });
    });
    act(() => {
      fireEvent.pointerMove(window, {
        pointerId: 1,
        clientX: clientXFromNormalized(0.81),
        clientY: clientYFromNormalized(0.35),
      });
    });
    act(() => {
      fireEvent.pointerUp(window, {
        pointerId: 1,
        clientX: clientXFromNormalized(0.81),
        clientY: clientYFromNormalized(0.35),
      });
    });

    await waitFor(() => {
      expect(readPoints().length).toBe(4);
    });
  });
});
