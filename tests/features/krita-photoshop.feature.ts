/**
 * @description 功能测试: [Feature]: 画笔压感优化：低压平滑与收笔过渡对齐 Krita/Photoshop
 * @issue #146
 */
import { describe, expect, it } from 'vitest';
import { BrushStamper } from '@/utils/strokeBuffer';

function calcVariance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / values.length;
}

function calcTailDropRate(values: number[]): number {
  if (values.length < 2) return 0;
  const start = values[0]!;
  const end = values[values.length - 1]!;
  if (start <= 1e-6) return 0;
  return Math.max(0, (start - end) / start);
}

function simulateFastLiftStroke(tailTaperEnabled: boolean): number[] {
  const stamper = new BrushStamper();
  stamper.beginStroke();

  const allPressures: number[] = [];
  for (let i = 0; i < 14; i += 1) {
    const dabs = stamper.processPoint(i * 5, 0, 0.42, 2, false, {
      timestampMs: i * 4,
      maxBrushSpeedPxPerMs: 1,
      brushSpeedSmoothingSamples: 3,
      lowPressureAdaptiveSmoothingEnabled: true,
      tailTaperEnabled,
    });
    allPressures.push(...dabs.map((dab) => dab.pressure));
  }

  const tailDabs = stamper.finishStroke(24, {
    maxBrushSpeedPxPerMs: 1,
    brushSpeedSmoothingSamples: 3,
    lowPressureAdaptiveSmoothingEnabled: true,
    tailTaperEnabled,
  });
  allPressures.push(...tailDabs.map((dab) => dab.pressure));

  return allPressures;
}

function simulateLowPressureStroke(lowPressureAdaptiveSmoothingEnabled: boolean): number[] {
  const stamper = new BrushStamper();
  stamper.beginStroke();
  const pressurePattern = [0.02, 0.1, 0.03, 0.11, 0.02, 0.09, 0.04, 0.1, 0.03, 0.11, 0.02];
  const pressures: number[] = [];

  for (let i = 0; i < pressurePattern.length; i += 1) {
    const dabs = stamper.processPoint(i * 4, 0, pressurePattern[i]!, 2, false, {
      timestampMs: i * 4,
      maxBrushSpeedPxPerMs: 1,
      brushSpeedSmoothingSamples: 3,
      lowPressureAdaptiveSmoothingEnabled,
      tailTaperEnabled: false,
    });
    pressures.push(...dabs.map((dab) => dab.pressure));
  }

  stamper.finishStroke(20, {
    lowPressureAdaptiveSmoothingEnabled,
    tailTaperEnabled: false,
  });

  return pressures;
}

describe('[Feature]: 画笔压感优化：低压平滑与收笔过渡对齐 Krita/Photoshop', () => {
  it('末端 10% 笔程平均线宽下降率（压力代理）在 tail taper 启用后提升', () => {
    const baseline = simulateFastLiftStroke(false);
    const improved = simulateFastLiftStroke(true);

    const baselineTail = baseline.slice(Math.max(0, Math.floor(baseline.length * 0.9)));
    const improvedTail = improved.slice(Math.max(0, Math.floor(improved.length * 0.9)));

    const baselineDropRate = calcTailDropRate(baselineTail);
    const improvedDropRate = calcTailDropRate(improvedTail);

    expect(improvedDropRate).toBeGreaterThan(baselineDropRate);
  });

  it('低压段线宽方差（压力代理）在自适应平滑启用后下降', () => {
    const baseline = simulateLowPressureStroke(false);
    const improved = simulateLowPressureStroke(true);

    const baselineVariance = calcVariance(baseline);
    const improvedVariance = calcVariance(improved);

    expect(improved.length).toBeGreaterThan(3);
    expect(baseline.length).toBeGreaterThan(3);
    expect(improvedVariance).toBeLessThan(baselineVariance);
  });
});

