import { describe, expect, it } from 'vitest';
import { calculateBrushQuickPanelPosition } from '../brushQuickPanelPosition';

describe('calculateBrushQuickPanelPosition', () => {
  it('centers panel around the anchor when there is enough space', () => {
    const pos = calculateBrushQuickPanelPosition({
      anchorX: 400,
      anchorY: 300,
      panelWidth: 300,
      panelHeight: 260,
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    expect(pos).toEqual({ left: 250, top: 170 });
  });

  it('clamps to right and top margins when centered position overflows viewport', () => {
    const pos = calculateBrushQuickPanelPosition({
      anchorX: 1240,
      anchorY: 100,
      panelWidth: 300,
      panelHeight: 260,
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    expect(pos.left).toBe(968);
    expect(pos.top).toBe(12);
  });

  it('clamps to bottom margin when centered position overflows downward', () => {
    const pos = calculateBrushQuickPanelPosition({
      anchorX: 200,
      anchorY: 700,
      panelWidth: 300,
      panelHeight: 260,
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    expect(pos.left).toBe(50);
    expect(pos.top).toBe(448);
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
