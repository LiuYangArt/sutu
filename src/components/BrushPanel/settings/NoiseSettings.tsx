import { useToolStore } from '@/stores/tool';

export function NoiseSettings(): JSX.Element {
  const { noiseEnabled, setNoiseEnabled } = useToolStore();

  return (
    <div className="brush-panel-section">
      <div className="section-header-row">
        <div className="section-checkbox-label">
          <h4>Noise</h4>
        </div>
      </div>

      <div className="dynamics-group">
        <div className="setting-checkbox-row">
          <label className="flip-checkbox">
            <input
              type="checkbox"
              checked={noiseEnabled}
              onChange={(e) => setNoiseEnabled(e.target.checked)}
            />
            <span>Enable Noise</span>
          </label>
        </div>
      </div>

      <p className="setting-description">
        Adds random grain to brush edges for a more natural look.
      </p>
    </div>
  );
}
