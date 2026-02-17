#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { writeKritaTailChartPng } from './lib/krita-tail-chart.mjs';

const DEFAULT_URL = 'http://localhost:1420/';
const DEFAULT_FIXTURES_DIR = 'tests/fixtures/krita-tail';
const KNOWN_BACKENDS = ['windows_wintab', 'windows_winink_pointer', 'mac_native'];
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

function loadGateThresholdsByBackend(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      schemaVersion: 'krita-tail-thresholds-default',
      defaultMetrics: { ...DEFAULT_THRESHOLD_FLOOR },
      byBackend: {},
    };
  }
  const parsed = readJson(filePath);
  if (
    parsed?.schemaVersion === 'krita-tail-thresholds-v2' &&
    parsed.backends &&
    typeof parsed.backends === 'object'
  ) {
    const byBackend = {};
    for (const [backend, payload] of Object.entries(parsed.backends)) {
      if (!payload || typeof payload !== 'object') continue;
      byBackend[normalizeBackendId(backend)] = {
        ...DEFAULT_THRESHOLD_FLOOR,
        ...(payload.metrics ?? {}),
      };
    }
    return {
      schemaVersion: parsed.schemaVersion,
      defaultMetrics: null,
      byBackend,
    };
  }
  if (parsed && typeof parsed === 'object' && parsed.metrics && typeof parsed.metrics === 'object') {
    return {
      schemaVersion: parsed.schemaVersion ?? 'krita-tail-thresholds-v1',
      defaultMetrics: { ...DEFAULT_THRESHOLD_FLOOR, ...parsed.metrics },
      byBackend: {},
    };
  }
  return {
    schemaVersion: parsed?.schemaVersion ?? 'krita-tail-thresholds-v1',
    defaultMetrics: { ...DEFAULT_THRESHOLD_FLOOR, ...(parsed ?? {}) },
    byBackend: {},
  };
}

function resolveThresholdsForBackend(thresholdStore, backend) {
  const normalized = normalizeBackendId(backend);
  return (
    thresholdStore.byBackend?.[normalized] ??
    thresholdStore.defaultMetrics ?? { ...DEFAULT_THRESHOLD_FLOOR }
  );
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

function splitFailuresByBackend(backend, failures) {
  const normalized = normalizeBackendId(backend);
  if (normalized === 'windows_wintab') {
    return {
      blockingFailures: [...failures],
      nonBlockingFailures: [],
    };
  }
  const blockingFailures = failures.filter((item) => item === 'terminal_sample_drop_count');
  const nonBlockingFailures = failures.filter((item) => item !== 'terminal_sample_drop_count');
  return {
    blockingFailures,
    nonBlockingFailures,
  };
}

function runSelfCheck() {
  const v1Baseline = {
    schemaVersion: 'krita-tail-baseline-config-v1',
    build: { inputBackend: 'pointer' },
    cases: [{ id: 'case-a' }],
  };
  const v2Baseline = {
    schemaVersion: 'krita-tail-baseline-config-v2',
    backends: {
      windows_wintab: { cases: [{ id: 'case-a' }] },
      mac_native: { cases: [{ id: 'case-b' }] },
    },
  };
  const resolvedV1 = resolveBaselineBackends(v1Baseline);
  if (resolvedV1.length !== 1 || resolvedV1[0].backend !== 'windows_winink_pointer') {
    throw new Error('self-check failed: resolveBaselineBackends v1');
  }
  const resolvedV2 = resolveBaselineBackends(v2Baseline, 'mac_native');
  if (resolvedV2.length !== 1 || resolvedV2[0].backend !== 'mac_native') {
    throw new Error('self-check failed: resolveBaselineBackends v2');
  }

  const tempDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-krita-tail-gate-selfcheck-'));
  try {
    const v1ThresholdPath = path.join(tempDir, 'thresholds-v1.json');
    const v2ThresholdPath = path.join(tempDir, 'thresholds-v2.json');
    writeJson(v1ThresholdPath, {
      schemaVersion: 'krita-tail-thresholds-v1',
      metrics: { pressure_tail_mae: 0.2 },
    });
    writeJson(v2ThresholdPath, {
      schemaVersion: 'krita-tail-thresholds-v2',
      backends: {
        windows_wintab: { metrics: { pressure_tail_mae: 0.1 } },
      },
    });
    const storeV1 = loadGateThresholdsByBackend(v1ThresholdPath);
    const storeV2 = loadGateThresholdsByBackend(v2ThresholdPath);
    const t1 = resolveThresholdsForBackend(storeV1, 'mac_native');
    const t2 = resolveThresholdsForBackend(storeV2, 'windows_wintab');
    if (Math.abs(t1.pressure_tail_mae - 0.2) > 1e-9) {
      throw new Error('self-check failed: thresholds v1 fallback');
    }
    if (Math.abs(t2.pressure_tail_mae - 0.1) > 1e-9) {
      throw new Error('self-check failed: thresholds v2 backend');
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildStageDiffRows(sutuTrace, kritaTrace) {
  const rows = [];

  const sutuPressure = sutuTrace?.stages?.pressure_mapped ?? [];
  const kritaPressure = kritaTrace?.stages?.pressure_mapped ?? [];
  const kritaPressureBySeq = new Map(kritaPressure.map((sample) => [sample.seq, sample]));
  for (const sample of sutuPressure) {
    const other = kritaPressureBySeq.get(sample.seq);
    if (!other) continue;
    rows.push({
      stage: 'pressure_mapped',
      key: `seq:${sample.seq}`,
      metric: 'pressureAfterHeuristic',
      sutu: sample.pressureAfterHeuristic,
      krita: other.pressureAfterHeuristic,
      delta: sample.pressureAfterHeuristic - other.pressureAfterHeuristic,
      note: '',
    });
  }

  const sutuSampler = sutuTrace?.stages?.sampler_t ?? [];
  const kritaSampler = kritaTrace?.stages?.sampler_t ?? [];
  const kritaSamplerByKey = new Map(
    kritaSampler.map((sample) => [`${sample.segmentId}:${sample.sampleIndex}`, sample])
  );
  const kritaSamplerBySegment = new Map();
  for (const sample of kritaSampler) {
    const list = kritaSamplerBySegment.get(sample.segmentId) ?? [];
    list.push(sample);
    kritaSamplerBySegment.set(sample.segmentId, list);
  }
  const seenSamplerKeys = new Set();
  for (const sample of sutuSampler) {
    const key = `${sample.segmentId}:${sample.sampleIndex}`;
    let other = kritaSamplerByKey.get(key) ?? null;
    let note = '';
    if (!other) {
      const candidates = kritaSamplerBySegment.get(sample.segmentId) ?? [];
      let best = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const candidate of candidates) {
        const distance = Math.abs(candidate.t - sample.t);
        if (distance < bestDistance) {
          best = candidate;
          bestDistance = distance;
        }
      }
      if (best) {
        other = best;
        note = 'alignedByNearest=true';
      } else {
        note = 'missing_in_krita';
      }
    } else {
      seenSamplerKeys.add(key);
    }
    rows.push({
      stage: 'sampler_t',
      key,
      metric: 't',
      sutu: sample.t,
      krita: other?.t ?? 0,
      delta: sample.t - (other?.t ?? 0),
      note,
    });
  }
  for (const sample of kritaSampler) {
    const key = `${sample.segmentId}:${sample.sampleIndex}`;
    if (seenSamplerKeys.has(key)) continue;
    rows.push({
      stage: 'sampler_t',
      key,
      metric: 't',
      sutu: 0,
      krita: sample.t,
      delta: -sample.t,
      note: 'missing_in_sutu',
    });
  }

  const sutuDab = sutuTrace?.stages?.dab_emit ?? [];
  const kritaDab = kritaTrace?.stages?.dab_emit ?? [];
  const maxLen = Math.max(sutuDab.length, kritaDab.length);
  for (let i = 0; i < maxLen; i += 1) {
    const s = sutuDab[i] ?? null;
    const k = kritaDab[i] ?? null;
    const note = !s ? 'missing_in_sutu' : !k ? 'missing_in_krita' : '';
    rows.push({
      stage: 'dab_emit',
      key: `dabIndex:${i}`,
      metric: 'pressure',
      sutu: s?.pressure ?? 0,
      krita: k?.pressure ?? 0,
      delta: (s?.pressure ?? 0) - (k?.pressure ?? 0),
      note,
    });
    rows.push({
      stage: 'dab_emit',
      key: `dabIndex:${i}`,
      metric: 'spacingUsedPx',
      sutu: s?.spacingUsedPx ?? 0,
      krita: k?.spacingUsedPx ?? 0,
      delta: (s?.spacingUsedPx ?? 0) - (k?.spacingUsedPx ?? 0),
      note,
    });
  }

  return rows;
}

function rowsToCsv(rows) {
  const header = ['stage', 'key', 'metric', 'sutu', 'krita', 'delta', 'note'].join(',');
  const lines = rows.map((row) =>
    [
      row.stage,
      row.key,
      row.metric,
      Number(row.sutu).toFixed(6),
      Number(row.krita).toFixed(6),
      Number(row.delta).toFixed(6),
      row.note ?? '',
    ].join(',')
  );
  return [header, ...lines].join('\n');
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
  const result = await page.evaluate(
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

  return result;
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
      const report = await import('/src/test/kritaTailTrace/report.ts');
      const gateResult = compare.compareKritaTailTrace(sutuTrace, kritaTrace, thresholds);
      return {
        gateResult,
        summary: report.buildKritaTailReport(sutuTrace, gateResult),
      };
    },
    { sutuTrace, kritaTrace, thresholds }
  );
}

const cli = parseArgs(process.argv.slice(2));
if (cli['self-check'] === 'true' || cli['self-check'] === true) {
  runSelfCheck();
  console.log(JSON.stringify({ ok: true, script: 'gate-krita-tail' }, null, 2));
  process.exit(0);
}
const repoRoot = process.cwd();
const fixturesDir = path.resolve(repoRoot, cli.fixtures ?? DEFAULT_FIXTURES_DIR);
const baselineConfigPath = path.resolve(fixturesDir, cli.config ?? 'baseline-config.json');
const thresholdsPath = path.resolve(fixturesDir, cli.thresholds ?? 'thresholds.json');
const outputRoot = path.resolve(
  repoRoot,
  cli.output ?? `debug_output/krita-tail-gate/${new Date().toISOString().replace(/[:.]/g, '-')}`
);
const appUrl = normalizeUrl(cli.url ?? DEFAULT_URL);
const headless = cli.headless === undefined ? true : !(cli.headless === 'false' || cli.headless === '0');

if (!fs.existsSync(baselineConfigPath)) {
  throw new Error(`Missing baseline config: ${baselineConfigPath}`);
}

const baselineConfig = readJson(baselineConfigPath);
const thresholdStore = loadGateThresholdsByBackend(thresholdsPath);
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
  throw new Error('No backend selected for gate run');
}

ensureDir(outputRoot);

const browser = await chromium.launch({
  headless,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer'],
});

const summary = {
  schemaVersion: 'krita-tail-gate-run-v2',
  generatedAt: new Date().toISOString(),
  appUrl,
  baselineConfigPath: path.relative(repoRoot, baselineConfigPath).replace(/\\/g, '/'),
  thresholdsPath: path.relative(repoRoot, thresholdsPath).replace(/\\/g, '/'),
  thresholdSchemaVersion: thresholdStore.schemaVersion,
  backendOrder: backendRuns.map((item) => item.backend),
  backends: [],
  passed: true,
};

try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitForTraceApis(page);

  for (const backendRun of backendRuns) {
    const backend = backendRun.backend;
    const backendConfig = backendRun.config ?? {};
    const thresholds = resolveThresholdsForBackend(thresholdStore, backend);
    const allCases = Array.isArray(backendConfig.cases) ? backendConfig.cases : [];
    const selectedCases = caseFilter ? allCases.filter((item) => caseFilter.has(item.id)) : allCases;
    if (selectedCases.length === 0) {
      throw new Error(`No cases selected for backend "${backend}"`);
    }

    const backendOutputDir = path.join(outputRoot, backend);
    ensureDir(backendOutputDir);
    const backendSummary = {
      backend,
      mode: backend === 'windows_wintab' ? 'blocking' : 'warning_allowed',
      thresholds,
      cases: [],
      passed: true,
      rawPassed: true,
    };

    for (const caseConfig of selectedCases) {
      const caseOutputDir = path.join(backendOutputDir, caseConfig.id);
      ensureDir(caseOutputDir);

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
      const strokeId = `${backend}-${caseConfig.id}-${Date.now()}`;

      const traceRun = await runTraceCase(page, {
        capture,
        traceMeta,
        replaySpeed,
        waitMs,
        strokeId,
      });
      const sutuTrace = traceRun.trace;
      if (!sutuTrace) {
        throw new Error(`Trace export failed for case "${caseConfig.id}" backend "${backend}"`);
      }

      const sutuSchemaErrors = await validateTraceSchema(page, sutuTrace);
      const kritaSchemaErrors = await validateTraceSchema(page, kritaTrace);
      if (sutuSchemaErrors.length > 0) {
        throw new Error(
          `Sutu trace schema invalid for "${caseConfig.id}" backend "${backend}": ${sutuSchemaErrors.join('; ')}`
        );
      }
      if (kritaSchemaErrors.length > 0) {
        throw new Error(
          `Krita trace schema invalid for "${caseConfig.id}" backend "${backend}": ${kritaSchemaErrors.join('; ')}`
        );
      }

      const compared = await compareTrace(page, sutuTrace, kritaTrace, thresholds);
      const gateResult = compared.gateResult;
      const report = compared.summary;
      const stageRows = buildStageDiffRows(sutuTrace, kritaTrace);

      writeJson(path.join(caseOutputDir, 'trace.sutu.json'), sutuTrace);
      writeJson(path.join(caseOutputDir, 'trace.krita.json'), kritaTrace);
      writeJson(path.join(caseOutputDir, 'report.json'), report);
      fs.writeFileSync(path.join(caseOutputDir, 'stage_diff.csv'), `${rowsToCsv(stageRows)}\n`, 'utf8');
      await writeKritaTailChartPng({
        browser,
        sutuTrace,
        kritaTrace,
        caseId: `${backend}/${caseConfig.id}`,
        outputPath: path.join(caseOutputDir, 'tail_chart.png'),
      });

      const { blockingFailures, nonBlockingFailures } = splitFailuresByBackend(
        backend,
        gateResult.failures
      );
      const casePassed = blockingFailures.length === 0;
      const caseSummary = {
        caseId: caseConfig.id,
        backend,
        passed: casePassed,
        rawPassed: gateResult.passed,
        failures: blockingFailures,
        nonBlockingFailures,
        warnings: [...gateResult.warnings, ...(nonBlockingFailures.length > 0 ? nonBlockingFailures : [])],
        metrics: gateResult.metrics,
        outputDir: path.relative(repoRoot, caseOutputDir).replace(/\\/g, '/'),
      };
      backendSummary.cases.push(caseSummary);
      if (!casePassed) {
        backendSummary.passed = false;
      }
      if (!gateResult.passed) {
        backendSummary.rawPassed = false;
      }
    }

    summary.backends.push(backendSummary);
    if (!backendSummary.passed) {
      summary.passed = false;
    }
  }
} finally {
  await browser.close();
}

writeJson(path.join(outputRoot, 'summary.json'), summary);

console.log(JSON.stringify(summary, null, 2));
if (!summary.passed) {
  process.exitCode = 1;
}
