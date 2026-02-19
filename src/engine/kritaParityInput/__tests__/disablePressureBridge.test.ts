import { describe, expect, it } from 'vitest';
import {
  disablePressureToPressureEnabled,
  pressureEnabledToDisablePressure,
} from '../bridge/disablePressureBridge';

describe('disablePressureBridge', () => {
  it('maps Krita DisablePressure=false to pressure disabled', () => {
    expect(disablePressureToPressureEnabled(false)).toBe(false);
  });

  it('maps Krita DisablePressure=true to pressure enabled', () => {
    expect(disablePressureToPressureEnabled(true)).toBe(true);
  });

  it('maps back to Krita legacy field without inversion loss', () => {
    expect(pressureEnabledToDisablePressure(true)).toBe(true);
    expect(pressureEnabledToDisablePressure(false)).toBe(false);
  });
});
