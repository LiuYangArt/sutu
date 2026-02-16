import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PressureCurveEditor } from '../PressureCurveEditor';
import type { PressureCurveControlPoint } from '@/utils/pressureCurve';

const GRAPH_WIDTH = 360;
const GRAPH_HEIGHT = 180;
const GRAPH_PADDING = 14;
const INNER_WIDTH = GRAPH_WIDTH - GRAPH_PADDING * 2;
const INNER_HEIGHT = GRAPH_HEIGHT - GRAPH_PADDING * 2;

function clientXFromNormalized(x: number): number {
  return GRAPH_PADDING + x * INNER_WIDTH;
}

function clientYFromNormalized(y: number): number {
  return GRAPH_HEIGHT - GRAPH_PADDING - y * INNER_HEIGHT;
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

describe('PressureCurveEditor', () => {
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
    Object.defineProperty(svg, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
        right: GRAPH_WIDTH,
        bottom: GRAPH_HEIGHT,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(svg, 'setPointerCapture', { configurable: true, value: () => {} });
    Object.defineProperty(svg, 'releasePointerCapture', { configurable: true, value: () => {} });
    Object.defineProperty(svg, 'hasPointerCapture', { configurable: true, value: () => true });

    act(() => {
      fireEvent.pointerDown(svg, {
        pointerId: 1,
        clientX: clientXFromNormalized(0.5),
        clientY: clientYFromNormalized(0.5),
      });
    });
    act(() => {
      fireEvent.pointerMove(svg, {
        pointerId: 1,
        clientX: clientXFromNormalized(0),
        clientY: clientYFromNormalized(0.8),
      });
    });
    act(() => {
      fireEvent.pointerUp(svg, { pointerId: 1 });
    });

    const points = JSON.parse(screen.getByTestId('points-json').textContent ?? '[]') as Array<{
      x: number;
      y: number;
    }>;
    expect(points[1]?.x).toBeGreaterThan(0);
    expect(points[1]?.x).toBeLessThan(1);
  });

  it('removes internal point on double click', () => {
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
    Object.defineProperty(svg, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
        right: GRAPH_WIDTH,
        bottom: GRAPH_HEIGHT,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(svg, 'setPointerCapture', { configurable: true, value: () => {} });
    Object.defineProperty(svg, 'releasePointerCapture', { configurable: true, value: () => {} });
    Object.defineProperty(svg, 'hasPointerCapture', { configurable: true, value: () => true });

    act(() => {
      fireEvent.doubleClick(svg, {
        clientX: clientXFromNormalized(0.5),
        clientY: clientYFromNormalized(0.5),
      });
    });

    const points = JSON.parse(screen.getByTestId('points-json').textContent ?? '[]') as Array<{
      x: number;
      y: number;
    }>;
    expect(points).toHaveLength(2);
    expect(points[0]?.x).toBe(0);
    expect(points[1]?.x).toBe(1);
  });
});
