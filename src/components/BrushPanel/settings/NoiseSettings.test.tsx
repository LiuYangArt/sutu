import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NoiseSettings } from './NoiseSettings';

describe('NoiseSettings', () => {
  it('移除 noise 参数行，仅保留面板标题', () => {
    const { container } = render(<NoiseSettings />);

    expect(screen.getByText('Noise')).toBeTruthy();
    expect(screen.queryByText('Noise Size')).toBeNull();
    expect(screen.queryByText('Grain Size Jitter')).toBeNull();
    expect(screen.queryByText('Grain Density Jitter')).toBeNull();
    expect(container.querySelectorAll('input[type="range"]')).toHaveLength(0);
    expect(container.querySelector('.dynamics-group')).toBeNull();
  });
});
