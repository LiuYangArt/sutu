import { beforeEach, describe, expect, it } from 'vitest';
import { useGradientStore } from '../gradient';

describe('gradient store transparency behavior', () => {
  beforeEach(() => {
    useGradientStore.setState((state) => ({
      presets: state.presets,
      settings: {
        ...state.settings,
        transparency: false,
      },
      isLoaded: true,
      selectedColorStopId: state.selectedColorStopId,
      selectedOpacityStopId: state.selectedOpacityStopId,
    }));
  });

  it('enables transparency when activating foreground-to-transparent preset', () => {
    const store = useGradientStore.getState();
    store.setActivePreset('preset_fg_transparent');
    expect(useGradientStore.getState().settings.transparency).toBe(true);
  });

  it('enables transparency when copying transparent preset to custom', () => {
    const store = useGradientStore.getState();
    store.copyPresetToCustom('preset_fg_transparent');
    expect(useGradientStore.getState().settings.transparency).toBe(true);
  });
});
