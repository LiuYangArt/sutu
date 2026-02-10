import type { BlendMode } from '@/stores/document';
import { useGradientStore, type GradientShape } from '@/stores/gradient';
import { usePanelStore } from '@/stores/panel';
import { useToolStore } from '@/stores/tool';
import { buildGradientPreviewCss } from '@/components/GradientEditor/utils';

interface BlendModeOption {
  value: BlendMode;
  label: string;
}

const BLEND_MODE_OPTIONS: BlendModeOption[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'dissolve', label: 'Dissolve' },
  { value: 'darken', label: 'Darken' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'linear-burn', label: 'Linear Burn' },
  { value: 'darker-color', label: 'Darker Color' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'screen', label: 'Screen' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'linear-dodge', label: 'Linear Dodge' },
  { value: 'lighter-color', label: 'Lighter Color' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'vivid-light', label: 'Vivid Light' },
  { value: 'linear-light', label: 'Linear Light' },
  { value: 'pin-light', label: 'Pin Light' },
  { value: 'hard-mix', label: 'Hard Mix' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'subtract', label: 'Subtract' },
  { value: 'divide', label: 'Divide' },
  { value: 'hue', label: 'Hue' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosity' },
];

const SHAPE_OPTIONS: Array<{ value: GradientShape; label: string }> = [
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
  { value: 'angle', label: 'Angle' },
  { value: 'reflected', label: 'Reflected' },
  { value: 'diamond', label: 'Diamond' },
];

export function GradientToolbar() {
  const settings = useGradientStore((s) => s.settings);
  const setShape = useGradientStore((s) => s.setShape);
  const setBlendMode = useGradientStore((s) => s.setBlendMode);
  const setOpacity = useGradientStore((s) => s.setOpacity);
  const setReverse = useGradientStore((s) => s.setReverse);
  const setDither = useGradientStore((s) => s.setDither);
  const setTransparency = useGradientStore((s) => s.setTransparency);

  const foregroundColor = useToolStore((s) => s.brushColor);
  const backgroundColor = useToolStore((s) => s.backgroundColor);

  const isGradientPanelOpen = usePanelStore((s) => s.panels['gradient-panel']?.isOpen ?? false);
  const openPanel = usePanelStore((s) => s.openPanel);
  const closePanel = usePanelStore((s) => s.closePanel);

  const previewCss = buildGradientPreviewCss(
    settings.customGradient.colorStops,
    foregroundColor,
    backgroundColor
  );

  return (
    <div className="toolbar-section gradient-settings">
      <button
        className={`gradient-preview-trigger ${isGradientPanelOpen ? 'active' : ''}`}
        title="Open Gradient Editor"
        onClick={() => {
          if (isGradientPanelOpen) {
            closePanel('gradient-panel');
          } else {
            openPanel('gradient-panel');
          }
        }}
      >
        <span className="gradient-preview-chip" style={{ backgroundImage: previewCss }} />
      </button>

      <div className="gradient-shape-group">
        {SHAPE_OPTIONS.map((shape) => (
          <button
            key={shape.value}
            className={`shape-btn ${settings.shape === shape.value ? 'active' : ''}`}
            onClick={() => setShape(shape.value)}
            title={shape.label}
          >
            {shape.label[0]}
          </button>
        ))}
      </div>

      <label className="setting gradient-setting compact">
        <span className="setting-label">Mode</span>
        <select
          className="gradient-select"
          value={settings.blendMode}
          onChange={(event) => setBlendMode(event.target.value as BlendMode)}
        >
          {BLEND_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="setting gradient-setting">
        <span className="setting-label">Opacity</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={settings.opacity}
          onChange={(event) => setOpacity(Number(event.target.value))}
        />
        <span className="setting-value">{Math.round(settings.opacity * 100)}%</span>
      </label>

      <div className="gradient-toggle-group">
        <button
          className={`tool-option-btn ${settings.reverse ? 'active' : ''}`}
          onClick={() => setReverse(!settings.reverse)}
          title="Reverse gradient"
        >
          Reverse
        </button>
        <button
          className={`tool-option-btn ${settings.dither ? 'active' : ''}`}
          onClick={() => setDither(!settings.dither)}
          title="Dither gradient"
        >
          Dither
        </button>
        <button
          className={`tool-option-btn ${settings.transparency ? 'active' : ''}`}
          onClick={() => setTransparency(!settings.transparency)}
          title="Use opacity stops"
        >
          Transparency
        </button>
      </div>
    </div>
  );
}
