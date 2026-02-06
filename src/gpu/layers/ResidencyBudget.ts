const STORAGE_KEY = 'paintboard.gpu.residency-budget.v1';
const DEFAULT_BUDGET_BYTES = 512 * 1024 * 1024;
const DEFAULT_RATIO = 0.6;
const MIN_BUDGET_BYTES = 256 * 1024 * 1024;
const MAX_BUDGET_BYTES = 5 * 1024 * 1024 * 1024;

interface StoredResidencyBudget {
  version: 1;
  maxAllocationBytes: number;
  budgetBytes: number;
  ratio: number;
  sampledAtMs: number;
}

export interface LoadedResidencyBudget {
  budgetBytes: number;
  source: 'probe' | 'default';
  maxAllocationBytes: number | null;
  ratio: number;
}

export function clampResidencyBudgetBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return DEFAULT_BUDGET_BYTES;
  }
  return Math.min(MAX_BUDGET_BYTES, Math.max(MIN_BUDGET_BYTES, Math.floor(bytes)));
}

function getMaxAllocationBytes(allocationProbe: Array<{ totalBytes: number }>): number {
  let maxBytes = 0;
  for (const entry of allocationProbe) {
    maxBytes = Math.max(maxBytes, entry.totalBytes || 0);
  }
  return maxBytes;
}

export function computeResidencyBudgetFromProbe(
  allocationProbe: Array<{ totalBytes: number }>,
  ratio: number = DEFAULT_RATIO
): number {
  const maxAllocationBytes = getMaxAllocationBytes(allocationProbe);
  if (maxAllocationBytes <= 0) {
    return DEFAULT_BUDGET_BYTES;
  }
  return clampResidencyBudgetBytes(maxAllocationBytes * ratio);
}

export function persistResidencyBudgetFromProbe(
  allocationProbe: Array<{ totalBytes: number }>,
  ratio: number = DEFAULT_RATIO
): { budgetBytes: number; maxAllocationBytes: number } {
  const maxAllocationBytes = getMaxAllocationBytes(allocationProbe);
  const budgetBytes = computeResidencyBudgetFromProbe(allocationProbe, ratio);

  if (maxAllocationBytes <= 0) {
    return { budgetBytes, maxAllocationBytes };
  }

  try {
    const payload: StoredResidencyBudget = {
      version: 1,
      maxAllocationBytes,
      budgetBytes,
      ratio,
      sampledAtMs: Date.now(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('[ResidencyBudget] Failed to persist probe result', error);
  }

  return { budgetBytes, maxAllocationBytes };
}

export function loadResidencyBudget(
  fallbackBudgetBytes: number = DEFAULT_BUDGET_BYTES
): LoadedResidencyBudget {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        budgetBytes: clampResidencyBudgetBytes(fallbackBudgetBytes),
        source: 'default',
        maxAllocationBytes: null,
        ratio: DEFAULT_RATIO,
      };
    }

    const parsed = JSON.parse(raw) as Partial<StoredResidencyBudget>;
    if (
      parsed.version === 1 &&
      typeof parsed.budgetBytes === 'number' &&
      typeof parsed.maxAllocationBytes === 'number' &&
      typeof parsed.ratio === 'number'
    ) {
      return {
        budgetBytes: clampResidencyBudgetBytes(parsed.budgetBytes),
        source: 'probe',
        maxAllocationBytes: parsed.maxAllocationBytes,
        ratio: parsed.ratio,
      };
    }
  } catch (error) {
    console.warn('[ResidencyBudget] Failed to read persisted budget', error);
  }

  return {
    budgetBytes: clampResidencyBudgetBytes(fallbackBudgetBytes),
    source: 'default',
    maxAllocationBytes: null,
    ratio: DEFAULT_RATIO,
  };
}
