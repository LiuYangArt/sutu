import { useToolStore } from '@/stores/tool';
import { SliderRow } from '../BrushPanelComponents';

export function NoiseSettings(): JSX.Element {
  const { noiseEnabled, noiseSettings, setNoiseSettings } = useToolStore();
  const disabled = !noiseEnabled;

  return (
    <div className="brush-panel-section">
      <div className="section-header-row">
        <h4>Noise</h4>
      </div>

      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label="Noise Size"
          value={noiseSettings.size}
          min={1}
          max={100}
          displayValue={`${Math.round(noiseSettings.size)}%`}
          onChange={(value) => setNoiseSettings({ size: value })}
          disabled={disabled}
        />

        <SliderRow
          label="Grain Size Jitter"
          value={noiseSettings.sizeJitter}
          min={0}
          max={100}
          displayValue={`${Math.round(noiseSettings.sizeJitter)}%`}
          onChange={(value) => setNoiseSettings({ sizeJitter: value })}
          disabled={disabled}
        />

        <SliderRow
          label="Grain Density Jitter"
          value={noiseSettings.densityJitter}
          min={0}
          max={100}
          displayValue={`${Math.round(noiseSettings.densityJitter)}%`}
          onChange={(value) => setNoiseSettings({ densityJitter: value })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
