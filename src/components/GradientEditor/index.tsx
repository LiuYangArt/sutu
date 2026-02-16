import { useMemo } from 'react';
import { useGradientStore, type GradientPreset } from '@/stores/gradient';
import { useToolStore } from '@/stores/tool';
import { GradientBar } from './GradientBar';
import { StopEditor } from './StopEditor';
import { PresetGrid } from './PresetGrid';
import { useI18n } from '@/i18n';
import { getGradientPresetDisplayName } from './presetI18n';
import './GradientEditor.css';

function askName(message: string, initialValue: string): string | null {
  const input = window.prompt(message, initialValue);
  if (input === null) return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolvePreset(presets: GradientPreset[], id: string): GradientPreset | null {
  return presets.find((preset) => preset.id === id) ?? null;
}

function resolveSelectedStop<T extends { id: string }>(
  stops: T[],
  selectedId: string | null
): T | null {
  return stops.find((stop) => stop.id === selectedId) ?? stops[0] ?? null;
}

export function GradientEditor(): JSX.Element {
  const { t } = useI18n();
  const presets = useGradientStore((s) => s.presets);
  const settings = useGradientStore((s) => s.settings);
  const selectedColorStopId = useGradientStore((s) => s.selectedColorStopId);
  const selectedOpacityStopId = useGradientStore((s) => s.selectedOpacityStopId);

  const selectColorStop = useGradientStore((s) => s.selectColorStop);
  const selectOpacityStop = useGradientStore((s) => s.selectOpacityStop);
  const addColorStop = useGradientStore((s) => s.addColorStop);
  const addOpacityStop = useGradientStore((s) => s.addOpacityStop);
  const updateColorStop = useGradientStore((s) => s.updateColorStop);
  const updateOpacityStop = useGradientStore((s) => s.updateOpacityStop);
  const removeColorStop = useGradientStore((s) => s.removeColorStop);
  const removeOpacityStop = useGradientStore((s) => s.removeOpacityStop);
  const setCustomGradientName = useGradientStore((s) => s.setCustomGradientName);

  const setActivePreset = useGradientStore((s) => s.setActivePreset);
  const copyPresetToCustom = useGradientStore((s) => s.copyPresetToCustom);
  const saveCustomAsPreset = useGradientStore((s) => s.saveCustomAsPreset);
  const renamePreset = useGradientStore((s) => s.renamePreset);
  const deletePreset = useGradientStore((s) => s.deletePreset);

  const foregroundColor = useToolStore((s) => s.brushColor);
  const backgroundColor = useToolStore((s) => s.backgroundColor);
  const customGradient = settings.customGradient;

  const selectedColorStop = useMemo(
    () => resolveSelectedStop(customGradient.colorStops, selectedColorStopId),
    [customGradient.colorStops, selectedColorStopId]
  );

  const selectedOpacityStop = useMemo(
    () => resolveSelectedStop(customGradient.opacityStops, selectedOpacityStopId),
    [customGradient.opacityStops, selectedOpacityStopId]
  );
  const activePreset = useMemo(
    () => (settings.activePresetId ? resolvePreset(presets, settings.activePresetId) : null),
    [presets, settings.activePresetId]
  );
  const displayGradientName = useMemo(() => {
    if (!activePreset) return customGradient.name;
    if (customGradient.name !== activePreset.name) return customGradient.name;
    return getGradientPresetDisplayName(activePreset, t);
  }, [activePreset, customGradient.name, t]);

  function handleSaveCustomPreset(): void {
    const name = askName(t('gradientEditor.prompt.savePresetAs'), displayGradientName);
    if (!name) return;
    saveCustomAsPreset(name);
  }

  function handleRenamePreset(id: string): void {
    const preset = resolvePreset(presets, id);
    if (!preset) return;
    const name = askName(
      t('gradientEditor.prompt.renamePreset'),
      getGradientPresetDisplayName(preset, t)
    );
    if (!name) return;
    renamePreset(id, name);
  }

  function handleDeletePreset(id: string): void {
    const preset = resolvePreset(presets, id);
    if (!preset) return;
    const ok = window.confirm(
      t('gradientEditor.confirm.deletePreset', {
        presetName: getGradientPresetDisplayName(preset, t),
      })
    );
    if (!ok) return;
    deletePreset(id);
  }

  return (
    <div className="gradient-editor">
      <PresetGrid
        presets={presets}
        activePresetId={settings.activePresetId}
        foregroundColor={foregroundColor}
        backgroundColor={backgroundColor}
        onActivate={setActivePreset}
        onCopyToCustom={copyPresetToCustom}
        onSaveCustom={handleSaveCustomPreset}
        onRename={handleRenamePreset}
        onDelete={handleDeletePreset}
      />

      <section className="gradient-editor-main">
        <label className="gradient-name-field">
          {t('gradientEditor.name')}
          <input
            type="text"
            value={displayGradientName}
            onChange={(event) => setCustomGradientName(event.target.value)}
          />
        </label>

        <GradientBar
          colorStops={customGradient.colorStops}
          opacityStops={customGradient.opacityStops}
          transparencyEnabled={settings.transparency}
          selectedColorStopId={selectedColorStopId}
          selectedOpacityStopId={selectedOpacityStopId}
          foregroundColor={foregroundColor}
          backgroundColor={backgroundColor}
          onSelectColorStop={selectColorStop}
          onSelectOpacityStop={selectOpacityStop}
          onAddColorStop={addColorStop}
          onAddOpacityStop={addOpacityStop}
          onUpdateColorStop={updateColorStop}
          onUpdateOpacityStop={updateOpacityStop}
        />

        <StopEditor
          colorStop={selectedColorStop}
          opacityStop={selectedOpacityStop}
          colorStopCount={customGradient.colorStops.length}
          opacityStopCount={customGradient.opacityStops.length}
          foregroundColor={foregroundColor}
          backgroundColor={backgroundColor}
          onUpdateColorStop={updateColorStop}
          onRemoveColorStop={removeColorStop}
          onUpdateOpacityStop={updateOpacityStop}
          onRemoveOpacityStop={removeOpacityStop}
        />
      </section>
    </div>
  );
}
