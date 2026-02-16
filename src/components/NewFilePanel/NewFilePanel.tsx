import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  useSettingsStore,
  type NewFileBackgroundPreset,
  type NewFileOrientation,
} from '@/stores/settings';
import { useToastStore } from '@/stores/toast';
import { useI18n } from '@/i18n';
import {
  buildAllSizePresets,
  findPresetMatchByDimensions,
  type SizePreset,
  toOrientedPresetSize,
  resolveOrientationFromSize,
} from './presets';
import './NewFilePanel.css';

export type BackgroundPreset = NewFileBackgroundPreset;

const UNMATCHED_PRESET_ID = '__custom_unmatched__';

interface NewFilePanelProps {
  isOpen: boolean;
  onClose: () => void;
  defaultValues: { width: number; height: number };
  onCreate: (v: {
    width: number;
    height: number;
    backgroundPreset: BackgroundPreset;
    presetId: string | null;
    orientation: NewFileOrientation;
  }) => void;
}

function parsePositiveInt(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function NewFilePanel({
  isOpen,
  onClose,
  defaultValues,
  onCreate,
}: NewFilePanelProps): JSX.Element | null {
  const { t } = useI18n();
  const customSizePresets = useSettingsStore((s) => s.newFile.customSizePresets);
  const lastUsed = useSettingsStore((s) => s.newFile.lastUsed);
  const addCustomSizePreset = useSettingsStore((s) => s.addCustomSizePreset);
  const removeCustomSizePreset = useSettingsStore((s) => s.removeCustomSizePreset);
  const pushToast = useToastStore((s) => s.pushToast);

  const allSizePresets = useMemo(() => buildAllSizePresets(customSizePresets), [customSizePresets]);
  const paperPresets = useMemo(
    () => allSizePresets.filter((preset) => preset.group === 'paper'),
    [allSizePresets]
  );
  const devicePresets = useMemo(
    () => allSizePresets.filter((preset) => preset.group === 'device'),
    [allSizePresets]
  );
  const customPresets = useMemo(
    () => allSizePresets.filter((preset) => preset.group === 'custom'),
    [allSizePresets]
  );

  const [width, setWidth] = useState(String(defaultValues.width));
  const [height, setHeight] = useState(String(defaultValues.height));
  const [backgroundPreset, setBackgroundPreset] = useState<BackgroundPreset>('white');
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<NewFileOrientation>('landscape');
  const [customPresetName, setCustomPresetName] = useState('');
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;

    const fallbackWidth = defaultValues.width;
    const fallbackHeight = defaultValues.height;
    const nextWidth = Math.max(1, lastUsed.width || fallbackWidth);
    const nextHeight = Math.max(1, lastUsed.height || fallbackHeight);

    const initialMatch = findPresetMatchByDimensions(nextWidth, nextHeight, allSizePresets);
    const hasPresetId = lastUsed.presetId
      ? allSizePresets.some((preset) => preset.id === lastUsed.presetId)
      : false;

    setWidth(String(nextWidth));
    setHeight(String(nextHeight));
    setBackgroundPreset(lastUsed.backgroundPreset);
    setSelectedPresetId(hasPresetId ? lastUsed.presetId : (initialMatch?.presetId ?? null));
    setOrientation(lastUsed.orientation ?? resolveOrientationFromSize(nextWidth, nextHeight));
    setCustomPresetName('');
  }, [
    isOpen,
    defaultValues.width,
    defaultValues.height,
    lastUsed.width,
    lastUsed.height,
    lastUsed.backgroundPreset,
    lastUsed.presetId,
    lastUsed.orientation,
    allSizePresets,
  ]);

  const parsedWidth = parsePositiveInt(width);
  const parsedHeight = parsePositiveInt(height);
  const canCreate = parsedWidth !== null && parsedHeight !== null;

  const selectedCustomPreset = useMemo(
    () => customSizePresets.find((preset) => preset.id === selectedPresetId) ?? null,
    [customSizePresets, selectedPresetId]
  );

  function findPresetById(presetId: string | null): SizePreset | null {
    if (!presetId) return null;
    return allSizePresets.find((preset) => preset.id === presetId) ?? null;
  }

  function applyPresetMatch(
    resolvedWidth: number,
    resolvedHeight: number,
    presets = allSizePresets
  ): void {
    const match = findPresetMatchByDimensions(resolvedWidth, resolvedHeight, presets);
    if (match) {
      setSelectedPresetId(match.presetId);
      setOrientation(match.orientation);
      return;
    }
    setSelectedPresetId(null);
    setOrientation(resolveOrientationFromSize(resolvedWidth, resolvedHeight));
  }

  function updatePresetSelection(nextWidth: string, nextHeight: string): void {
    const resolvedWidth = parsePositiveInt(nextWidth);
    const resolvedHeight = parsePositiveInt(nextHeight);
    if (resolvedWidth === null || resolvedHeight === null) {
      setSelectedPresetId(null);
      return;
    }
    applyPresetMatch(resolvedWidth, resolvedHeight);
  }

  function handleCreate(): void {
    if (parsedWidth === null || parsedHeight === null) return;
    onCreate({
      width: parsedWidth,
      height: parsedHeight,
      backgroundPreset,
      presetId: selectedPresetId,
      orientation,
    });
  }

  function handlePresetChange(presetId: string): void {
    if (presetId === UNMATCHED_PRESET_ID) {
      setSelectedPresetId(null);
      return;
    }

    const preset = findPresetById(presetId);
    if (!preset) return;

    const oriented = toOrientedPresetSize(preset, orientation);
    setWidth(String(oriented.width));
    setHeight(String(oriented.height));
    setSelectedPresetId(preset.id);
  }

  function handleOrientationChange(nextOrientation: NewFileOrientation): void {
    setOrientation(nextOrientation);
    if (!selectedPresetId) return;

    const preset = findPresetById(selectedPresetId);
    if (!preset) return;

    const oriented = toOrientedPresetSize(preset, nextOrientation);
    setWidth(String(oriented.width));
    setHeight(String(oriented.height));
  }

  function handleSavePreset(): void {
    const name = customPresetName.trim();
    const resolvedWidth = parsePositiveInt(width);
    const resolvedHeight = parsePositiveInt(height);

    if (!name) {
      pushToast(t('newFile.toast.presetNameRequired'), { variant: 'error' });
      return;
    }
    if (resolvedWidth === null || resolvedHeight === null) {
      pushToast(t('newFile.toast.widthHeightPositiveInt'), { variant: 'error' });
      return;
    }

    const normalizedName = name.toLocaleLowerCase();
    const duplicate = allSizePresets.some(
      (preset) => preset.name.trim().toLocaleLowerCase() === normalizedName
    );
    if (duplicate) {
      pushToast(t('newFile.toast.presetNameExists'), { variant: 'error' });
      return;
    }

    const id = addCustomSizePreset({
      name,
      width: resolvedWidth,
      height: resolvedHeight,
    });
    setSelectedPresetId(id);
    setCustomPresetName('');
    pushToast(t('newFile.toast.customPresetSaved'), { variant: 'success' });
  }

  function handleDeleteCustomPreset(): void {
    if (!selectedPresetId) {
      pushToast(t('newFile.toast.selectCustomPresetFirst'), { variant: 'error' });
      return;
    }
    const preset = customSizePresets.find((item) => item.id === selectedPresetId);
    if (!preset) {
      pushToast(t('newFile.toast.defaultPresetCannotDelete'), { variant: 'error' });
      return;
    }

    const confirmed = window.confirm(
      t('newFile.confirm.deleteCustomPreset', { presetName: preset.name })
    );
    if (!confirmed) return;

    removeCustomSizePreset(preset.id);

    const resolvedWidth = parsePositiveInt(width);
    const resolvedHeight = parsePositiveInt(height);
    const remainingCustom = customSizePresets.filter((item) => item.id !== preset.id);
    const remainingAllPresets = buildAllSizePresets(remainingCustom);

    if (resolvedWidth !== null && resolvedHeight !== null) {
      applyPresetMatch(resolvedWidth, resolvedHeight, remainingAllPresets);
    } else {
      setSelectedPresetId(null);
    }

    pushToast(t('newFile.toast.customPresetDeleted'), { variant: 'info' });
  }

  if (!isOpen) return null;

  return (
    <div className="new-file-overlay">
      <div className="new-file-panel mica-panel" onClick={(e) => e.stopPropagation()}>
        <div className="mica-panel-header new-file-header">
          <h2>{t('newFile.title')}</h2>
          <button className="new-file-close-btn" onClick={onClose} title={t('common.close')}>
            <X size={18} />
          </button>
        </div>

        <div className="new-file-body">
          <div className="new-file-row">
            <div className="new-file-field">
              <label>{t('newFile.preset')}</label>
              <select
                className="new-file-select"
                value={selectedPresetId ?? UNMATCHED_PRESET_ID}
                onChange={(e) => handlePresetChange(e.target.value)}
              >
                <option value={UNMATCHED_PRESET_ID}>{t('newFile.customCurrentSize')}</option>
                <optgroup label={t('newFile.group.paper')}>
                  {paperPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name} ({preset.width} × {preset.height})
                    </option>
                  ))}
                </optgroup>
                <optgroup label={t('newFile.group.device')}>
                  {devicePresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name} ({preset.width} × {preset.height})
                    </option>
                  ))}
                </optgroup>
                {customPresets.length > 0 && (
                  <optgroup label={t('newFile.group.custom')}>
                    {customPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name} ({preset.width} × {preset.height})
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
          </div>

          <div className="new-file-row">
            <div className="new-file-field">
              <label>{t('newFile.orientation')}</label>
              <div className="new-file-orientation">
                <button
                  type="button"
                  className={orientation === 'portrait' ? 'active' : ''}
                  onClick={() => handleOrientationChange('portrait')}
                >
                  {t('newFile.orientationPortrait')}
                </button>
                <button
                  type="button"
                  className={orientation === 'landscape' ? 'active' : ''}
                  onClick={() => handleOrientationChange('landscape')}
                >
                  {t('newFile.orientationLandscape')}
                </button>
              </div>
            </div>
          </div>

          <div className="new-file-row">
            <div className="new-file-field">
              <label>{t('newFile.width')}</label>
              <input
                type="number"
                min={1}
                step={1}
                value={width}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  setWidth(nextValue);
                  updatePresetSelection(nextValue, height);
                }}
              />
            </div>
            <div className="new-file-field">
              <label>{t('newFile.height')}</label>
              <input
                type="number"
                min={1}
                step={1}
                value={height}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  setHeight(nextValue);
                  updatePresetSelection(width, nextValue);
                }}
              />
            </div>
          </div>

          <div className="new-file-row">
            <div className="new-file-field">
              <label>{t('newFile.saveCurrentSizeAsPreset')}</label>
              <div className="new-file-custom-actions">
                <input
                  type="text"
                  value={customPresetName}
                  placeholder={t('newFile.presetNamePlaceholder')}
                  onChange={(e) => setCustomPresetName(e.target.value)}
                />
                <button type="button" className="new-file-btn" onClick={handleSavePreset}>
                  {t('newFile.savePreset')}
                </button>
                <button
                  type="button"
                  className="new-file-btn danger"
                  onClick={handleDeleteCustomPreset}
                  disabled={!selectedCustomPreset}
                >
                  {t('newFile.deleteSelected')}
                </button>
              </div>
            </div>
          </div>

          <div className="new-file-row">
            <div className="new-file-field">
              <label>{t('newFile.backgroundContents')}</label>
              <select
                className="new-file-select"
                value={backgroundPreset}
                onChange={(e) => setBackgroundPreset(e.target.value as BackgroundPreset)}
              >
                <option value="transparent">{t('newFile.background.transparent')}</option>
                <option value="white">{t('newFile.background.white')}</option>
                <option value="black">{t('newFile.background.black')}</option>
                <option value="current-bg">{t('newFile.background.currentBackground')}</option>
              </select>
            </div>
          </div>

          <div className="new-file-actions">
            <button className="new-file-btn" onClick={onClose} type="button">
              {t('common.cancel')}
            </button>
            <button
              className="new-file-btn primary"
              onClick={handleCreate}
              disabled={!canCreate}
              type="button"
            >
              {t('common.create')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
