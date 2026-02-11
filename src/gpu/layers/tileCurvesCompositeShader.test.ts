import { describe, expect, it } from 'vitest';
import shaderSource from '../shaders/tileCurvesComposite.wgsl?raw';

describe('tileCurvesComposite shader selection sampling', () => {
  it('clamps selection coordinates to texture bounds', () => {
    expect(shaderSource).toContain('let selection_dims = textureDimensions(selection_tex);');
    expect(shaderSource).toContain('let sel_x = min(global_xy.x, selection_dims.x - 1u);');
    expect(shaderSource).toContain('let sel_y = min(global_xy.y, selection_dims.y - 1u);');
  });

  it('does not sample selection texture with unclamped global coordinates', () => {
    expect(shaderSource).not.toContain(
      'textureLoad(selection_tex, vec2<i32>(i32(canvas_x), i32(canvas_y)), 0).r'
    );
  });
});
