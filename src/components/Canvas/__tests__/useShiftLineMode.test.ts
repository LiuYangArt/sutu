import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useShiftLineMode } from '../useShiftLineMode';

function dispatchKey(type: 'keydown' | 'keyup', key: 'Shift' | 'Control'): void {
  window.dispatchEvent(
    new KeyboardEvent(type, {
      key,
      bubbles: true,
      cancelable: true,
    })
  );
}

describe('useShiftLineMode', () => {
  it('updates anchor on stroke end', () => {
    const { result, unmount } = renderHook(() => useShiftLineMode({ enabled: true }));

    act(() => {
      result.current.onStrokeEnd({ x: 12, y: 34 });
    });

    expect(result.current.getAnchorPoint()).toEqual({ x: 12, y: 34 });
    unmount();
  });

  it('snaps guide line to 45 degrees when Ctrl+Shift pressed', () => {
    const { result, unmount } = renderHook(() => useShiftLineMode({ enabled: true }));

    act(() => {
      result.current.onStrokeEnd({ x: 0, y: 0 });
    });

    act(() => {
      dispatchKey('keydown', 'Shift');
      dispatchKey('keydown', 'Control');
    });

    act(() => {
      result.current.updateCursor(10, 3);
    });

    const guide = result.current.getGuideLine();
    expect(guide).not.toBeNull();
    expect(guide?.end.y).toBeCloseTo(0, 5);
    expect(guide?.end.x).toBeCloseTo(Math.hypot(10, 3), 5);

    unmount();
  });

  it('constrains points to locked segment and clamps', () => {
    const { result, unmount } = renderHook(() => useShiftLineMode({ enabled: true }));

    act(() => {
      result.current.onStrokeEnd({ x: 0, y: 0 });
      dispatchKey('keydown', 'Shift');
    });

    act(() => {
      result.current.lockLine({ x: 10, y: 0 });
    });

    const projected = result.current.constrainPoint(5, 5);
    expect(projected.x).toBeCloseTo(5, 5);
    expect(projected.y).toBeCloseTo(0, 5);

    const clampedEnd = result.current.constrainPoint(20, 0);
    expect(clampedEnd.x).toBeCloseTo(10, 5);
    expect(clampedEnd.y).toBeCloseTo(0, 5);

    const clampedStart = result.current.constrainPoint(-5, 0);
    expect(clampedStart.x).toBeCloseTo(0, 5);
    expect(clampedStart.y).toBeCloseTo(0, 5);

    unmount();
  });

  it('uses locked guide end as next anchor on stroke end', () => {
    const { result, unmount } = renderHook(() => useShiftLineMode({ enabled: true }));

    act(() => {
      result.current.onStrokeEnd({ x: 0, y: 0 });
      dispatchKey('keydown', 'Shift');
    });

    act(() => {
      result.current.lockLine({ x: 10, y: 0 });
    });

    act(() => {
      // Simulate that the actual last dab ended at a different position (e.g. clamped/projection).
      result.current.onStrokeEnd({ x: 3, y: 0 });
    });

    expect(result.current.getAnchorPoint()).toEqual({ x: 10, y: 0 });
    unmount();
  });

  it('isLineMode is false without anchor', () => {
    const { result, unmount } = renderHook(() => useShiftLineMode({ enabled: true }));

    act(() => {
      dispatchKey('keydown', 'Shift');
    });

    expect(result.current.isLineMode()).toBe(false);
    unmount();
  });

  it('only responds to Shift keydown when focus is within focusContainerRef', () => {
    const focusContainer = document.createElement('div');
    focusContainer.tabIndex = -1;

    const otherButton = document.createElement('button');
    otherButton.textContent = 'other';

    document.body.appendChild(focusContainer);
    document.body.appendChild(otherButton);

    const { result, unmount } = renderHook(() =>
      useShiftLineMode({ enabled: true, focusContainerRef: { current: focusContainer } })
    );

    try {
      act(() => {
        result.current.onStrokeEnd({ x: 0, y: 0 });
        result.current.updateCursor(10, 0);
      });

      act(() => {
        otherButton.focus();
        dispatchKey('keydown', 'Shift');
      });

      expect(result.current.getGuideLine()).toBeNull();

      act(() => {
        focusContainer.focus();
        dispatchKey('keydown', 'Shift');
      });

      expect(result.current.getGuideLine()).not.toBeNull();
    } finally {
      unmount();
      focusContainer.remove();
      otherButton.remove();
    }
  });
});
