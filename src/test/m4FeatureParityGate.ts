import type { RenderMode } from '@/stores/settings';
import { patternManager, type PatternData } from '@/utils/patternManager';
import {
  compareImageDataUrls,
  isImageParityPass,
  type ImageParityMetrics,
  type ImageParityThresholds,
} from './imageParity';
import {
  DEBUG_CAPTURE_FILE_NAME,
  type FixedStrokeCaptureLoadResult,
} from './strokeCaptureFixedFile';
import type { StrokeCaptureData, StrokeReplayOptions } from './StrokeCapture';

const M4_TEXTURE_PATTERN_ID = '__m4_checker__';
const M4_DEFAULT_SEED = 0x4d344001;
const M4_PARITY_THRESHOLDS: ImageParityThresholds = {
  meanAbsDiffMax: 3.0,
  mismatchRatioMax: 1.5,
};

type M4CaseDefinition = {
  caseId: string;
  toolOverrides: Record<string, unknown>;
};

const M4_CASES: M4CaseDefinition[] = [
  {
    caseId: 'scatter_core',
    toolOverrides: {
      currentTool: 'brush',
      scatterEnabled: true,
      scatter: {
        scatter: 120,
        scatterControl: 'off',
        bothAxes: true,
        count: 2,
        countControl: 'off',
        countJitter: 0,
      },
      textureEnabled: false,
      dualBrushEnabled: false,
      wetEdgeEnabled: false,
      noiseEnabled: false,
      buildupEnabled: false,
    },
  },
  {
    caseId: 'wet_edge_core',
    toolOverrides: {
      currentTool: 'brush',
      scatterEnabled: false,
      textureEnabled: false,
      dualBrushEnabled: false,
      wetEdgeEnabled: true,
      wetEdge: 0.8,
      noiseEnabled: false,
      buildupEnabled: false,
    },
  },
  {
    caseId: 'dual_core',
    toolOverrides: {
      currentTool: 'brush',
      scatterEnabled: false,
      textureEnabled: false,
      dualBrushEnabled: true,
      dualBrush: {
        enabled: true,
        brushId: '__m4_dual__',
        brushIndex: 0,
        brushName: 'M4 Dual',
        mode: 'multiply',
        flip: false,
        size: 24,
        sizeRatio: 1.2,
        spacing: 0.3,
        roundness: 100,
        scatter: 16,
        bothAxes: false,
        count: 1,
      },
      wetEdgeEnabled: false,
      noiseEnabled: false,
      buildupEnabled: false,
    },
  },
  {
    caseId: 'texture_core',
    toolOverrides: {
      currentTool: 'brush',
      scatterEnabled: false,
      textureEnabled: true,
      textureSettings: {
        patternId: M4_TEXTURE_PATTERN_ID,
        scale: 100,
        brightness: 0,
        contrast: 0,
        mode: 'multiply',
        depth: 80,
        invert: false,
      },
      dualBrushEnabled: false,
      wetEdgeEnabled: false,
      noiseEnabled: false,
      buildupEnabled: false,
    },
  },
  {
    caseId: 'combo_core',
    toolOverrides: {
      currentTool: 'brush',
      scatterEnabled: true,
      scatter: {
        scatter: 80,
        scatterControl: 'off',
        bothAxes: true,
        count: 2,
        countControl: 'off',
        countJitter: 0,
      },
      textureEnabled: true,
      textureSettings: {
        patternId: M4_TEXTURE_PATTERN_ID,
        scale: 125,
        brightness: 0,
        contrast: 0,
        mode: 'overlay',
        depth: 65,
        invert: false,
      },
      dualBrushEnabled: true,
      dualBrush: {
        enabled: true,
        brushId: '__m4_dual__',
        brushIndex: 0,
        brushName: 'M4 Dual',
        mode: 'overlay',
        flip: false,
        size: 28,
        sizeRatio: 1.4,
        spacing: 0.3,
        roundness: 90,
        scatter: 20,
        bothAxes: true,
        count: 2,
      },
      wetEdgeEnabled: true,
      wetEdge: 0.7,
      noiseEnabled: true,
      buildupEnabled: true,
    },
  },
];

export interface M4ParityGateCaseResult extends ImageParityMetrics {
  caseId: string;
  passed: boolean;
  error?: string;
}

export interface M4ParityGateResult {
  passed: boolean;
  report: string;
  thresholds: ImageParityThresholds;
  seed: number;
  captureName: string;
  captureSource: string;
  capturePath: string;
  uncapturedErrors: number;
  deviceLost: boolean;
  cases: M4ParityGateCaseResult[];
}

export interface M4ParityGateOptions {
  seed?: number;
  capture?: StrokeCaptureData | string;
}

interface CreateM4ParityGateParams {
  replay: (
    capture?: StrokeCaptureData | string,
    options?: StrokeReplayOptions
  ) => Promise<{ events: number; durationMs: number } | null>;
  clearLayer: () => void;
  getFlattenedImage: () => Promise<string | undefined>;
  loadFixedCapture: () => Promise<FixedStrokeCaptureLoadResult | null>;
  parseStrokeCaptureInput: (
    capture: StrokeCaptureData | string | undefined,
    fallback: StrokeCaptureData | null
  ) => StrokeCaptureData | null;
  getRenderMode: () => RenderMode;
  setRenderMode: (mode: RenderMode) => void;
  waitForAnimationFrame: () => Promise<void>;
  resetGpuDiagnostics?: () => boolean;
  getGpuDiagnosticsSnapshot?: () => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function normalizeSeed(seed: unknown): number {
  return typeof seed === 'number' && Number.isFinite(seed)
    ? Math.max(1, Math.floor(Math.abs(seed)))
    : M4_DEFAULT_SEED;
}

function createSeededRandom(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

async function withSeededMathRandom<T>(seed: number, task: () => Promise<T>): Promise<T> {
  const mathObject = Math as Math & { random: () => number };
  const originalRandom = mathObject.random;
  mathObject.random = createSeededRandom(seed);
  try {
    return await task();
  } finally {
    mathObject.random = originalRandom;
  }
}

function createCheckerPattern(id: string, size: number = 16): PatternData {
  const safeSize = Math.max(4, Math.floor(size));
  const data = new Uint8Array(safeSize * safeSize * 4);
  for (let y = 0; y < safeSize; y += 1) {
    for (let x = 0; x < safeSize; x += 1) {
      const index = (y * safeSize + x) * 4;
      const checker = ((x >> 2) + (y >> 2)) % 2 === 0;
      const v = checker ? 220 : 40;
      data[index] = v;
      data[index + 1] = v;
      data[index + 2] = v;
      data[index + 3] = 255;
    }
  }
  return { id, width: safeSize, height: safeSize, data };
}

function buildM4CaseCapture(base: StrokeCaptureData, caseDef: M4CaseDefinition): StrokeCaptureData {
  const baseTool = isRecord(base.metadata.tool) ? base.metadata.tool : {};
  return {
    ...base,
    metadata: {
      ...base.metadata,
      tool: {
        ...baseTool,
        ...caseDef.toolOverrides,
      },
    },
  };
}

function getDiagnosticsStatus(snapshot: unknown): {
  uncapturedErrors: number;
  deviceLost: boolean;
} {
  if (!isRecord(snapshot)) {
    return { uncapturedErrors: 0, deviceLost: false };
  }
  return {
    uncapturedErrors: Array.isArray(snapshot.uncapturedErrors)
      ? snapshot.uncapturedErrors.length
      : 0,
    deviceLost: Boolean(snapshot.deviceLost),
  };
}

export function createM4ParityGate(
  params: CreateM4ParityGateParams
): (options?: M4ParityGateOptions) => Promise<M4ParityGateResult> {
  return async (options = {}): Promise<M4ParityGateResult> => {
    const originalMode = params.getRenderMode();
    const seed = normalizeSeed(options.seed);
    const cases: M4ParityGateCaseResult[] = [];
    let captureName = DEBUG_CAPTURE_FILE_NAME;
    let captureSource = 'unknown';
    let capturePath = 'unknown';
    let uncapturedErrors = 0;
    let deviceLost = false;
    let gateError: string | null = null;

    const renderReport = (passed: boolean): string => {
      const lines = [
        `Capture: ${captureName}`,
        `Capture source: ${captureSource}`,
        `Capture path: ${capturePath}`,
        `Seed: ${seed}`,
        `Threshold meanAbsDiff <= ${M4_PARITY_THRESHOLDS.meanAbsDiffMax.toFixed(2)}`,
        `Threshold mismatchRatio <= ${M4_PARITY_THRESHOLDS.mismatchRatioMax.toFixed(2)}%`,
        '',
      ];
      for (const result of cases) {
        if (result.error) {
          lines.push(`${result.caseId}: FAIL (${result.error})`);
          continue;
        }
        lines.push(
          `${result.caseId}: ${result.passed ? 'PASS' : 'FAIL'} | meanAbsDiff=${result.meanAbsDiff.toFixed(3)} mismatchRatio=${result.mismatchRatio.toFixed(3)}% maxDiff=${result.maxDiff}`
        );
      }
      lines.push('');
      lines.push(`uncapturedErrors=${uncapturedErrors}`);
      lines.push(`deviceLost=${deviceLost ? 'YES' : 'NO'}`);
      if (gateError) {
        lines.push(`error=${gateError}`);
      }
      lines.push(`M4 Gate: ${passed ? 'PASS' : 'FAIL'}`);
      return lines.join('\n');
    };

    try {
      let baseCapture: StrokeCaptureData | null = null;

      if (typeof options.capture !== 'undefined') {
        baseCapture = params.parseStrokeCaptureInput(options.capture, null);
        if (!baseCapture) {
          throw new Error('Invalid capture input for M4 parity gate');
        }
      }

      if (!baseCapture) {
        const fixedCapture = await params.loadFixedCapture();
        if (!fixedCapture) {
          throw new Error(
            `Fixed capture missing: ${DEBUG_CAPTURE_FILE_NAME}. Please record and save first.`
          );
        }
        baseCapture = fixedCapture.capture;
        captureName = fixedCapture.name;
        captureSource = fixedCapture.source;
        capturePath = fixedCapture.path;
      } else {
        captureSource = 'options.capture';
        capturePath = 'inline';
      }

      patternManager.registerPattern(createCheckerPattern(M4_TEXTURE_PATTERN_ID));
      params.resetGpuDiagnostics?.();

      const runSingleReplay = async (
        renderMode: RenderMode,
        capture: StrokeCaptureData,
        replaySeed: number
      ): Promise<string> => {
        params.setRenderMode(renderMode);
        await params.waitForAnimationFrame();
        await params.waitForAnimationFrame();
        params.clearLayer();
        await params.waitForAnimationFrame();
        const replayResult = await withSeededMathRandom(replaySeed, async () =>
          params.replay(capture, { speed: 1 })
        );
        if (!replayResult) {
          throw new Error(`Replay failed in ${renderMode} mode`);
        }
        await params.waitForAnimationFrame();
        const dataUrl = await params.getFlattenedImage();
        if (!dataUrl) {
          throw new Error(`Flattened image unavailable in ${renderMode} mode`);
        }
        return dataUrl;
      };

      for (let i = 0; i < M4_CASES.length; i += 1) {
        const caseDef = M4_CASES[i]!;
        const capture = buildM4CaseCapture(baseCapture, caseDef);
        try {
          const replaySeed = seed + i;
          const gpuImage = await runSingleReplay('gpu', capture, replaySeed);
          const cpuImage = await runSingleReplay('cpu', capture, replaySeed);
          const metrics = await compareImageDataUrls(cpuImage, gpuImage);
          const passed = isImageParityPass(metrics, M4_PARITY_THRESHOLDS);
          cases.push({ caseId: caseDef.caseId, ...metrics, passed });
        } catch (error) {
          cases.push({
            caseId: caseDef.caseId,
            meanAbsDiff: Number.POSITIVE_INFINITY,
            mismatchRatio: Number.POSITIVE_INFINITY,
            maxDiff: 255,
            pixelCount: 0,
            passed: false,
            error: String(error),
          });
        }
      }

      const diagStatus = getDiagnosticsStatus(params.getGpuDiagnosticsSnapshot?.());
      uncapturedErrors = diagStatus.uncapturedErrors;
      deviceLost = diagStatus.deviceLost;
    } catch (error) {
      gateError = String(error);
    } finally {
      params.setRenderMode(originalMode);
      patternManager.removePattern(M4_TEXTURE_PATTERN_ID);
      await params.waitForAnimationFrame();
    }

    const casesPassed = cases.length === M4_CASES.length && cases.every((item) => item.passed);
    const passed = !gateError && casesPassed && uncapturedErrors === 0 && !deviceLost;
    return {
      passed,
      report: renderReport(passed),
      thresholds: M4_PARITY_THRESHOLDS,
      seed,
      captureName,
      captureSource,
      capturePath,
      uncapturedErrors,
      deviceLost,
      cases,
    };
  };
}
