#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';

const DEFAULT_URL = 'http://localhost:1420/';
const DEFAULT_FIXTURES_DIR = 'tests/fixtures/krita-tail';
const DEFAULT_ROUNDS = 10;
const KNOWN_BACKENDS = ['windows_wintab', 'windows_winink_pointer', 'mac_native'];
const METRIC_KEYS = [
  'pressure_tail_mae',
  'pressure_tail_p95',
  'sampler_t_emd',
  'sampler_t_missing_ratio',
  'dab_tail_count_delta',
  'dab_tail_mean_spacing_delta_px',
  'dab_tail_pressure_slope_delta',
  'terminal_sample_drop_count',
];
const DEFAULT_THRESHOLD_FLOOR = {
  pressure_tail_mae: 0.015,
  pressure_tail_p95: 0.035,
  sampler_t_emd: 0.05,
  sampler_t_missing_ratio: 0.03,
  dab_tail_count_delta: 1,
  dab_tail_mean_spacing_delta_px: 0.5,
  dab_tail_pressure_slope_delta: 0.06,
  terminal_sample_drop_count: 0,
};
const RELAXED_THRESHOLDS = {
  pressure_tail_mae: 1e9,
  pressure_tail_p95: 1e9,
  sampler_t_emd: 1e9,
  sampler_t_missing_ratio: 1e9,
  dab_tail_count_delta: 1e9,
  dab_tail_mean_spacing_delta_px: 1e9,
  dab_tail_pressure_slope_delta: 1e9,
  terminal_sample_drop_count: 1e9,
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'case') {
      const values = [];
      let j = i + 1;
      while (j < argv.length && !argv[j].startsWith('--')) {
        values.push(argv[j]);
        j += 1;
      }
      args[key] = values.length > 0 ? values.join(',') : 'true';
      i = j - 1;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeUrl(input) {
  const raw = String(input ?? DEFAULT_URL).trim();
  if (!raw) return DEFAULT_URL;
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeBackendId(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (raw === 'windows_wintab' || raw === 'wintab' || raw === 'native-stream') {
    return 'windows_wintab';
  }
  if (
    raw === 'windows_winink_pointer' ||
    raw === 'winink_pointer' ||
    raw === 'pointer' ||
    raw === 'pointerevent'
  ) {
    return 'windows_winink_pointer';
  }
  if (raw === 'mac_native' || raw === 'macnative') {
    return 'mac_native';
  }
  return raw;
}

function deriveLegacyBackend(config) {
  const explicit = normalizeBackendId(config?.inputBackend ?? '');
  if (KNOWN_BACKENDS.includes(explicit)) return explicit;
  const buildBackend = normalizeBackendId(config?.build?.inputBackend ?? '');
  if (KNOWN_BACKENDS.includes(buildBackend)) return buildBackend;
  return 'windows_wintab';
}

function resolveBaselineBackends(baselineConfig, requestedBackend) {
  const normalizedRequested = requestedBackend ? normalizeBackendId(requestedBackend) : null;
  if (
    baselineConfig?.schemaVersion === 'krita-tail-baseline-config-v2' &&
    baselineConfig?.backends &&
    typeof baselineConfig.backends === 'object'
  ) {
    const backendEntries = Object.entries(baselineConfig.backends).map(([backend, config]) => ({
      backend: normalizeBackendId(backend),
      config,
    }));
    if (normalizedRequested) {
      const selected = backendEntries.filter((entry) => entry.backend === normalizedRequested);
      if (selected.length === 0) {
        throw new Error(`Backend "${normalizedRequested}" not found in baseline config v2`);
      }
      return selected;
    }
    return backendEntries;
  }

  const legacyBackend = normalizedRequested ?? deriveLegacyBackend(baselineConfig);
  return [{ backend: legacyBackend, config: baselineConfig }];
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function std(values, avg) {
  if (values.length === 0) return 0;
  const variance = values.reduce((acc, value) => acc + (value - avg) * (value - avg), 0) / values.length;
  return Math.sqrt(variance);
}

function buildTraceMeta(baseConfig, caseConfig, backend) {
  return {
    caseId: caseConfig.id,
    canvas: {
      ...(baseConfig.canvas ?? { width: 0, height: 0, dpi: 72 }),
      ...(caseConfig.canvas ?? {}),
    },
    brushPreset: caseConfig.brushPreset ?? baseConfig.brushPreset ?? 'krita-tail-pressure-only',
    inputBackend: backend,
    runtimeFlags: {
      ...(baseConfig.runtimeFlags ?? {}),
      ...(caseConfig.runtimeFlags ?? {}),
    },
    build: {
      ...(baseConfig.build ?? {}),
      ...(caseConfig.build ?? {}),
      inputBackend: backend,
    },
  };
}

function runSelfCheck() {
  const v1Baseline = {
    schemaVersion: 'krita-tail-baseline-config-v1',
    build: { inputBackend: 'native-stream' },
    cases: [{ id: 'case-a' }],
  };
  const v2Baseline = {
    schemaVersion: 'krita-tail-baseline-config-v2',
    backends: {
      windows_wintab: { cases: [{ id: 'case-a' }] },
      windows_winink_pointer: { cases: [{ id: 'case-b' }] },
    },
  };
  const resolvedV1 = resolveBaselineBackends(v1Baseline);
  if (resolvedV1.length !== 1 || resolvedV1[0].backend !== 'windows_wintab') {
    throw new Error('self-check failed: resolveBaselineBackends v1');
  }
  const resolvedV2 = resolveBaselineBackends(v2Baseline, 'windows_winink_pointer');
  if (resolvedV2.length !== 1 || resolvedV2[0].backend !== 'windows_winink_pointer') {
    throw new Error('self-check failed: resolveBaselineBackends v2');
  }
  const meta = buildTraceMeta(
    {
      canvas: { width: 10, height: 10, dpi: 72 },
      build: { inputBackend: 'legacy' },
    },
    { id: 'case-a' },
    'mac_native'
  );
  if (meta.inputBackend !== 'mac_native' || meta.build.inputBackend !== 'mac_native') {
    throw new Error('self-check failed: buildTraceMeta backend injection');
  }
}

async function waitForTraceApis(page) {
  await page.waitForFunction(
    () =>
      typeof window.__strokeCaptureReplay === 'function' &&
      typeof window.__kritaTailTraceStart === 'function' &&
      typeof window.__kritaTailTraceStop === 'function' &&
      typeof window.__kritaTailTraceLast === 'function',
    undefined,
    { timeout: 120000 }
  );
}

async function runTraceCase(page, args) {
  return page.evaluate(
    async ({ capture, traceMeta, replaySpeed, waitMs, strokeId }) => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitRaf = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

      if (typeof window.__kritaTailTraceStart !== 'function') {
        throw new Error('Missing API: window.__kritaTailTraceStart');
      }
      if (typeof window.__kritaTailTraceStop !== 'function') {
        throw new Error('Missing API: window.__kritaTailTraceStop');
      }
      if (typeof window.__strokeCaptureReplay !== 'function') {
        throw new Error('Missing API: window.__strokeCaptureReplay');
      }
      if (typeof window.__canvasClearLayer === 'function') {
        window.__canvasClearLayer();
      }

      window.__kritaTailTraceStart({
        strokeId,
        meta: traceMeta,
      });
      await waitRaf();
      await waitRaf();

      const replayResult = await window.__strokeCaptureReplay(capture, { speed: replaySpeed });
      await wait(waitMs);
      await waitRaf();
      await waitRaf();

      const trace = window.__kritaTailTraceStop() ?? window.__kritaTailTraceLast?.() ?? null;
      return {
        replayResult,
        trace,
      };
    },
    {
      capture: args.capture,
      traceMeta: args.traceMeta,
      replaySpeed: args.replaySpeed,
      waitMs: args.waitMs,
      strokeId: args.strokeId,
    }
  );
}

async function validateTraceSchema(page, trace) {
  return page.evaluate(async ({ trace }) => {
    const schema = await import('/src/test/kritaTailTrace/schema.ts');
    return schema.validateKritaTailTrace(trace);
  }, { trace });
}

async function compareTrace(page, sutuTrace, kritaTrace, thresholds) {
  return page.evaluate(
    async ({ sutuTrace, kritaTrace, thresholds }) => {
      const compare = await import('/src/test/kritaTailTrace/compare.ts');
      return compare.compareKritaTailTrace(sutuTrace, kritaTrace, thresholds);
    },
    { sutuTrace, kritaTrace, thresholds }
  );
}

const cli = parseArgs(process.argv.slice(2));
if (cli['self-check'] === 'true' || cli['self-check'] === true) {
  runSelfCheck();
  console.log(JSON.stringify({ ok: true, script: 'calibrate-krita-tail-thresholds' }, null, 2));
  process.exit(0);
}
const repoRoot = process.cwd();
const fixturesDir = path.resolve(repoRoot, cli.fixtures ?? DEFAULT_FIXTURES_DIR);
const baselineConfigPath = path.resolve(fixturesDir, cli.config ?? 'baseline-config.json');
const outputDir = path.resolve(
  repoRoot,
  cli.output ?? `debug_output/krita-tail-gate/calibrate-${new Date().toISOString().replace(/[:.]/g, '-')}`
);
const thresholdOutputPath = path.resolve(fixturesDir, cli['out-thresholds'] ?? 'thresholds.json');
const appUrl = normalizeUrl(cli.url ?? DEFAULT_URL);
const rounds = Math.max(1, Math.floor(toNumber(cli.rounds, DEFAULT_ROUNDS)));
const headless = cli.headless === undefined ? true : !(cli.headless === 'false' || cli.headless === '0');

if (!fs.existsSync(baselineConfigPath)) {
  throw new Error(`Missing baseline config: ${baselineConfigPath}`);
}

const baselineConfig = readJson(baselineConfigPath);
const backendRuns = resolveBaselineBackends(baselineConfig, cli.backend);
const caseFilter = cli.case
  ? new Set(
      String(cli.case)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    )
  : null;
if (backendRuns.length === 0) {
  throw new Error('No backend selected for calibration');
}

ensureDir(outputDir);
const backendCalibrations = {};

const browser = await chromium.launch({
  headless,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitForTraceApis(page);

  for (const backendRun of backendRuns) {
    const backend = backendRun.backend;
    const backendConfig = backendRun.config ?? {};
    const allCases = Array.isArray(backendConfig.cases) ? backendConfig.cases : [];
    const selectedCases = caseFilter ? allCases.filter((item) => caseFilter.has(item.id)) : allCases;
    if (selectedCases.length === 0) {
      throw new Error(`No cases selected for backend "${backend}"`);
    }

    const metricBuckets = Object.fromEntries(METRIC_KEYS.map((key) => [key, []]));
    const perRoundResults = [];
    for (let round = 1; round <= rounds; round += 1) {
      for (const caseConfig of selectedCases) {
        const capturePath = path.resolve(fixturesDir, caseConfig.capture);
        const kritaTracePath = path.resolve(fixturesDir, caseConfig.kritaTrace);
        if (!fs.existsSync(capturePath)) {
          throw new Error(`Missing capture for case "${caseConfig.id}": ${capturePath}`);
        }
        if (!fs.existsSync(kritaTracePath)) {
          throw new Error(`Missing krita trace for case "${caseConfig.id}": ${kritaTracePath}`);
        }

        const capture = readJson(capturePath);
        const kritaTrace = readJson(kritaTracePath);
        const traceMeta = buildTraceMeta(backendConfig, caseConfig, backend);
        const replaySpeed = toNumber(
          caseConfig.replaySpeed,
          toNumber(backendConfig.defaultReplaySpeed, 1)
        );
        const waitMs = Math.max(
          0,
          Math.floor(toNumber(caseConfig.waitMs, toNumber(backendConfig.defaultWaitMs, 200)))
        );
        const strokeId = `${backend}-${caseConfig.id}-round-${round}-${Date.now()}`;

        const traceRun = await runTraceCase(page, {
          capture,
          traceMeta,
          replaySpeed,
          waitMs,
          strokeId,
        });
        const sutuTrace = traceRun.trace;
        if (!sutuTrace) {
          throw new Error(
            `Trace export failed for case "${caseConfig.id}" round ${round} backend "${backend}"`
          );
        }

        const sutuSchemaErrors = await validateTraceSchema(page, sutuTrace);
        const kritaSchemaErrors = await validateTraceSchema(page, kritaTrace);
        if (sutuSchemaErrors.length > 0) {
          throw new Error(
            `Sutu trace schema invalid for "${caseConfig.id}" round ${round} backend "${backend}": ${sutuSchemaErrors.join('; ')}`
          );
        }
        if (kritaSchemaErrors.length > 0) {
          throw new Error(
            `Krita trace schema invalid for "${caseConfig.id}" round ${round} backend "${backend}": ${kritaSchemaErrors.join('; ')}`
          );
        }

        const gateResult = await compareTrace(page, sutuTrace, kritaTrace, RELAXED_THRESHOLDS);
        const metrics = gateResult.metrics;
        for (const key of METRIC_KEYS) {
          metricBuckets[key].push(metrics[key]);
        }
        perRoundResults.push({
          backend,
          round,
          caseId: caseConfig.id,
          metrics,
        });
      }
    }
    const calibratedMetrics = {};
    const stats = {};
    for (const key of METRIC_KEYS) {
      const values = metricBuckets[key];
      const avg = mean(values);
      const sigma = std(values, avg);
      const computed = avg + 3 * sigma;
      calibratedMetrics[key] = Math.max(DEFAULT_THRESHOLD_FLOOR[key], computed);
      stats[key] = {
        samples: values.length,
        mean: avg,
        std: sigma,
        computed,
        floor: DEFAULT_THRESHOLD_FLOOR[key],
        final: calibratedMetrics[key],
      };
    }

    backendCalibrations[backend] = {
      metrics: calibratedMetrics,
      stats,
      cases: selectedCases.map((item) => item.id),
      results: perRoundResults,
    };
  }
} finally {
  await browser.close();
}

const thresholdPayload = {
  schemaVersion: 'krita-tail-thresholds-v2',
  generatedAt: new Date().toISOString(),
  rounds,
  appUrl,
  backends: backendCalibrations,
};

const report = {
  schemaVersion: 'krita-tail-calibration-report-v2',
  generatedAt: new Date().toISOString(),
  rounds,
  appUrl,
  backends: backendCalibrations,
  thresholdOutput: path.relative(repoRoot, thresholdOutputPath).replace(/\\/g, '/'),
};

writeJson(thresholdOutputPath, thresholdPayload);
writeJson(path.join(outputDir, 'calibration-report.json'), report);

console.log(
  JSON.stringify(
    {
      thresholdOutputPath,
      rounds,
      backends: Object.keys(backendCalibrations),
    },
    null,
    2
  )
);
