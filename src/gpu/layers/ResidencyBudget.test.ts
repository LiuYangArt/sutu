import { beforeEach, describe, expect, it } from 'vitest';
import {
  clampResidencyBudgetBytes,
  computeResidencyBudgetFromProbe,
  loadResidencyBudget,
  persistResidencyBudgetFromProbe,
} from './ResidencyBudget';

describe('ResidencyBudget', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('clamps budget bytes into safe range', () => {
    expect(clampResidencyBudgetBytes(1)).toBe(256 * 1024 * 1024);
    expect(clampResidencyBudgetBytes(Number.POSITIVE_INFINITY)).toBe(512 * 1024 * 1024);
    expect(clampResidencyBudgetBytes(9 * 1024 * 1024 * 1024)).toBe(5 * 1024 * 1024 * 1024);
  });

  it('computes budget from max probe bytes with ratio', () => {
    const maxProbeBytes = 8 * 1024 * 1024 * 1024;
    const budget = computeResidencyBudgetFromProbe(
      [{ totalBytes: 2 * 1024 * 1024 * 1024 }, { totalBytes: maxProbeBytes }],
      0.6
    );
    expect(budget).toBe(Math.floor(maxProbeBytes * 0.6));
  });

  it('persists and loads probe-derived budget', () => {
    const persisted = persistResidencyBudgetFromProbe(
      [{ totalBytes: 2 * 1024 * 1024 * 1024 }],
      0.6
    );
    expect(persisted.maxAllocationBytes).toBe(2 * 1024 * 1024 * 1024);

    const loaded = loadResidencyBudget();
    expect(loaded.source).toBe('probe');
    expect(loaded.maxAllocationBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(loaded.budgetBytes).toBe(Math.floor(2 * 1024 * 1024 * 1024 * 0.6));
  });
});
