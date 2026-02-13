import { beforeEach, describe, expect, it } from 'vitest';
import { useToolStore, DEFAULT_DUAL_BRUSH } from '../tool';
import { appHyphenStorageKey } from '@/constants/appMeta';

interface PersistedBrushSettingsPayload {
  state?: {
    brushTexture?: {
      id?: string;
      width?: number;
      height?: number;
    } | null;
    brushProfile?: {
      texture?: {
        id?: string;
        width?: number;
        height?: number;
      } | null;
    };
  };
  version?: number;
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
