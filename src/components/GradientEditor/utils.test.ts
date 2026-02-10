import { describe, expect, it } from 'vitest';
import { buildGradientPreviewCss } from './utils';
import type { ColorStop, OpacityStop } from '@/stores/gradient';

describe('GradientEditor preview css', () => {
  it('encodes opacity stops into preview gradient', () => {
    const colorStops: ColorStop[] = [
      { id: 'c0', position: 0, source: 'foreground', color: '#000000' },
      { id: 'c1', position: 1, source: 'foreground', color: '#000000' },
    ];
    const opacityStops: OpacityStop[] = [
      { id: 'o0', position: 0, opacity: 1 },
      { id: 'o1', position: 1, opacity: 0 },
    ];

    const css = buildGradientPreviewCss(colorStops, opacityStops, '#ff8000', '#ffffff', true);

    expect(css).toContain('rgba(');
    expect(css).toContain('0.000');
    expect(css).toContain('repeating-conic-gradient');
  });
});
