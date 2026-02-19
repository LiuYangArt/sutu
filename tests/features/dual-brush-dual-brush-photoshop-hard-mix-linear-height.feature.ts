/**
 * @description 功能测试: [Bug]: Dual Brush 混合模式与 Photoshop 不对齐（Hard Mix / Linear Height）
 * @issue #148
 */
import { describe, it, expect } from 'vitest';
import shaderSource from '@/gpu/shaders/computeDualBlend.wgsl?raw';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

describe('[Bug]: Dual Brush 混合模式与 Photoshop 不对齐（Hard Mix / Linear Height）', () => {
  it('Overlay 在高 alpha 区应允许提亮（不应被统一截断）', () => {
    const primary = 0.75;
    const secondary = 0.8;
    const overlay =
      primary < 0.5
        ? 2.0 * primary * secondary
        : 1.0 - 2.0 * (1.0 - primary) * (1.0 - secondary);

    expect(overlay).toBeGreaterThan(primary);
    expect(shaderSource).toContain('return mode == 2u || mode == 3u || mode == 6u || mode == 7u;');
  });

  it('Color Dodge 在代表性样本下应允许 alpha 提升（不再被统一截断）', () => {
    const primary = 0.25;
    const secondary = 0.8;
    const blended = Math.min(1, primary / (1 - secondary));
    expect(blended).toBeGreaterThan(primary);

    expect(shaderSource).toContain('fn dual_mode_allows_alpha_lift(mode: u32) -> bool {');
    expect(shaderSource).toContain('return mode == 2u || mode == 3u || mode == 6u || mode == 7u;');
    expect(shaderSource).toContain('let clamped_alpha = primary.a * clamp(ratio, 0.0, 1.0);');
    expect(shaderSource).toContain('let lifted_alpha = blended;');
    expect(shaderSource).toContain('select(clamped_alpha, lifted_alpha, allow_lift)');
  });

  it('Hard Mix 应为连续公式（非二值阈值）', () => {
    const primary = 0.35;
    const secondary = 0.5;
    const blended = clamp01(3.0 * primary - 2.0 * (1.0 - secondary));

    expect(blended).toBeCloseTo(0.05, 6);
    expect(blended).toBeGreaterThan(0);
    expect(blended).toBeLessThan(1);
    expect(shaderSource).toContain('return clamp(3.0 * p - 2.0 * (1.0 - s), 0.0, 1.0);');
  });

  it('Linear Height 应使用高增益 height 语义公式', () => {
    const primary = 0.35;
    const secondary = 0.8;
    const m = 10.0 * primary;
    const blended = clamp01(Math.max((1.0 - secondary) * m, m - secondary));

    expect(blended).toBe(1);
    expect(shaderSource).toContain('let m = 10.0 * p;');
    expect(shaderSource).toContain('return clamp(max((1.0 - s) * m, m - s), 0.0, 1.0);');
  });
});
