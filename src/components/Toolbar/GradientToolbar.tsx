import { useEffect, useRef, useState } from 'react';
import {
  useGradientStore,
  type ColorStop,
  type GradientShape,
  type OpacityStop,
} from '@/stores/gradient';
import { usePanelStore } from '@/stores/panel';
import { useToolStore } from '@/stores/tool';
import { buildGradientPreviewCss } from '@/components/GradientEditor/utils';
import { BLEND_MODE_MENU_ITEMS, getBlendModeLabelKey } from '@/utils/blendModeMenu';
import { useI18n } from '@/i18n';
import { getGradientPresetDisplayName } from '@/components/GradientEditor/presetI18n';

const SHAPE_OPTIONS: GradientShape[] = ['linear', 'radial', 'angle', 'reflected', 'diamond'];

function buildPresetPreviewCss(
  colorStops: ColorStop[],
  opacityStops: OpacityStop[],
  foregroundColor: string,
  backgroundColor: string
): string {
  return buildGradientPreviewCss(colorStops, opacityStops, foregroundColor, backgroundColor, true);
}

export function GradientToolbar(): JSX.Element {
  const { t } = useI18n();
  const [blendMenuOpen, setBlendMenuOpen] = useState(false);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const blendMenuRef = useRef<HTMLDivElement | null>(null);
  const presetMenuRef = useRef<HTMLDivElement | null>(null);

  const presets = useGradientStore((s) => s.presets);
  const settings = useGradientStore((s) => s.settings);
  const setActivePreset = useGradientStore((s) => s.setActivePreset);
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

  const activeBlendModeLabel = t(getBlendModeLabelKey(settings.blendMode));
  const toggleGradientEditor = () =>
    (isGradientPanelOpen ? closePanel : openPanel)('gradient-panel');

  const previewCss = buildGradientPreviewCss(
    settings.customGradient.colorStops,
    settings.customGradient.opacityStops,
    foregroundColor,
    backgroundColor,
    settings.transparency
  );

  useEffect(() => {
    if (!blendMenuOpen && !presetMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const menu = blendMenuRef.current;
      const presetMenu = presetMenuRef.current;
      const target = event.target as Node;
      if (menu?.contains(target) || presetMenu?.contains(target)) return;
      setBlendMenuOpen(false);
      setPresetMenuOpen(false);
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
    };
  }, [blendMenuOpen, presetMenuOpen]);

  return (
    <div className="toolbar-section gradient-settings">
      <div className="toolbar-gradient-preset-select" ref={presetMenuRef}>
        <div className="toolbar-gradient-preview-group">
          <button
            className={`gradient-preview-trigger ${isGradientPanelOpen ? 'active' : ''}`}
            title={t('toolbar.gradient.openGradientEditor')}
            onClick={toggleGradientEditor}
          >
            <span className="gradient-preview-chip" style={{ backgroundImage: previewCss }} />
          </button>
          <button
            type="button"
            className={`toolbar-gradient-preset-toggle ${presetMenuOpen ? 'active' : ''}`}
            title={t('toolbar.gradient.quickPresets')}
            onClick={() => setPresetMenuOpen((open) => !open)}
            aria-haspopup="listbox"
            aria-expanded={presetMenuOpen}
          >
            ▾
          </button>
        </div>

        {presetMenuOpen && (
          <div
            className="toolbar-gradient-preset-dropdown"
            role="listbox"
            aria-label={t('toolbar.gradient.gradientPresets')}
          >
            {presets.map((preset) => {
              const active = preset.id === settings.activePresetId;
              const displayName = getGradientPresetDisplayName(preset, t);
              const presetPreview = buildPresetPreviewCss(
                preset.colorStops,
                preset.opacityStops,
                foregroundColor,
                backgroundColor
              );

              return (
                <button
                  key={preset.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`toolbar-gradient-preset-option ${active ? 'active' : ''}`}
                  onClick={() => {
                    setActivePreset(preset.id);
                    setPresetMenuOpen(false);
                  }}
                  title={displayName}
                >
                  <span
                    className="toolbar-gradient-preset-option-preview"
                    style={{ backgroundImage: presetPreview }}
                  />
                  <span className="toolbar-gradient-preset-option-name">{displayName}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="gradient-shape-group">
        {SHAPE_OPTIONS.map((shape) => {
          const label = t(`toolbar.gradient.shape.${shape}`);
          return (
            <button
              key={shape}
              className={`shape-btn ${settings.shape === shape ? 'active' : ''}`}
              onClick={() => setShape(shape)}
              title={label}
            >
              {label[0]}
            </button>
          );
        })}
      </div>

      <div className="setting gradient-setting compact">
        <span className="setting-label">{t('toolbar.gradient.mode')}</span>
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
              aria-label={t('toolbar.gradient.blendMode')}
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
                    {t(item.labelKey)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <label className="setting gradient-setting">
        <span className="setting-label">{t('toolbar.gradient.opacity')}</span>
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
          title={t('toolbar.gradient.reverseGradient')}
        >
          {t('toolbar.gradient.reverse')}
        </button>
        <button
          className={`tool-option-btn ${settings.dither ? 'active' : ''}`}
          onClick={() => setDither(!settings.dither)}
          title={t('toolbar.gradient.ditherGradient')}
        >
          {t('toolbar.gradient.dither')}
        </button>
        <button
          className={`tool-option-btn ${settings.transparency ? 'active' : ''}`}
          onClick={() => setTransparency(!settings.transparency)}
          title={t('toolbar.gradient.useOpacityStops')}
        >
          {t('toolbar.gradient.transparency')}
        </button>
      </div>
    </div>
  );
}
