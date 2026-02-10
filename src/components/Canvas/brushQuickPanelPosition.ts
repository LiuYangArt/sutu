export interface BrushQuickPanelPositionInput {
  anchorX: number;
  anchorY: number;
  panelWidth: number;
  panelHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
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
  const halfWidth = input.panelWidth / 2;
  const halfHeight = input.panelHeight / 2;
  const left = input.anchorX - halfWidth;
  const top = input.anchorY - halfHeight;

  const maxLeft = input.viewportWidth - input.panelWidth - margin;
  const maxTop = input.viewportHeight - input.panelHeight - margin;

  return {
    left: clamp(left, margin, maxLeft),
    top: clamp(top, margin, maxTop),
  };
}
