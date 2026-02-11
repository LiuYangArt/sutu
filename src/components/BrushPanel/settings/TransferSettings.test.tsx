import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TransferSettings } from './TransferSettings';
import { DEFAULT_TRANSFER_SETTINGS, useToolStore } from '@/stores/tool';

function getMinimumSliders(): HTMLInputElement[] {
  return screen.getAllByText('Minimum').map((label) => {
    const row = label.closest('.brush-setting-row') as HTMLElement | null;
    expect(row).toBeTruthy();
    const slider = row?.querySelector('input[type="range"]') as HTMLInputElement | null;
    expect(slider).toBeTruthy();
    return slider as HTMLInputElement;
  });
}

describe('TransferSettings', () => {
  beforeEach(() => {
    useToolStore.setState({
      transferEnabled: true,
      transfer: { ...DEFAULT_TRANSFER_SETTINGS },
    });
  });

  it('Transfer 面板不再显示基础 Flow/Opacity 参数', () => {
    const { container } = render(<TransferSettings />);
    const labels = Array.from(container.querySelectorAll('.brush-setting-label')).map((node) =>
      node.textContent?.trim()
    );

    expect(labels).toContain('Opacity Jitter');
    expect(labels).toContain('Flow Jitter');
    expect(labels).not.toContain('Flow');
    expect(labels).not.toContain('Opacity');
  });

  it('Control=Off 时 Minimum 可见且禁用', () => {
    render(<TransferSettings />);
    const minimumSliders = getMinimumSliders();

    expect(minimumSliders).toHaveLength(2);
    minimumSliders.forEach((slider) => {
      expect(slider).toBeDisabled();
    });
  });

  it('切换到 Pen Pressure 后 Minimum 可编辑', () => {
    render(<TransferSettings />);
    const controls = screen.getAllByRole('combobox');
    const opacityControl = controls[0];
    expect(opacityControl).toBeDefined();
    if (!opacityControl) {
      throw new Error('未找到 Opacity Control 下拉框');
    }

    fireEvent.change(opacityControl, { target: { value: 'penPressure' } });

    const minimumSliders = getMinimumSliders();
    expect(minimumSliders[0]).not.toBeDisabled();
    expect(minimumSliders[1]).toBeDisabled();
  });
});
