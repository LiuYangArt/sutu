/**
 * Krita historical field `DisablePressure` has inverted naming semantics:
 * - false => pressure disabled (locked to 1.0)
 * - true  => pressure enabled (uses pressure curve)
 */
export function disablePressureToPressureEnabled(disablePressure: boolean): boolean {
  return Boolean(disablePressure);
}

export function pressureEnabledToDisablePressure(pressureEnabled: boolean): boolean {
  return Boolean(pressureEnabled);
}
