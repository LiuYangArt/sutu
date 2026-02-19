import { describe, expect, it } from 'vitest';
import shaderSource from '../shaders/computeDualBlend.wgsl?raw';

describe('computeDualBlend shader contracts', () => {
  it('uses Krita/PS-aligned hard mix and linear height formulas', () => {
    expect(shaderSource).toContain('return clamp(3.0 * p - 2.0 * (1.0 - s), 0.0, 1.0);');
    expect(shaderSource).toContain('let m = 10.0 * p;');
    expect(shaderSource).toContain('return clamp(max((1.0 - s) * m, m - s), 0.0, 1.0);');

    expect(shaderSource).not.toContain('select(0.0, 1.0, p + s >= 1.0);');
    expect(shaderSource).not.toContain('return p * (0.5 + s * 0.5);');
  });

  it('allows alpha lift only for targeted modes', () => {
    expect(shaderSource).toContain('fn dual_mode_allows_alpha_lift(mode: u32) -> bool {');
    expect(shaderSource).toContain('return mode == 2u || mode == 3u || mode == 6u || mode == 7u;');
    expect(shaderSource).toContain('let ratio = blended / primary.a;');
    expect(shaderSource).toContain('let clamped_alpha = primary.a * clamp(ratio, 0.0, 1.0);');
    expect(shaderSource).toContain('let lifted_alpha = blended;');
    expect(shaderSource).toContain('select(clamped_alpha, lifted_alpha, allow_lift)');

    expect(shaderSource).not.toContain('let scale = clamp(blended / primary.a, 0.0, 1.0);');
  });
});
