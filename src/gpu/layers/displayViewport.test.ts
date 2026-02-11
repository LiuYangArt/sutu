import { describe, expect, it } from 'vitest';
import { computeClampedDisplayViewport } from './displayViewport';

describe('computeClampedDisplayViewport', () => {
  it('clamps right edge tile viewport to canvas bounds', () => {
    const viewport = computeClampedDisplayViewport(
      {
        originX: 1536,
        originY: 0,
        width: 512,
        height: 512,
      },
      1920,
      1080
    );

    expect(viewport).toEqual({
      x: 1536,
      y: 0,
      width: 384,
      height: 512,
    });
  });

  it('clamps bottom edge tile viewport to canvas bounds', () => {
    const viewport = computeClampedDisplayViewport(
      {
        originX: 0,
        originY: 1024,
        width: 512,
        height: 512,
      },
      1920,
      1080
    );

    expect(viewport).toEqual({
      x: 0,
      y: 1024,
      width: 512,
      height: 56,
    });
  });

  it('returns null when tile origin is outside canvas', () => {
    const viewport = computeClampedDisplayViewport(
      {
        originX: 2048,
        originY: 0,
        width: 512,
        height: 512,
      },
      1920,
      1080
    );

    expect(viewport).toBeNull();
  });
});
