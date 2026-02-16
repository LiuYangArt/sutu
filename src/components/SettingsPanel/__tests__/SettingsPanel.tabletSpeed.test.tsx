import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SettingsPanel } from '../index';
import { useI18nStore } from '@/stores/i18n';
import { useSettingsStore } from '@/stores/settings';

function seedI18n(): void {
  useI18nStore.setState((state) => ({
    ...state,
    catalogs: {
      'en-US': {
        meta: { code: 'en-US', displayName: 'English', nativeName: 'English' },
        source: 'builtin',
        messages: {
          'settings.title': 'Settings',
          'settings.tab.appearance': 'Appearance',
          'settings.tab.general': 'General',
          'settings.tab.brush': 'Brush',
          'settings.tab.tablet': 'Tablet',
          'settings.tablet.pressureCurve.title': 'Pressure Curve',
          'settings.tablet.pressureCurve.lowPressure': 'Low Pressure',
          'settings.tablet.pressureCurve.highPressure': 'High Pressure',
          'settings.tablet.pressureCurve.preset': 'Presets',
          'settings.tablet.pressureCurve.reset': 'Reset',
          'settings.tablet.pressureCurve.linear': 'Linear',
          'settings.tablet.pressureCurve.soft': 'Soft',
          'settings.tablet.pressureCurve.hard': 'Hard',
          'settings.tablet.pressureCurve.sCurve': 'S Curve',
          'settings.tablet.brushSpeed.title': 'Brush Speed',
          'settings.tablet.brushSpeed.max': 'Maximum brush speed: {{value}} px/ms',
          'settings.tablet.brushSpeed.smoothing': 'Brush speed smoothing: {{value}} samples',
          'settings.tablet.dynamics.title': 'Stroke Dynamics',
          'settings.tablet.dynamics.lowPressureAdaptiveSmoothing':
            'Low pressure adaptive smoothing',
          'settings.tablet.dynamics.tailTaper': 'Tail taper compensation',
          'settings.tablet.status.title': 'Status',
          'settings.tablet.status.status': 'Status',
          'settings.tablet.status.value.disconnected': 'Disconnected',
          'settings.tablet.status.requestedBackend': 'Requested Backend',
          'settings.tablet.status.activeBackend': 'Active Backend',
          'settings.tablet.status.backpressure': 'Backpressure',
          'settings.tablet.backendSwitch.usePointerEvent': 'Use Pointer Event',
          'settings.tablet.backend.autoPreferPointerEvent': 'Auto backend: Pointer Event',
          'settings.tablet.inputPipeline.title': 'Input Pipeline',
          'settings.tablet.inputPipeline.backpressureMode': 'Backpressure Mode',
          'settings.tablet.inputPipeline.lossless': 'Lossless',
          'settings.tablet.inputPipeline.latencyCapped': 'Latency Capped',
          'settings.tablet.inputPipeline.queueEnqueuedDequeued': 'Queue In/Out',
          'settings.tablet.inputPipeline.queueDropped': 'Queue Dropped',
          'settings.tablet.inputPipeline.queueDepth': 'Queue Depth',
          'settings.tablet.inputPipeline.queueLatencyPercentiles': 'Queue Latency Percentiles',
          'settings.tablet.inputPipeline.queueLatencyLast': 'Latest Queue Latency',
          'settings.tablet.inputPipeline.applyConfig': 'Apply Configuration',
          'settings.tablet.inputPipeline.applyHint': 'Apply hint',
          'settings.tablet.actions.title': 'Actions',
          'settings.tablet.actions.initialize': 'Initialize',
          'settings.tablet.actions.start': 'Start',
          'settings.tablet.actions.refresh': 'Refresh',
          'settings.tablet.live.pointerEventTitle': 'Live Input (Pointer Event)',
          'settings.tablet.live.noPointerEvent': 'No PointerEvent data yet',
          'settings.tablet.liveInput.pointerEvent':
            'Live input source: PointerEvent (rawupdate support: {{support}})',
          'settings.tablet.configuration.title': 'Configuration',
          'settings.tablet.configuration.backend': 'Backend',
          'settings.tablet.configuration.pointerEventOnly': 'Pointer Event Only',
          'settings.tablet.configuration.winTabOnly': 'WinTab Only',
          'settings.tablet.configuration.pollingRate': 'Polling Rate',
          'settings.tablet.configuration.pollingRateHz': '{{rate}} Hz',
          'settings.tablet.configuration.autoStart': 'Auto Start',
          'common.yes': 'Yes',
          'common.no': 'No',
        },
      },
    },
    availableLocales: [{ code: 'en-US', displayName: 'English', nativeName: 'English' }],
    currentLocale: 'en-US',
    initialized: true,
  }));
}

describe('SettingsPanel tablet speed controls', () => {
  beforeEach(() => {
    seedI18n();
    act(() => {
      useSettingsStore.setState((state) => ({
        ...state,
        isOpen: true,
        activeTab: 'tablet',
      }));
    });
  });

  afterEach(() => {
    act(() => {
      useSettingsStore.setState((state) => ({
        ...state,
        isOpen: false,
        activeTab: 'appearance',
      }));
    });
  });

  it('updates speed params and applies pressure curve preset', () => {
    render(<SettingsPanel />);

    const sliders = screen.getAllByRole('slider');
    expect(sliders.length).toBeGreaterThanOrEqual(2);

    act(() => {
      fireEvent.change(sliders[0]!, { target: { value: '45' } });
      fireEvent.change(sliders[1]!, { target: { value: '12' } });
    });

    expect(useSettingsStore.getState().tablet.maxBrushSpeedPxPerMs).toBe(45);
    expect(useSettingsStore.getState().tablet.brushSpeedSmoothingSamples).toBe(12);

    const hardPresetButton = screen.getByRole('button', { name: 'Hard' });
    act(() => {
      fireEvent.click(hardPresetButton);
    });

    const state = useSettingsStore.getState();
    expect(state.tablet.pressureCurve).toBe('hard');
    expect(state.tablet.pressureCurvePoints.length).toBeGreaterThanOrEqual(3);
    expect(state.tablet.pressureCurvePoints[1]!.y).toBeLessThan(
      state.tablet.pressureCurvePoints[1]!.x
    );
  });
});
