import { describe, expect, it } from 'vitest';
import shaderSource from '../shaders/tileSelectionFillComposite.wgsl?raw';

describe('tileSelectionFillComposite shader selection sampling', () => {
  it('clamps selection coordinates to texture bounds', () => {
    expect(shaderSource).toContain('let selection_dims = textureDimensions(selection_tex);');
    expect(shaderSource).toContain('let sel_x = min(global_xy.x, selection_dims.x - 1u);');
    expect(shaderSource).toContain('let sel_y = min(global_xy.y, selection_dims.y - 1u);');
  });

  it('does not sample selection texture with unclamped global coordinates', () => {
    expect(shaderSource).not.toContain(
      'textureLoad(selection_tex, vec2<i32>(i32(global_xy.x), i32(global_xy.y)), 0).r'
    );
  });

  it('uses source-over blending against destination alpha', () => {
    expect(shaderSource).toContain(
      '(uniforms.fill_color.rgb * src_alpha + dst.rgb * dst_alpha * (1.0 - src_alpha)) / out_alpha;'
    );
    expect(shaderSource).not.toContain('src_alpha * (1.0 - dst_alpha)');
  });
});
