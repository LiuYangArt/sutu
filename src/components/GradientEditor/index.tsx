import { useMemo } from 'react';
import { useGradientStore } from '@/stores/gradient';
import { useToolStore } from '@/stores/tool';
import { GradientBar } from './GradientBar';
import { StopEditor } from './StopEditor';
import { PresetGrid } from './PresetGrid';
import './GradientEditor.css';

function askName(message: string, initialValue: string): string | null {
  const input = window.prompt(message, initialValue);
  if (input === null) return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function GradientEditor() {
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

  const selectedColorStop = useMemo(
    () =>
      settings.customGradient.colorStops.find((stop) => stop.id === selectedColorStopId) ??
      settings.customGradient.colorStops[0] ??
      null,
    [selectedColorStopId, settings.customGradient.colorStops]
  );

  const selectedOpacityStop = useMemo(
    () =>
      settings.customGradient.opacityStops.find((stop) => stop.id === selectedOpacityStopId) ??
      settings.customGradient.opacityStops[0] ??
      null,
    [selectedOpacityStopId, settings.customGradient.opacityStops]
  );

  return (
    <div className="gradient-editor">
      <section className="gradient-editor-main">
        <label className="gradient-name-field">
          Name
          <input
            type="text"
            value={settings.customGradient.name}
            onChange={(event) => setCustomGradientName(event.target.value)}
          />
        </label>

        <GradientBar
          colorStops={settings.customGradient.colorStops}
          opacityStops={settings.customGradient.opacityStops}
          selectedColorStopId={selectedColorStopId}
          selectedOpacityStopId={selectedOpacityStopId}
          foregroundColor={foregroundColor}
          backgroundColor={backgroundColor}
          onSelectColorStop={selectColorStop}
          onSelectOpacityStop={selectOpacityStop}
          onAddColorStop={addColorStop}
          onAddOpacityStop={addOpacityStop}
          onUpdateColorStopPosition={(id, position) => updateColorStop(id, { position })}
          onUpdateOpacityStopPosition={(id, position) => updateOpacityStop(id, { position })}
          onRemoveColorStop={removeColorStop}
          onRemoveOpacityStop={removeOpacityStop}
        />

        <StopEditor
          colorStop={selectedColorStop}
          opacityStop={selectedOpacityStop}
          foregroundColor={foregroundColor}
          backgroundColor={backgroundColor}
          onUpdateColorStop={updateColorStop}
          onRemoveColorStop={removeColorStop}
          onUpdateOpacityStop={updateOpacityStop}
          onRemoveOpacityStop={removeOpacityStop}
        />
      </section>

      <PresetGrid
        presets={presets}
        activePresetId={settings.activePresetId}
        foregroundColor={foregroundColor}
        backgroundColor={backgroundColor}
        onActivate={setActivePreset}
        onCopyToCustom={copyPresetToCustom}
        onSaveCustom={() => {
          const name = askName('Save gradient preset as', settings.customGradient.name);
          if (!name) return;
          saveCustomAsPreset(name);
        }}
        onRename={(id) => {
          const preset = presets.find((item) => item.id === id);
          if (!preset) return;
          const name = askName('Rename gradient preset', preset.name);
          if (!name) return;
          renamePreset(id, name);
        }}
        onDelete={(id) => {
          const preset = presets.find((item) => item.id === id);
          if (!preset) return;
          const ok = window.confirm(`Delete preset "${preset.name}"?`);
          if (!ok) return;
          deletePreset(id);
        }}
      />
    </div>
  );
}
