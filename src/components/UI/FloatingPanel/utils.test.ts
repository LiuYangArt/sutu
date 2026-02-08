import { describe, expect, it } from 'vitest';
import {
  calculateNewAlignment,
  calculateSnapAlignment,
  getAbsolutePositionFromAlignment,
} from './utils';

describe('FloatingPanel utils', () => {
  it('getAbsolutePositionFromAlignment computes left/top and right/bottom correctly', () => {
    const panel = { x: 10, y: 20, width: 200, height: 120 };
    const windowSize = { width: 1000, height: 800 };

    const fromLeftTop = getAbsolutePositionFromAlignment(
      { horizontal: 'left', vertical: 'top', offsetX: 32, offsetY: 18 },
      panel,
      windowSize
    );
    const fromRightBottom = getAbsolutePositionFromAlignment(
      { horizontal: 'right', vertical: 'bottom', offsetX: 24, offsetY: 40 },
      panel,
      windowSize
    );

    expect(fromLeftTop).toEqual({ x: 32, y: 18 });
    expect(fromRightBottom).toEqual({ x: 776, y: 640 });
  });

  it('calculateNewAlignment returns null when no relevant delta exists', () => {
    const currentAlignment = {
      horizontal: 'left',
      vertical: 'top',
      offsetX: 10,
      offsetY: 12,
    } as const;
    const newGeometry = { x: 10, y: 12, width: 300, height: 200 };

    expect(
      calculateNewAlignment(currentAlignment, newGeometry, {}, { width: 1200, height: 900 })
    ).toBe(null);
  });

  it('calculateNewAlignment updates right/bottom offsets from geometry', () => {
    const currentAlignment = {
      horizontal: 'right',
      vertical: 'bottom',
      offsetX: 30,
      offsetY: 40,
    } as const;
    const newGeometry = { x: 640, y: 380, width: 260, height: 180 };
    const windowSize = { width: 1000, height: 700 };

    const next = calculateNewAlignment(
      currentAlignment,
      newGeometry,
      { x: 12, width: -12, y: -8, height: 8 },
      windowSize
    );

    expect(next).toEqual({
      horizontal: 'right',
      vertical: 'bottom',
      offsetX: 100,
      offsetY: 140,
    });
  });

  it('calculateSnapAlignment snaps based on panel center', () => {
    const windowSize = { width: 1000, height: 800 };

    const leftTop = calculateSnapAlignment({ x: 100, y: 80, width: 200, height: 160 }, windowSize);
    const rightBottom = calculateSnapAlignment(
      { x: 700, y: 540, width: 220, height: 180 },
      windowSize
    );

    expect(leftTop).toEqual({
      horizontal: 'left',
      vertical: 'top',
      offsetX: 100,
      offsetY: 80,
    });
    expect(rightBottom).toEqual({
      horizontal: 'right',
      vertical: 'bottom',
      offsetX: 80,
      offsetY: 80,
    });
  });
});
