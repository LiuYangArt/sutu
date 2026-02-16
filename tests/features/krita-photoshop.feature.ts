/**
 * @description 功能测试: [Feature] Krita 尾端对齐（主链路收束 + 联合采样）
 * @issue #146
 */
import { describe, expect, it } from 'vitest';
import { BrushStamper } from '@/utils/strokeBuffer';

type StrokeSample = {
  x: number;
  y: number;
  pressure: number;
  timestampMs: number;
};

function calcMaxAdjacentDrop(values: number[]): number {
  if (values.length < 2) return 0;
  let maxDrop = 0;
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1] ?? 0;
    const curr = values[i] ?? 0;
    maxDrop = Math.max(maxDrop, Math.max(0, prev - curr));
  }
  return maxDrop;
}

function tailSlice(values: number[], ratio: number = 0.2): number[] {
  if (values.length === 0) return [];
  const start = Math.max(0, Math.floor(values.length * (1 - ratio)));
  return values.slice(start);
}

function runProgramStroke(
  samples: StrokeSample[],
  options?: { spacingPx?: number; finishSpacingPx?: number; maxDabIntervalMs?: number }
): {
  mainPressures: number[];
  finalizePressures: number[];
  finalizeDabs: Array<{ x: number; y: number; pressure: number }>;
} {
  const stamper = new BrushStamper();
  stamper.beginStroke();

  const spacingPx = options?.spacingPx ?? 2;
  const finishSpacingPx = options?.finishSpacingPx ?? 24;
  const maxDabIntervalMs = options?.maxDabIntervalMs;

  const mainPressures: number[] = [];
  for (const sample of samples) {
    const dabs = stamper.processPoint(sample.x, sample.y, sample.pressure, spacingPx, false, {
      timestampMs: sample.timestampMs,
      maxBrushSpeedPxPerMs: 30,
      brushSpeedSmoothingSamples: 3,
      lowPressureAdaptiveSmoothingEnabled: true,
      maxDabIntervalMs,
    });
    mainPressures.push(...dabs.map((dab) => dab.pressure));
  }

  const finalizeDabs = stamper.finishStroke(finishSpacingPx, {
    maxBrushSpeedPxPerMs: 30,
    brushSpeedSmoothingSamples: 3,
    lowPressureAdaptiveSmoothingEnabled: true,
    maxDabIntervalMs,
  });
  const finalizePressures = finalizeDabs.map((dab) => dab.pressure);

  return {
    mainPressures,
    finalizePressures,
    finalizeDabs,
  };
}

function buildFastFlingSamples(): StrokeSample[] {
  return [
    { x: 0, y: 0, pressure: 0.45, timestampMs: 0 },
    { x: 7, y: 0, pressure: 0.45, timestampMs: 3 },
    { x: 14, y: 0, pressure: 0.44, timestampMs: 6 },
    { x: 21, y: 0, pressure: 0.43, timestampMs: 9 },
    { x: 28, y: 0, pressure: 0.42, timestampMs: 12 },
    { x: 35, y: 0, pressure: 0.42, timestampMs: 15 },
    { x: 42, y: 0, pressure: 0.41, timestampMs: 18 },
    { x: 49, y: 0, pressure: 0.4, timestampMs: 21 },
  ];
}

function buildSlowLiftSamples(): StrokeSample[] {
  return [
    { x: 0, y: 0, pressure: 0.5, timestampMs: 0 },
    { x: 4, y: 0, pressure: 0.46, timestampMs: 10 },
    { x: 8, y: 0, pressure: 0.42, timestampMs: 20 },
    { x: 12, y: 0, pressure: 0.35, timestampMs: 30 },
    { x: 16, y: 0, pressure: 0.28, timestampMs: 40 },
    { x: 20, y: 0, pressure: 0.2, timestampMs: 50 },
    { x: 24, y: 0, pressure: 0.14, timestampMs: 60 },
    { x: 28, y: 0, pressure: 0.1, timestampMs: 70 },
  ];
}

function buildAbruptStopSamples(): StrokeSample[] {
  return [
    { x: 0, y: 0, pressure: 0.48, timestampMs: 0 },
    { x: 8, y: 0, pressure: 0.48, timestampMs: 4 },
    { x: 16, y: 0, pressure: 0.48, timestampMs: 8 },
    { x: 24, y: 0, pressure: 0.47, timestampMs: 12 },
    { x: 32, y: 0, pressure: 0.47, timestampMs: 16 },
    { x: 40, y: 0, pressure: 0.46, timestampMs: 20 },
    { x: 41, y: 0, pressure: 0.46, timestampMs: 24 },
  ];
}

describe('[Feature] Krita 尾端对齐（主链路收束 + 联合采样）', () => {
  it('固定程序样本下尾段压力曲线连续，不出现补丁式突降', () => {
    const cases = [buildFastFlingSamples(), buildSlowLiftSamples(), buildAbruptStopSamples()];

    for (const samples of cases) {
      const result = runProgramStroke(samples);
      const allPressures = [...result.mainPressures, ...result.finalizePressures];
      expect(allPressures.length).toBeGreaterThan(3);

      const tailPressures = tailSlice(allPressures, 0.25);
      expect(tailPressures.length).toBeGreaterThan(1);
      expect(calcMaxAdjacentDrop(tailPressures)).toBeLessThan(0.35);

      if (result.mainPressures.length > 0 && result.finalizePressures.length > 0) {
        const lastMain = result.mainPressures[result.mainPressures.length - 1] ?? 0;
        const firstFinalize = result.finalizePressures[0] ?? 0;
        expect(Math.abs(firstFinalize - lastMain)).toBeLessThan(0.2);
      }
    }
  });

  it('联合采样下，低位移高时差输入可由 timing 通道触发额外采样', () => {
    const microSamples: StrokeSample[] = [
      { x: 0, y: 0, pressure: 0.45, timestampMs: 0 },
      { x: 4, y: 0, pressure: 0.45, timestampMs: 8 },
      { x: 4.08, y: 0, pressure: 0.45, timestampMs: 48 },
      { x: 4.16, y: 0, pressure: 0.45, timestampMs: 88 },
      { x: 4.24, y: 0, pressure: 0.45, timestampMs: 128 },
      { x: 4.32, y: 0, pressure: 0.45, timestampMs: 168 },
      { x: 4.4, y: 0, pressure: 0.45, timestampMs: 208 },
    ];

    const timingDriven = runProgramStroke(microSamples, {
      spacingPx: 6,
      finishSpacingPx: 24,
      maxDabIntervalMs: 10,
    });
    const distanceOnly = runProgramStroke(microSamples, {
      spacingPx: 6,
      finishSpacingPx: 24,
      maxDabIntervalMs: 1000,
    });

    const timingCount = timingDriven.mainPressures.length + timingDriven.finalizePressures.length;
    const distanceOnlyCount =
      distanceOnly.mainPressures.length + distanceOnly.finalizePressures.length;

    expect(timingCount).toBeGreaterThan(0);
    expect(timingCount).toBeGreaterThan(distanceOnlyCount);
  });

  it('收笔新增 dabs 保持在真实末段参数域内（不越界外推）', () => {
    const samples = Array.from({ length: 9 }, (_, index) => ({
      x: index * 6,
      y: 0,
      pressure: 0.42,
      timestampMs: index * 4,
    }));

    const { finalizeDabs } = runProgramStroke(samples, {
      spacingPx: 2,
      finishSpacingPx: 24,
      maxDabIntervalMs: 1,
    });
    expect(finalizeDabs.length).toBeGreaterThan(0);
    for (const dab of finalizeDabs) {
      expect(dab.x).toBeGreaterThanOrEqual(42 - 1e-6);
      expect(dab.x).toBeLessThanOrEqual(48 + 1e-6);
      expect(dab.y).toBeCloseTo(0, 6);
    }
  });
});
