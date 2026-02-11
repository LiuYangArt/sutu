import { describe, expect, it } from 'vitest';
import { buildGradientPreviewCss, sampleColorHexAt, sampleOpacityAt } from './utils';
import type { ColorStop, OpacityStop } from '@/stores/gradient';

describe('GradientEditor preview css', () => {
  it('encodes opacity stops into preview gradient', () => {
    const colorStops: ColorStop[] = [
      { id: 'c0', position: 0, midpoint: 0.5, source: 'foreground', color: '#000000' },
      { id: 'c1', position: 1, midpoint: 0.5, source: 'foreground', color: '#000000' },
    ];
    const opacityStops: OpacityStop[] = [
      { id: 'o0', position: 0, midpoint: 0.5, opacity: 1 },
      { id: 'o1', position: 1, midpoint: 0.5, opacity: 0 },
    ];

    const css = buildGradientPreviewCss(colorStops, opacityStops, '#ff8000', '#ffffff', true);

    expect(css).toContain('rgba(');
    expect(css).toContain('0.000');
    expect(css).toContain('repeating-conic-gradient');
  });

  it('shifts interpolation when midpoint changes', () => {
    const colorStops: ColorStop[] = [
      { id: 'c0', position: 0, midpoint: 0.5, source: 'fixed', color: '#000000' },
      { id: 'c1', position: 1, midpoint: 0.2, source: 'fixed', color: '#ffffff' },
    ];

    const nearLeft = sampleColorHexAt(0.2, colorStops, '#000000', '#ffffff');
    const nearMiddle = sampleColorHexAt(0.5, colorStops, '#000000', '#ffffff');

    expect(nearLeft).toBe('#808080');
    expect(nearMiddle).toBe('#bdbdbd');
  });

  it('samples opacity with midpoint remap', () => {
    const opacityStops: OpacityStop[] = [
      { id: 'o0', position: 0, midpoint: 0.5, opacity: 1 },
      { id: 'o1', position: 1, midpoint: 0.2, opacity: 0 },
    ];

    expect(sampleOpacityAt(0.2, opacityStops)).toBeCloseTo(0.5, 2);
    expect(sampleOpacityAt(0.5, opacityStops)).toBeLessThan(0.3);
  });
});
