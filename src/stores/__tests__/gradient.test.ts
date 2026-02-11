import { beforeEach, describe, expect, it } from 'vitest';
import { useGradientStore } from '../gradient';

function resetSelections(): void {
  useGradientStore.setState((state) => ({
    presets: state.presets,
    settings: {
      ...state.settings,
      transparency: false,
    },
    isLoaded: true,
    selectedColorStopId: state.settings.customGradient.colorStops[0]?.id ?? null,
    selectedOpacityStopId: state.settings.customGradient.opacityStops[0]?.id ?? null,
  }));
}

describe('gradient store transparency behavior', () => {
  beforeEach(() => {
    resetSelections();
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

describe('gradient store midpoint behavior', () => {
  beforeEach(() => {
    resetSelections();
  });

  it('clamps midpoint when adding new stops', () => {
    const store = useGradientStore.getState();
    const colorId = store.addColorStop(0.4, {
      source: 'fixed',
      color: '#123456',
      midpoint: 9,
    });
    const opacityId = store.addOpacityStop(0.6, {
      opacity: 0.35,
      midpoint: -2,
    });

    const nextState = useGradientStore.getState();
    const colorStop = nextState.settings.customGradient.colorStops.find(
      (stop) => stop.id === colorId
    );
    const opacityStop = nextState.settings.customGradient.opacityStops.find(
      (stop) => stop.id === opacityId
    );

    expect(colorStop?.midpoint).toBe(0.95);
    expect(opacityStop?.midpoint).toBe(0.05);
    expect(opacityStop?.opacity).toBeCloseTo(0.35, 4);
  });

  it('does not remove stops when track length is already at minimum', () => {
    const store = useGradientStore.getState();
    const colorStops = store.settings.customGradient.colorStops;
    const opacityStops = store.settings.customGradient.opacityStops;

    if (colorStops.length < 2 || opacityStops.length < 2) {
      throw new Error('default gradient should contain at least two stops');
    }

    const initialColorLength = colorStops.length;
    const initialOpacityLength = opacityStops.length;

    // Keep deleting until minimum remains.
    for (let i = 2; i < colorStops.length; i += 1) {
      store.removeColorStop(colorStops[i]!.id);
    }
    for (let i = 2; i < opacityStops.length; i += 1) {
      store.removeOpacityStop(opacityStops[i]!.id);
    }

    const current = useGradientStore.getState();
    const colorAtMin = current.settings.customGradient.colorStops.length;
    const opacityAtMin = current.settings.customGradient.opacityStops.length;
    const firstColorId = current.settings.customGradient.colorStops[0]!.id;
    const firstOpacityId = current.settings.customGradient.opacityStops[0]!.id;

    store.removeColorStop(firstColorId);
    store.removeOpacityStop(firstOpacityId);

    const finalState = useGradientStore.getState();
    expect(initialColorLength).toBeGreaterThanOrEqual(2);
    expect(initialOpacityLength).toBeGreaterThanOrEqual(2);
    expect(colorAtMin).toBe(2);
    expect(opacityAtMin).toBe(2);
    expect(finalState.settings.customGradient.colorStops.length).toBe(2);
    expect(finalState.settings.customGradient.opacityStops.length).toBe(2);
  });
});
