import { beforeEach, describe, expect, it } from 'vitest';
import { useToolStore, DEFAULT_DUAL_BRUSH } from '../tool';
import { appHyphenStorageKey } from '@/constants/appMeta';

interface PersistedBrushSettingsPayload {
  state?: {
    recentSwatches?: string[];
    brushTexture?: PersistedTextureRef | null;
    brushProfile?: {
      texture?: PersistedTextureRef | null;
      dualBrush?: PersistedDualBrushRef;
    };
    dualBrush?: PersistedDualBrushRef;
  };
  version?: number;
}

interface PersistedTextureRef {
  id?: string;
  width?: number;
  height?: number;
}

interface PersistedDualBrushRef {
  brushId?: string | null;
  texture?: PersistedTextureRef | null;
}

function readPersistedBrushSettings(): PersistedBrushSettingsPayload {
  const raw = window.localStorage.getItem(appHyphenStorageKey('brush-settings'));
  if (!raw) return {};
  return JSON.parse(raw) as PersistedBrushSettingsPayload;
}

describe('ToolStore', () => {
  const resetToolState = () => {
    const current = useToolStore.getState();
    const resetProfile = {
      ...current.brushProfile,
      size: 20,
      flow: 1,
      opacity: 1,
      hardness: 100,
      spacing: 0.25,
      roundness: 100,
      angle: 0,
      texture: null,
      dualBrushEnabled: false,
      dualBrush: { ...DEFAULT_DUAL_BRUSH },
    };

    useToolStore.setState({
      currentTool: 'brush',
      brushSize: 20,
      eraserSize: 20,
      brushColor: '#000000',
      backgroundColor: '#ffffff',
      recentSwatches: [],
      brushFlow: 1,
      brushOpacity: 1,
      brushHardness: 100,
      brushSpacing: 0.25,
      brushRoundness: 100,
      brushAngle: 0,
      pressureSizeEnabled: false,
      pressureFlowEnabled: false,
      pressureOpacityEnabled: true,
      dualBrushEnabled: false,
      dualBrush: { ...DEFAULT_DUAL_BRUSH },
      eraserBackgroundMode: 'background-color',
      brushProfile: { ...resetProfile },
      eraserProfile: { ...resetProfile },
    });
  };

  beforeEach(() => {
    window.localStorage.clear();
    resetToolState();
  });

  describe('setTool', () => {
    it('should change current tool', () => {
      const store = useToolStore.getState();

      store.setTool('eraser');
      expect(useToolStore.getState().currentTool).toBe('eraser');

      store.setTool('brush');
      expect(useToolStore.getState().currentTool).toBe('brush');
    });

    it('should keep brush and eraser profiles independent across tool switches', () => {
      const store = useToolStore.getState();

      store.setBrushSize(48);
      store.setBrushFlow(0.72);
      store.setBrushHardness(88);

      store.setTool('eraser');
      store.setBrushSize(16);
      store.setBrushFlow(0.25);
      store.setBrushHardness(42);

      store.setTool('brush');
      let state = useToolStore.getState();
      expect(state.brushSize).toBe(48);
      expect(state.brushFlow).toBeCloseTo(0.72);
      expect(state.brushHardness).toBe(88);
      expect(state.brushProfile.size).toBe(48);

      store.setTool('eraser');
      state = useToolStore.getState();
      expect(state.eraserSize).toBe(16);
      expect(state.brushSize).toBe(16);
      expect(state.brushFlow).toBeCloseTo(0.25);
      expect(state.brushHardness).toBe(42);
      expect(state.eraserProfile.size).toBe(16);
    });
  });

  describe('setBrushSize', () => {
    it('should set brush size', () => {
      const store = useToolStore.getState();

      store.setBrushSize(50);
      expect(useToolStore.getState().brushSize).toBe(50);
    });

    it('should clamp brush size to valid range', () => {
      const store = useToolStore.getState();

      store.setBrushSize(1000);
      expect(useToolStore.getState().brushSize).toBe(1000); // Max is 1000

      store.setBrushSize(0);
      expect(useToolStore.getState().brushSize).toBe(1);
    });
  });

  describe('Dual Brush Size Ratio', () => {
    it('should update dual brush size when main brush size changes', () => {
      useToolStore.setState({
        brushSize: 20,
        dualBrush: { ...DEFAULT_DUAL_BRUSH },
      });

      const store = useToolStore.getState();

      // main = 100, dual = 50 -> ratio = 0.5
      store.setBrushSize(100);
      store.setDualBrush({ size: 50 });

      // main = 200 -> dual = 100
      store.setBrushSize(200);

      const s = useToolStore.getState();
      expect(s.dualBrush.size).toBe(100);
      expect(s.dualBrush.sizeRatio).toBeCloseTo(0.5);
    });

    it('should update sizeRatio when dual size is changed directly', () => {
      useToolStore.setState({
        brushSize: 100,
        dualBrush: { ...DEFAULT_DUAL_BRUSH },
      });

      const store = useToolStore.getState();
      store.setDualBrush({ size: 150 });

      expect(useToolStore.getState().dualBrush.sizeRatio).toBeCloseTo(1.5);
    });

    it('should use sizeRatio as the source of truth when provided', () => {
      useToolStore.setState({
        brushSize: 80,
        dualBrush: { ...DEFAULT_DUAL_BRUSH },
      });

      const store = useToolStore.getState();
      store.setDualBrush({ size: 999, sizeRatio: 0.5 });

      const s = useToolStore.getState();
      expect(s.dualBrush.size).toBe(40);
      expect(s.dualBrush.sizeRatio).toBeCloseTo(0.5);
    });
  });

  describe('setBrushOpacity', () => {
    it('should set brush opacity', () => {
      const store = useToolStore.getState();

      store.setBrushOpacity(0.5);
      expect(useToolStore.getState().brushOpacity).toBe(0.5);
    });

    it('should clamp opacity to valid range', () => {
      const store = useToolStore.getState();

      store.setBrushOpacity(2.0);
      expect(useToolStore.getState().brushOpacity).toBe(1);

      // Minimum opacity is 0.01 (not 0) to ensure brush is always visible
      store.setBrushOpacity(-0.5);
      expect(useToolStore.getState().brushOpacity).toBe(0.01);
    });
  });

  describe('persistence', () => {
    it('persists recent swatches with canonical order', () => {
      const store = useToolStore.getState();
      store.addRecentSwatch('#00aa00');
      store.addRecentSwatch('#11BB11');
      store.addRecentSwatch('#00AA00');

      const parsed = readPersistedBrushSettings();
      expect(parsed.state?.recentSwatches).toEqual(['#00AA00', '#11BB11']);
    });

    it('persists active brushTexture so startup restore can keep texture tips without preset re-apply', () => {
      const store = useToolStore.getState();
      store.setBrushTexture({
        id: 'tip-texture-1',
        data: '',
        width: 64,
        height: 96,
      });

      const parsed = readPersistedBrushSettings();

      expect(parsed.state?.brushTexture?.id).toBe('tip-texture-1');
      expect(parsed.state?.brushTexture?.width).toBe(64);
      expect(parsed.state?.brushTexture?.height).toBe(96);
    });

    it('migrates v6 payload by restoring brushTexture from brushProfile.texture', async () => {
      window.localStorage.setItem(
        appHyphenStorageKey('brush-settings'),
        JSON.stringify({
          state: {
            brushProfile: {
              texture: {
                id: 'legacy-texture-tip',
                data: '',
                width: 48,
                height: 48,
              },
            },
          },
          version: 6,
        })
      );

      await useToolStore.persist.rehydrate();

      const state = useToolStore.getState();
      expect(state.brushTexture?.id).toBe('legacy-texture-tip');
      expect(state.brushTexture?.width).toBe(48);
      expect(state.brushTexture?.height).toBe(48);
      expect(state.brushProfile.texture?.id).toBe('legacy-texture-tip');
    });

    it('migrates v7 payload by backfilling empty recent swatches', async () => {
      window.localStorage.setItem(
        appHyphenStorageKey('brush-settings'),
        JSON.stringify({
          state: {
            brushColor: '#112233',
            backgroundColor: '#ffffff',
          },
          version: 7,
        })
      );

      await useToolStore.persist.rehydrate();

      const state = useToolStore.getState();
      expect(state.recentSwatches).toEqual([]);
    });

    it('rehydrates dual brush texture from same-version payload for startup restore', async () => {
      const store = useToolStore.getState();
      store.setDualBrushEnabled(true);
      store.setDualBrush({
        enabled: true,
        brushId: 'dual-texture-tip-1',
        brushName: 'Dual Tip 1',
        texture: {
          id: 'dual-texture-tip-1',
          data: '',
          width: 72,
          height: 48,
        },
      });

      const persistedRaw = window.localStorage.getItem(appHyphenStorageKey('brush-settings'));
      expect(persistedRaw).toBeTruthy();
      const parsed = readPersistedBrushSettings();
      expect(parsed.state?.dualBrush?.texture?.id).toBe('dual-texture-tip-1');

      resetToolState();
      window.localStorage.setItem(appHyphenStorageKey('brush-settings'), persistedRaw!);
      await useToolStore.persist.rehydrate();

      const state = useToolStore.getState();
      expect(state.dualBrushEnabled).toBe(true);
      expect(state.dualBrush.brushId).toBe('dual-texture-tip-1');
      expect(state.dualBrush.texture?.id).toBe('dual-texture-tip-1');
      expect(state.dualBrush.texture?.width).toBe(72);
      expect(state.dualBrush.texture?.height).toBe(48);
    });

    it('migrates v8 payload by restoring dualBrush.texture from brushProfile', async () => {
      window.localStorage.setItem(
        appHyphenStorageKey('brush-settings'),
        JSON.stringify({
          state: {
            dualBrushEnabled: true,
            dualBrush: {
              ...DEFAULT_DUAL_BRUSH,
              enabled: true,
              brushId: 'legacy-dual-tip',
              texture: null,
            },
            brushProfile: {
              dualBrushEnabled: true,
              dualBrush: {
                ...DEFAULT_DUAL_BRUSH,
                enabled: true,
                brushId: 'legacy-dual-tip',
                texture: {
                  id: 'legacy-dual-tip',
                  data: '',
                  width: 40,
                  height: 64,
                },
              },
            },
          },
          version: 8,
        })
      );

      await useToolStore.persist.rehydrate();

      const state = useToolStore.getState();
      expect(state.dualBrushEnabled).toBe(true);
      expect(state.dualBrush.brushId).toBe('legacy-dual-tip');
      expect(state.dualBrush.texture?.id).toBe('legacy-dual-tip');
      expect(state.dualBrush.texture?.width).toBe(40);
      expect(state.dualBrush.texture?.height).toBe(64);
      expect(state.brushProfile.dualBrush.texture?.id).toBe('legacy-dual-tip');
    });
  });

  describe('setBrushMaskType', () => {
    it('keeps unified gaussian mask type', () => {
      const store = useToolStore.getState();

      store.setBrushMaskType('gaussian');

      const state = useToolStore.getState();
      expect(state.brushMaskType).toBe('gaussian');
      expect(state.brushProfile.maskType).toBe('gaussian');
    });
  });

  describe('swapColors', () => {
    it('setBrushColor should be idempotent for case-insensitive same value', () => {
      const store = useToolStore.getState();
      const beforeStateRef = useToolStore.getState();
      store.setBrushColor('#000000');
      const afterSameStateRef = useToolStore.getState();
      expect(afterSameStateRef).toBe(beforeStateRef);

      store.setBrushColor('#00AAFF');
      expect(useToolStore.getState().brushColor).toBe('#00AAFF');
      const beforeCaseOnlyUpdateRef = useToolStore.getState();

      store.setBrushColor('#00aaff');
      const afterCaseOnlyUpdateRef = useToolStore.getState();
      expect(afterCaseOnlyUpdateRef).toBe(beforeCaseOnlyUpdateRef);
      expect(useToolStore.getState().brushColor).toBe('#00AAFF');
    });

    it('should swap foreground and background colors', () => {
      const store = useToolStore.getState();

      store.setBrushColor('#ff0000');
      store.setBackgroundColor('#0000ff');

      store.swapColors();

      expect(useToolStore.getState().brushColor).toBe('#0000ff');
      expect(useToolStore.getState().backgroundColor).toBe('#ff0000');
    });
  });

  describe('resetColors', () => {
    it('should reset to default black/white', () => {
      const store = useToolStore.getState();

      store.setBrushColor('#ff0000');
      store.setBackgroundColor('#00ff00');

      store.resetColors();

      expect(useToolStore.getState().brushColor).toBe('#000000');
      expect(useToolStore.getState().backgroundColor).toBe('#ffffff');
    });
  });

  describe('addRecentSwatch', () => {
    it('inserts new colors at the front and caps list size at 6', () => {
      const store = useToolStore.getState();
      store.addRecentSwatch('#111111');
      store.addRecentSwatch('#222222');
      store.addRecentSwatch('#333333');
      store.addRecentSwatch('#444444');
      store.addRecentSwatch('#555555');
      store.addRecentSwatch('#666666');
      store.addRecentSwatch('#777777');

      expect(useToolStore.getState().recentSwatches).toEqual([
        '#777777',
        '#666666',
        '#555555',
        '#444444',
        '#333333',
        '#222222',
      ]);
    });

    it('moves duplicate color to the first slot instead of increasing length', () => {
      const store = useToolStore.getState();
      store.addRecentSwatch('#AA0000');
      store.addRecentSwatch('#BB0000');
      store.addRecentSwatch('#CC0000');

      store.addRecentSwatch('#bb0000');
      const state = useToolStore.getState();
      expect(state.recentSwatches).toEqual(['#BB0000', '#CC0000', '#AA0000']);
      expect(state.recentSwatches).toHaveLength(3);
    });
  });

  describe('eraser background mode', () => {
    it('should toggle between background-color and transparent', () => {
      const store = useToolStore.getState();
      expect(store.eraserBackgroundMode).toBe('background-color');

      store.toggleEraserBackgroundMode();
      expect(useToolStore.getState().eraserBackgroundMode).toBe('transparent');

      store.setEraserBackgroundMode('background-color');
      expect(useToolStore.getState().eraserBackgroundMode).toBe('background-color');
    });
  });
});
