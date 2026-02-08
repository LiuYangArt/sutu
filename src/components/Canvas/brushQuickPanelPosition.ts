export interface BrushQuickPanelPositionInput {
  anchorX: number;
  anchorY: number;
  panelWidth: number;
  panelHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
  offset?: number;
}

export interface BrushQuickPanelPosition {
  left: number;
  top: number;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

export function calculateBrushQuickPanelPosition(
  input: BrushQuickPanelPositionInput
): BrushQuickPanelPosition {
  const margin = input.margin ?? 12;
  const offset = input.offset ?? 10;

  let left = input.anchorX + offset;
  let top = input.anchorY + offset;

  if (left + input.panelWidth > input.viewportWidth - margin) {
    left = input.anchorX - input.panelWidth - offset;
  }

  if (top + input.panelHeight > input.viewportHeight - margin) {
    top = input.anchorY - input.panelHeight - offset;
  }

  const maxLeft = input.viewportWidth - input.panelWidth - margin;
  const maxTop = input.viewportHeight - input.panelHeight - margin;

  return {
    left: clamp(left, margin, maxLeft),
    top: clamp(top, margin, maxTop),
  };
}
