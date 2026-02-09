import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { SettingsPanel } from '../index';
import { useSettingsStore } from '@/stores/settings';

function setupScrollableMain(main: HTMLDivElement): void {
  Object.defineProperty(main, 'clientWidth', { value: 200, configurable: true });
  Object.defineProperty(main, 'offsetWidth', { value: 220, configurable: true });
  Object.defineProperty(main, 'clientHeight', { value: 200, configurable: true });
  Object.defineProperty(main, 'offsetHeight', { value: 220, configurable: true });
  Object.defineProperty(main, 'scrollWidth', { value: 200, configurable: true });
  Object.defineProperty(main, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(main, 'scrollTop', { value: 0, writable: true, configurable: true });
  Object.defineProperty(main, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      right: 220,
      bottom: 220,
      width: 220,
      height: 220,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

describe('SettingsPanel scrollbar pen drag', () => {
  beforeAll(() => {
    if (typeof window.PointerEvent === 'undefined') {
      Object.defineProperty(window, 'PointerEvent', {
        value: MouseEvent,
        configurable: true,
      });
    }
  });

  beforeEach(() => {
    act(() => {
      useSettingsStore.setState({ isOpen: true, activeTab: 'appearance' });
    });
  });

  afterEach(() => {
    act(() => {
      useSettingsStore.setState({ isOpen: false, activeTab: 'appearance' });
    });
  });

  it('pen 按住滚动条后离开区域，仍持续滚动直到 pointerup', () => {
    const { container } = render(<SettingsPanel />);
    const main = container.querySelector('.settings-main') as HTMLDivElement;
    expect(main).toBeTruthy();

    setupScrollableMain(main);

    Object.defineProperty(main, 'setPointerCapture', { value: vi.fn(), configurable: true });
    Object.defineProperty(main, 'releasePointerCapture', { value: vi.fn(), configurable: true });

    fireEvent.pointerDown(main, {
      pointerId: 11,
      pointerType: 'pen',
      button: 0,
      buttons: 1,
      clientX: 210,
      clientY: 60,
    });

    fireEvent.pointerMove(window, {
      pointerId: 11,
      pointerType: 'pen',
      buttons: 1,
      clientX: 24,
      clientY: 100,
    });
    const afterPointerMove = main.scrollTop;
    expect(afterPointerMove).toBeGreaterThan(0);

    fireEvent.pointerUp(window, {
      pointerId: 11,
      pointerType: 'pen',
      clientX: 16,
      clientY: 120,
    });
    const stoppedScrollTop = main.scrollTop;

    fireEvent.pointerMove(window, {
      pointerId: 11,
      pointerType: 'pen',
      buttons: 1,
      clientX: 16,
      clientY: 170,
    });
    expect(main.scrollTop).toBe(stoppedScrollTop);
  });

  it('注册 window.pointerrawupdate 监听用于拖拽兜底', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<SettingsPanel />);

    expect(addSpy).toHaveBeenCalledWith('pointerrawupdate', expect.any(Function), {
      capture: true,
    });

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('pointerrawupdate', expect.any(Function), {
      capture: true,
    });
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('lostpointercapture 会终止滚动会话', () => {
    const { container } = render(<SettingsPanel />);
    const main = container.querySelector('.settings-main') as HTMLDivElement;
    expect(main).toBeTruthy();

    setupScrollableMain(main);

    Object.defineProperty(main, 'setPointerCapture', { value: vi.fn(), configurable: true });
    Object.defineProperty(main, 'releasePointerCapture', { value: vi.fn(), configurable: true });

    fireEvent.pointerDown(main, {
      pointerId: 12,
      pointerType: 'pen',
      button: 0,
      buttons: 1,
      clientX: 210,
      clientY: 70,
    });

    fireEvent.pointerMove(window, {
      pointerId: 12,
      pointerType: 'pen',
      buttons: 1,
      clientX: 20,
      clientY: 110,
    });
    expect(main.scrollTop).toBeGreaterThan(0);

    fireEvent.lostPointerCapture(main, {
      pointerId: 12,
      pointerType: 'pen',
      clientX: 20,
      clientY: 110,
    });
    const stoppedScrollTop = main.scrollTop;

    fireEvent.pointerMove(window, {
      pointerId: 12,
      pointerType: 'pen',
      buttons: 1,
      clientX: 20,
      clientY: 170,
    });
    expect(main.scrollTop).toBe(stoppedScrollTop);
  });
});
