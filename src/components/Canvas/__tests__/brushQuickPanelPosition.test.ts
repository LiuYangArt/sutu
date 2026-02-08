import { describe, expect, it } from 'vitest';
import { calculateBrushQuickPanelPosition } from '../brushQuickPanelPosition';

describe('calculateBrushQuickPanelPosition', () => {
  it('positions near the anchor when there is enough space', () => {
    const pos = calculateBrushQuickPanelPosition({
      anchorX: 100,
      anchorY: 80,
      panelWidth: 300,
      panelHeight: 260,
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    expect(pos).toEqual({ left: 110, top: 90 });
  });

  it('flips to the left when right side overflows', () => {
    const pos = calculateBrushQuickPanelPosition({
      anchorX: 1240,
      anchorY: 100,
      panelWidth: 300,
      panelHeight: 260,
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    expect(pos.left).toBe(930);
    expect(pos.top).toBe(110);
  });

  it('flips upward when bottom side overflows', () => {
    const pos = calculateBrushQuickPanelPosition({
      anchorX: 200,
      anchorY: 700,
      panelWidth: 300,
      panelHeight: 260,
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    expect(pos.left).toBe(210);
    expect(pos.top).toBe(430);
  });

  it('clamps to margin when panel is larger than viewport bounds', () => {
    const pos = calculateBrushQuickPanelPosition({
      anchorX: 20,
      anchorY: 20,
      panelWidth: 2000,
      panelHeight: 1400,
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    expect(pos).toEqual({ left: 12, top: 12 });
  });
});
