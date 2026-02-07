import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  useSettingsStore,
  type NewFileBackgroundPreset,
  type NewFileOrientation,
} from '@/stores/settings';
import { useToastStore } from '@/stores/toast';
import {
  buildAllSizePresets,
  findPresetMatchByDimensions,
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

  function updatePresetSelection(nextWidth: string, nextHeight: string): void {
    const resolvedWidth = parsePositiveInt(nextWidth);
    const resolvedHeight = parsePositiveInt(nextHeight);
    if (resolvedWidth === null || resolvedHeight === null) {
      setSelectedPresetId(null);
      return;
    }

    const match = findPresetMatchByDimensions(resolvedWidth, resolvedHeight, allSizePresets);
    if (match) {
      setSelectedPresetId(match.presetId);
      setOrientation(match.orientation);
      return;
    }
    setSelectedPresetId(null);
    setOrientation(resolveOrientationFromSize(resolvedWidth, resolvedHeight));
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

    const preset = allSizePresets.find((item) => item.id === presetId);
    if (!preset) return;

    const oriented = toOrientedPresetSize(preset, orientation);
    setWidth(String(oriented.width));
    setHeight(String(oriented.height));
    setSelectedPresetId(preset.id);
  }

  function handleOrientationChange(nextOrientation: NewFileOrientation): void {
    setOrientation(nextOrientation);
    if (!selectedPresetId) return;

    const preset = allSizePresets.find((item) => item.id === selectedPresetId);
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
      pushToast('Preset name is required.', { variant: 'error' });
      return;
    }
    if (resolvedWidth === null || resolvedHeight === null) {
      pushToast('Width and height must be positive integers.', { variant: 'error' });
      return;
    }

    const normalizedName = name.toLocaleLowerCase();
    const duplicate = allSizePresets.some(
      (preset) => preset.name.trim().toLocaleLowerCase() === normalizedName
    );
    if (duplicate) {
      pushToast('Preset name already exists.', { variant: 'error' });
      return;
    }

    const id = addCustomSizePreset({
      name,
      width: resolvedWidth,
      height: resolvedHeight,
    });
    setSelectedPresetId(id);
    setCustomPresetName('');
    pushToast('Custom preset saved.', { variant: 'success' });
  }

  function handleDeleteCustomPreset(): void {
    if (!selectedPresetId) {
      pushToast('Please select a custom preset first.', { variant: 'error' });
      return;
    }
    const preset = customSizePresets.find((item) => item.id === selectedPresetId);
    if (!preset) {
      pushToast('Default presets cannot be deleted.', { variant: 'error' });
      return;
    }

    const confirmed = window.confirm(`Delete custom preset "${preset.name}"?`);
    if (!confirmed) return;

    removeCustomSizePreset(preset.id);

    const resolvedWidth = parsePositiveInt(width);
    const resolvedHeight = parsePositiveInt(height);
    const remainingCustom = customSizePresets.filter((item) => item.id !== preset.id);
    const remainingAllPresets = buildAllSizePresets(remainingCustom);

    if (resolvedWidth !== null && resolvedHeight !== null) {
      const match = findPresetMatchByDimensions(resolvedWidth, resolvedHeight, remainingAllPresets);
      setSelectedPresetId(match?.presetId ?? null);
      if (match) {
        setOrientation(match.orientation);
      }
    } else {
      setSelectedPresetId(null);
    }

    pushToast('Custom preset deleted.', { variant: 'info' });
  }

  if (!isOpen) return null;

  return (
    <div className="new-file-overlay">
      <div className="new-file-panel mica-panel" onClick={(e) => e.stopPropagation()}>
        <div className="mica-panel-header new-file-header">
          <h2>New Document</h2>
          <button className="new-file-close-btn" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="new-file-body">
          <div className="new-file-row">
            <div className="new-file-field">
              <label>Preset</label>
              <select
                className="new-file-select"
                value={selectedPresetId ?? UNMATCHED_PRESET_ID}
                onChange={(e) => handlePresetChange(e.target.value)}
              >
                <option value={UNMATCHED_PRESET_ID}>Custom (Current Size)</option>
                <optgroup label="Paper">
                  {paperPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name} ({preset.width} × {preset.height})
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Device">
                  {devicePresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name} ({preset.width} × {preset.height})
                    </option>
                  ))}
                </optgroup>
                {customPresets.length > 0 && (
                  <optgroup label="Custom">
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
              <label>Orientation</label>
              <div className="new-file-orientation">
                <button
                  type="button"
                  className={orientation === 'portrait' ? 'active' : ''}
                  onClick={() => handleOrientationChange('portrait')}
                >
                  Portrait
                </button>
                <button
                  type="button"
                  className={orientation === 'landscape' ? 'active' : ''}
                  onClick={() => handleOrientationChange('landscape')}
                >
                  Landscape
                </button>
              </div>
            </div>
          </div>

          <div className="new-file-row">
            <div className="new-file-field">
              <label>Width</label>
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
              <label>Height</label>
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
              <label>Save Current Size as Custom Preset</label>
              <div className="new-file-custom-actions">
                <input
                  type="text"
                  value={customPresetName}
                  placeholder="Preset name"
                  onChange={(e) => setCustomPresetName(e.target.value)}
                />
                <button type="button" className="new-file-btn" onClick={handleSavePreset}>
                  Save Preset
                </button>
                <button
                  type="button"
                  className="new-file-btn danger"
                  onClick={handleDeleteCustomPreset}
                  disabled={!selectedCustomPreset}
                >
                  Delete Selected
                </button>
              </div>
            </div>
          </div>

          <div className="new-file-row">
            <div className="new-file-field">
              <label>Background Contents</label>
              <select
                className="new-file-select"
                value={backgroundPreset}
                onChange={(e) => setBackgroundPreset(e.target.value as BackgroundPreset)}
              >
                <option value="transparent">Transparent</option>
                <option value="white">White</option>
                <option value="black">Black</option>
                <option value="current-bg">Current Background</option>
              </select>
            </div>
          </div>

          <div className="new-file-actions">
            <button className="new-file-btn" onClick={onClose} type="button">
              Cancel
            </button>
            <button
              className="new-file-btn primary"
              onClick={handleCreate}
              disabled={!canCreate}
              type="button"
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
