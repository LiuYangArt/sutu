import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { usePanelDrag } from './usePanelDrag';

interface DragHandleProps {
  withChild?: boolean;
  onDrag: (dx: number, dy: number) => void;
  onDragEnd?: () => void;
}

function DragHandle({ withChild = false, onDrag, onDragEnd }: DragHandleProps): JSX.Element {
  const events = usePanelDrag({
    onDrag,
    onDragEnd,
  });

  return (
    <div data-testid="drag-handle" {...events}>
      {withChild ? <span data-testid="drag-child">title</span> : null}
    </div>
  );
}

describe('usePanelDrag', () => {
  beforeAll(() => {
    if (typeof window.PointerEvent === 'undefined') {
      Object.defineProperty(window, 'PointerEvent', {
        value: MouseEvent,
        configurable: true,
      });
    }
  });

  it('pointerleave 不会中断拖拽，直到 pointerup', () => {
    const onDrag = vi.fn();
    const onDragEnd = vi.fn();
    render(<DragHandle onDrag={onDrag} onDragEnd={onDragEnd} />);

    const handle = screen.getByTestId('drag-handle');
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperty(handle, 'setPointerCapture', {
      value: setPointerCapture,
      configurable: true,
    });
    Object.defineProperty(handle, 'releasePointerCapture', {
      value: releasePointerCapture,
      configurable: true,
    });

    fireEvent.pointerDown(handle, {
      pointerId: 1,
      button: 0,
      buttons: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientX: 120, clientY: 115 });
    fireEvent.pointerLeave(handle, { pointerId: 1, clientX: 120, clientY: 115 });
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientX: 132, clientY: 120 });

    expect(onDrag).toHaveBeenNthCalledWith(1, 20, 15);
    expect(onDrag).toHaveBeenNthCalledWith(2, 12, 5);
    expect(onDragEnd).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 132, clientY: 120 });
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(releasePointerCapture).toHaveBeenCalledTimes(1);
  });

  it('pointercancel 会结束拖拽并释放 capture', () => {
    const onDrag = vi.fn();
    const onDragEnd = vi.fn();
    render(<DragHandle onDrag={onDrag} onDragEnd={onDragEnd} />);

    const handle = screen.getByTestId('drag-handle');
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperty(handle, 'setPointerCapture', {
      value: setPointerCapture,
      configurable: true,
    });
    Object.defineProperty(handle, 'releasePointerCapture', {
      value: releasePointerCapture,
      configurable: true,
    });

    fireEvent.pointerDown(handle, {
      pointerId: 2,
      button: 0,
      buttons: 1,
      clientX: 40,
      clientY: 20,
    });
    fireEvent.pointerCancel(handle, { pointerId: 2, clientX: 45, clientY: 24 });

    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(releasePointerCapture).toHaveBeenCalledTimes(1);
  });

  it('在子元素按下时，capture 绑定到标题栏自身而不是子元素', () => {
    const onDrag = vi.fn();
    render(<DragHandle withChild onDrag={onDrag} />);

    const handle = screen.getByTestId('drag-handle');
    const child = screen.getByTestId('drag-child');
    const handleCapture = vi.fn();
    const childCapture = vi.fn();
    Object.defineProperty(handle, 'setPointerCapture', {
      value: handleCapture,
      configurable: true,
    });
    Object.defineProperty(child, 'setPointerCapture', { value: childCapture, configurable: true });

    fireEvent.pointerDown(child, { pointerId: 7, button: 0, buttons: 1, clientX: 12, clientY: 8 });

    expect(handleCapture).toHaveBeenCalledTimes(1);
    expect(childCapture).not.toHaveBeenCalled();
  });
});
