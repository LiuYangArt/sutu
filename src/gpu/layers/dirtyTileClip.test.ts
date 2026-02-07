import { describe, expect, it } from 'vitest';
import { computeTileDrawRegion } from './dirtyTileClip';

describe('computeTileDrawRegion', () => {
  const tileRect = {
    originX: 512,
    originY: 256,
    width: 512,
    height: 512,
  };

  it('returns full tile region when dirty rect covers the entire tile', () => {
    const region = computeTileDrawRegion(tileRect, {
      left: 500,
      top: 200,
      right: 1200,
      bottom: 900,
    });

    expect(region).toEqual({
      x: 0,
      y: 0,
      width: 512,
      height: 512,
    });
  });

  it('returns clipped local region for partial overlap', () => {
    const region = computeTileDrawRegion(tileRect, {
      left: 640,
      top: 320,
      right: 900,
      bottom: 700,
    });

    expect(region).toEqual({
      x: 128,
      y: 64,
      width: 260,
      height: 380,
    });
  });

  it('returns null when dirty rect does not overlap tile', () => {
    const region = computeTileDrawRegion(tileRect, {
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
    });

    expect(region).toBeNull();
  });

  it('uses floor/ceil for fractional dirty rect bounds', () => {
    const region = computeTileDrawRegion(tileRect, {
      left: 512.2,
      top: 256.8,
      right: 513.1,
      bottom: 258.05,
    });

    expect(region).toEqual({
      x: 0,
      y: 0,
      width: 2,
      height: 3,
    });
  });
});
