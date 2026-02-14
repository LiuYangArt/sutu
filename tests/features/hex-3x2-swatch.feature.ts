/**
 * @description 功能测试: [Feature]: 色盘布局调整：前景/背景色重排、HEX复制按钮与3x2 Swatch列表
 * @issue #126
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { ColorPanel } from '@/components/ColorPanel';
import { useToolStore } from '@/stores/tool';
import { useToastStore } from '@/stores/toast';

vi.mock('@/components/ColorPanel/SaturationSquare', () => ({
  SaturationSquare: () => React.createElement('div'),
}));

vi.mock('@/components/ColorPanel/VerticalHueSlider', () => ({
  VerticalHueSlider: () => React.createElement('div'),
}));

describe('[Feature]: 色盘布局调整：前景/背景色重排、HEX复制按钮与3x2 Swatch列表', () => {
  beforeEach(() => {
    useToolStore.setState({
      brushColor: '#112233',
      backgroundColor: '#ffffff',
      recentSwatches: [],
    });
    useToastStore.setState({ toasts: [] });
    vi.restoreAllMocks();
  });

  it('点击 HEX 后可复制 #RRGGBB 并用于粘贴', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(React.createElement(ColorPanel));
    fireEvent.click(screen.getByRole('button', { name: 'HEX' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(writeText).toHaveBeenCalledWith('#112233');
  });

  it('连续添加 7 次颜色后仅保留最新 6 个且顺序正确', () => {
    render(React.createElement(ColorPanel));
    const addButton = screen.getByRole('button', { name: 'Add Swatch' });
    const colors = ['#100000', '#200000', '#300000', '#400000', '#500000', '#600000', '#700000'];

    for (const color of colors) {
      act(() => {
        useToolStore.getState().setBrushColor(color);
      });
      fireEvent.click(addButton);
    }

    expect(useToolStore.getState().recentSwatches).toEqual([
      '#700000',
      '#600000',
      '#500000',
      '#400000',
      '#300000',
      '#200000',
    ]);
  });
});
