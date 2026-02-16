import { useState } from 'react';
import { Plus } from 'lucide-react';
import { usePatternLibraryStore } from '@/stores/pattern';
import { useToastStore } from '@/stores/toast';
import { useToolStore, ControlSource } from '@/stores/tool';
import { TEXTURE_SCALE_SLIDER_CONFIG } from '@/utils/sliderScales';
import { depthControlToSource, sourceToDepthControl } from '@/utils/textureDynamics';
import { TextureBlendMode } from '../types';
import { SliderRow, SelectRow, SelectOption } from '../BrushPanelComponents';
import { PatternPicker } from './PatternPicker';
import { useI18n } from '@/i18n';

export function TextureSettings(): JSX.Element {
  const { t } = useI18n();
  const {
    textureEnabled,
    textureSettings,
    setTextureSettings,
    patterns: brushPatterns,
  } = useToolStore();
  const [isAddingPattern, setIsAddingPattern] = useState(false);
  const libraryPatterns = usePatternLibraryStore((s) => s.patterns);
  const addPatternFromBrush = usePatternLibraryStore((s) => s.addPatternFromBrush);
  const pushToast = useToastStore((s) => s.pushToast);
  const patternId = textureSettings?.patternId;

  const disabled = !textureEnabled;
  const depthControlOptions: SelectOption[] = [
    { value: 'off', label: t('brushPanel.control.off') },
    { value: 'fade', label: t('brushPanel.control.fade') },
    { value: 'penPressure', label: t('brushPanel.control.penPressure') },
    { value: 'penTilt', label: t('brushPanel.control.penTilt') },
    { value: 'rotation', label: t('brushPanel.control.rotation') },
  ];

  const blendModeOptions: { value: TextureBlendMode; label: string }[] = [
    { value: 'multiply', label: t('blendMode.multiply') },
    { value: 'subtract', label: t('blendMode.subtract') },
    { value: 'darken', label: t('blendMode.darken') },
    { value: 'overlay', label: t('blendMode.overlay') },
    { value: 'colorDodge', label: t('blendMode.colorDodge') },
    { value: 'colorBurn', label: t('blendMode.colorBurn') },
    { value: 'linearBurn', label: t('blendMode.linearBurn') },
    { value: 'hardMix', label: t('blendMode.hardMix') },
    { value: 'linearHeight', label: t('brushPanel.texture.mode.linearHeight') },
    { value: 'height', label: t('brushPanel.texture.mode.height') },
  ];

  const depthControlSource = depthControlToSource(textureSettings.depthControl);
  const brushPatternFallback = patternId
    ? (brushPatterns.find((pattern) => pattern.id === patternId) ?? null)
    : null;
  const isPatternInLibrary = patternId
    ? libraryPatterns.some((pattern) => pattern.id === patternId)
    : false;
  const canAddCurrentPattern = !disabled && !!patternId && !isPatternInLibrary;
  const addButtonDisabled = !canAddCurrentPattern || isAddingPattern;
  const addButtonTitle = canAddCurrentPattern
    ? t('brushPanel.texture.addCurrentPatternToLibrary')
    : t('brushPanel.texture.patternAlreadyInLibrary');

  // Controls related to individual tip variation are disabled unless Texture Each Tip is on
  const tipVariationDisabled = disabled || !textureSettings.textureEachTip;
  const minimumDepthDisabled = tipVariationDisabled || depthControlSource === 'off';

  const handlePatternSelect = (newPatternId: string | null) => {
    setTextureSettings({ patternId: newPatternId });
  };

  const handleAddCurrentPattern = async () => {
    if (!canAddCurrentPattern || !patternId) return;
    setIsAddingPattern(true);
    try {
      const result = await addPatternFromBrush(patternId, brushPatternFallback?.name);
      setTextureSettings({ patternId: result.pattern.id });
      pushToast(
        result.added
          ? t('brushPanel.texture.toast.patternAddedToLibrary')
          : t('brushPanel.texture.toast.patternAlreadyExistsSwitched'),
        {
          variant: result.added ? 'success' : 'info',
        }
      );
    } catch (error) {
      console.error('[TextureSettings] Failed to add pattern from brush:', error);
      pushToast(t('brushPanel.texture.toast.failedToAddPattern'), { variant: 'error' });
    } finally {
      setIsAddingPattern(false);
    }
  };

  return (
    <div className="brush-panel-section">
      {/* Section header */}
      <div className="section-header-row">
        <div className="section-checkbox-label">
          <h4>{t('brushPanel.tab.texture')}</h4>
        </div>
      </div>

      {/* Pattern Picker */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`} style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 60 }}>
            {t('brushPanel.texture.pattern')}
          </span>
          <PatternPicker
            selectedId={patternId ?? null}
            onSelect={handlePatternSelect}
            disabled={disabled}
            thumbnailSize={32}
            fallbackPattern={
              brushPatternFallback
                ? {
                    id: brushPatternFallback.id,
                    name: brushPatternFallback.name,
                    width: brushPatternFallback.width,
                    height: brushPatternFallback.height,
                  }
                : null
            }
          />

          <label
            className={`flip-checkbox ${disabled ? 'disabled' : ''}`}
            style={{ marginLeft: 8 }}
          >
            <input
              type="checkbox"
              checked={textureSettings.invert}
              onChange={(e) => setTextureSettings({ invert: e.target.checked })}
              disabled={disabled}
            />
            <span>{t('brushPanel.texture.invert')}</span>
          </label>

          <button
            type="button"
            aria-label={t('brushPanel.texture.addPatternToLibrary')}
            title={addButtonTitle}
            onClick={() => void handleAddCurrentPattern()}
            disabled={addButtonDisabled}
            style={{
              width: 24,
              height: 24,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 4,
              border: '1px solid var(--border, #5a6474)',
              background: 'var(--bg-secondary, #1b2432)',
              color: 'var(--text-primary, #f2f6ff)',
              cursor: addButtonDisabled ? 'not-allowed' : 'pointer',
              opacity: addButtonDisabled ? 0.5 : 1,
              padding: 0,
              lineHeight: 0,
            }}
          >
            <Plus size={14} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      {/* Basic texture adjustments */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label={t('brushPanel.texture.scale')}
          value={textureSettings.scale}
          min={1}
          max={1000}
          nonLinearConfig={TEXTURE_SCALE_SLIDER_CONFIG}
          displayValue={`${Math.round(textureSettings.scale)}%`}
          onChange={(v) => setTextureSettings({ scale: v })}
        />

        <SliderRow
          label={t('brushPanel.texture.brightness')}
          value={textureSettings.brightness}
          min={-150}
          max={150}
          displayValue={`${textureSettings.brightness}`}
          onChange={(v) => setTextureSettings({ brightness: v })}
        />

        <SliderRow
          label={t('brushPanel.texture.contrast')}
          value={textureSettings.contrast}
          min={-50}
          max={50}
          displayValue={`${textureSettings.contrast}`}
          onChange={(v) => setTextureSettings({ contrast: v })}
        />
      </div>

      {/* Texture Each Tip and Invert toggles */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <div className="setting-checkbox-row">
          <label className={`flip-checkbox ${disabled ? 'disabled' : ''}`}>
            <input
              type="checkbox"
              checked={textureSettings.textureEachTip}
              onChange={(e) => setTextureSettings({ textureEachTip: e.target.checked })}
              disabled={disabled}
            />
            <span>{t('brushPanel.texture.textureEachTip')}</span>
          </label>
        </div>

        <SelectRow
          label={t('brushPanel.texture.mode')}
          value={textureSettings.mode}
          options={blendModeOptions}
          onChange={(v) => setTextureSettings({ mode: v as TextureBlendMode })}
          disabled={disabled}
        />

        <SliderRow
          label={t('brushPanel.texture.depth')}
          value={textureSettings.depth}
          min={0}
          max={100}
          displayValue={`${Math.round(textureSettings.depth)}%`}
          onChange={(v) => setTextureSettings({ depth: v })}
        />

        <SliderRow
          label={t('brushPanel.texture.minimumDepth')}
          value={textureSettings.minimumDepth}
          min={0}
          max={100}
          displayValue={`${Math.round(textureSettings.minimumDepth)}%`}
          onChange={(v) => setTextureSettings({ minimumDepth: v })}
          disabled={minimumDepthDisabled}
        />

        <SliderRow
          label={t('brushPanel.texture.depthJitter')}
          value={textureSettings.depthJitter}
          min={0}
          max={100}
          displayValue={`${Math.round(textureSettings.depthJitter)}%`}
          onChange={(v) => setTextureSettings({ depthJitter: v })}
          disabled={tipVariationDisabled}
        />

        <SelectRow
          label={t('brushPanel.control.label')}
          value={depthControlSource}
          options={depthControlOptions}
          onChange={(v) =>
            setTextureSettings({ depthControl: sourceToDepthControl(v as ControlSource) })
          }
          disabled={tipVariationDisabled}
        />
      </div>
    </div>
  );
}
