import { useEffect, useRef, useState } from 'react';
import type { BlendMode } from '@/stores/document';
import { useGradientStore, type GradientShape } from '@/stores/gradient';
import { usePanelStore } from '@/stores/panel';
import { useToolStore } from '@/stores/tool';
import { buildGradientPreviewCss } from '@/components/GradientEditor/utils';

interface BlendModeOption {
  value: BlendMode;
  label: string;
}

const BLEND_MODE_GROUPS: ReadonlyArray<ReadonlyArray<BlendModeOption>> = [
  [
    { value: 'normal', label: 'Normal' },
    { value: 'dissolve', label: 'Dissolve' },
  ],
  [
    { value: 'darken', label: 'Darken' },
    { value: 'multiply', label: 'Multiply' },
    { value: 'color-burn', label: 'Color Burn' },
    { value: 'linear-burn', label: 'Linear Burn' },
    { value: 'darker-color', label: 'Darker Color' },
  ],
  [
    { value: 'lighten', label: 'Lighten' },
    { value: 'screen', label: 'Screen' },
    { value: 'color-dodge', label: 'Color Dodge' },
    { value: 'linear-dodge', label: 'Linear Dodge (Add)' },
    { value: 'lighter-color', label: 'Lighter Color' },
  ],
  [
    { value: 'overlay', label: 'Overlay' },
    { value: 'soft-light', label: 'Soft Light' },
    { value: 'hard-light', label: 'Hard Light' },
    { value: 'vivid-light', label: 'Vivid Light' },
    { value: 'linear-light', label: 'Linear Light' },
    { value: 'pin-light', label: 'Pin Light' },
    { value: 'hard-mix', label: 'Hard Mix' },
  ],
  [
    { value: 'difference', label: 'Difference' },
    { value: 'exclusion', label: 'Exclusion' },
    { value: 'subtract', label: 'Subtract' },
    { value: 'divide', label: 'Divide' },
  ],
  [
    { value: 'hue', label: 'Hue' },
    { value: 'saturation', label: 'Saturation' },
    { value: 'color', label: 'Color' },
    { value: 'luminosity', label: 'Luminosity' },
  ],
];

type BlendModeMenuItem =
  | { kind: 'mode'; value: BlendMode; label: string }
  | { kind: 'separator'; key: string };

function buildBlendModeMenuItems(
  groups: ReadonlyArray<ReadonlyArray<BlendModeOption>>
): BlendModeMenuItem[] {
  const items: BlendModeMenuItem[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    if (!group) continue;
    for (const mode of group) {
      items.push({ kind: 'mode', ...mode });
    }
    if (i < groups.length - 1) {
      items.push({ kind: 'separator', key: `sep-${i}` });
    }
  }
  return items;
}

function buildBlendModeLabelMap(
  groups: ReadonlyArray<ReadonlyArray<BlendModeOption>>
): Map<BlendMode, string> {
  const map = new Map<BlendMode, string>();
  for (const group of groups) {
    for (const mode of group) {
      map.set(mode.value, mode.label);
    }
  }
  return map;
}

const BLEND_MODE_MENU_ITEMS: BlendModeMenuItem[] = buildBlendModeMenuItems(BLEND_MODE_GROUPS);
const BLEND_MODE_LABEL_MAP = buildBlendModeLabelMap(BLEND_MODE_GROUPS);

function getBlendModeLabel(mode: BlendMode): string {
  return BLEND_MODE_LABEL_MAP.get(mode) ?? 'Normal';
}

const SHAPE_OPTIONS: Array<{ value: GradientShape; label: string }> = [
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
  { value: 'angle', label: 'Angle' },
  { value: 'reflected', label: 'Reflected' },
  { value: 'diamond', label: 'Diamond' },
];

export function GradientToolbar() {
  const [blendMenuOpen, setBlendMenuOpen] = useState(false);
  const blendMenuRef = useRef<HTMLDivElement | null>(null);

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

  const activeBlendModeLabel = getBlendModeLabel(settings.blendMode);

  const previewCss = buildGradientPreviewCss(
    settings.customGradient.colorStops,
    settings.customGradient.opacityStops,
    foregroundColor,
    backgroundColor,
    settings.transparency
  );

  useEffect(() => {
    if (!blendMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const menu = blendMenuRef.current;
      if (!menu) return;
      if (menu.contains(event.target as Node)) return;
      setBlendMenuOpen(false);
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
    };
  }, [blendMenuOpen]);

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

      <div className="setting gradient-setting compact">
        <span className="setting-label">Mode</span>
        <div className="blend-mode-select gradient-blend-mode-select" ref={blendMenuRef}>
          <button
            type="button"
            className="blend-mode-trigger"
            onClick={() => setBlendMenuOpen((open) => !open)}
            aria-haspopup="listbox"
            aria-expanded={blendMenuOpen}
            title={activeBlendModeLabel}
          >
            <span className="blend-mode-trigger-label">{activeBlendModeLabel}</span>
            <span className="blend-mode-trigger-chevron" aria-hidden>
              ▾
            </span>
          </button>

          {blendMenuOpen && (
            <div
              className="blend-mode-dropdown gradient-blend-mode-dropdown"
              role="listbox"
              aria-label="Blend Mode"
            >
              {BLEND_MODE_MENU_ITEMS.map((item) => {
                if (item.kind === 'separator') {
                  return <div key={item.key} className="blend-mode-divider" aria-hidden />;
                }

                const isActive = item.value === settings.blendMode;
                return (
                  <button
                    key={item.value}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={`blend-mode-option ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      setBlendMode(item.value);
                      setBlendMenuOpen(false);
                    }}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

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
