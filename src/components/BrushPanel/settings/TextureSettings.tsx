import { useToolStore } from '@/stores/tool';

/**
 * Texture settings panel (Photoshop-compatible Texture panel)
 *
 * Allows controlling how texture/pattern is applied to brush strokes.
 */
export function TextureSettings(): JSX.Element {
  const { textureEnabled, textureSettings, setTextureEnabled, setTextureSettings } = useToolStore();

  return (
    <div className="brush-panel-section">
      <div className="setting-row">
        <label>
          <input
            type="checkbox"
            checked={textureEnabled}
            onChange={(e) => setTextureEnabled(e.target.checked)}
          />
          Enable Texture
        </label>
      </div>

      <fieldset disabled={!textureEnabled} className="texture-settings-fieldset">
        <div className="setting-row">
          <label>Scale</label>
          <input
            type="range"
            min={10}
            max={200}
            value={textureSettings.scale}
            onChange={(e) => setTextureSettings({ scale: Number(e.target.value) })}
          />
          <span className="setting-value">{Math.round(textureSettings.scale)}%</span>
        </div>

        <div className="setting-row">
          <label>Brightness</label>
          <input
            type="range"
            min={-150}
            max={150}
            value={textureSettings.brightness}
            onChange={(e) => setTextureSettings({ brightness: Number(e.target.value) })}
          />
          <span className="setting-value">{textureSettings.brightness}</span>
        </div>

        <div className="setting-row">
          <label>Contrast</label>
          <input
            type="range"
            min={-50}
            max={50}
            value={textureSettings.contrast}
            onChange={(e) => setTextureSettings({ contrast: Number(e.target.value) })}
          />
          <span className="setting-value">{textureSettings.contrast}</span>
        </div>

        <div className="setting-row">
          <label>Depth</label>
          <input
            type="range"
            min={0}
            max={100}
            value={textureSettings.depth}
            onChange={(e) => setTextureSettings({ depth: Number(e.target.value) })}
          />
          <span className="setting-value">{Math.round(textureSettings.depth)}%</span>
        </div>

        <div className="setting-row">
          <label>
            <input
              type="checkbox"
              checked={textureSettings.invert}
              onChange={(e) => setTextureSettings({ invert: e.target.checked })}
            />
            Invert
          </label>
        </div>

        <div className="setting-row">
          <label>
            <input
              type="checkbox"
              checked={textureSettings.textureEachTip}
              onChange={(e) => setTextureSettings({ textureEachTip: e.target.checked })}
            />
            Texture Each Tip
          </label>
        </div>

        <div className="setting-row">
          <label>Mode</label>
          <select
            value={textureSettings.mode}
            onChange={(e) =>
              setTextureSettings({ mode: e.target.value as typeof textureSettings.mode })
            }
          >
            <option value="multiply">Multiply</option>
            <option value="subtract">Subtract</option>
            <option value="darken">Darken</option>
            <option value="overlay">Overlay</option>
            <option value="colorDodge">Color Dodge</option>
            <option value="colorBurn">Color Burn</option>
            <option value="linearBurn">Linear Burn</option>
            <option value="hardMix">Hard Mix</option>
            <option value="linearHeight">Linear Height</option>
            <option value="height">Height</option>
          </select>
        </div>
      </fieldset>
    </div>
  );
}
