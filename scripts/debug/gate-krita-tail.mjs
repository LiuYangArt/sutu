#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { writeKritaTailChartPng } from './lib/krita-tail-chart.mjs';

const DEFAULT_URL = 'http://localhost:1420/';
const DEFAULT_FIXTURES_DIR = 'tests/fixtures/krita-tail';
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

function loadGateThresholds(filePath) {
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_THRESHOLD_FLOOR };
  }
  const parsed = readJson(filePath);
  if (parsed && typeof parsed === 'object' && parsed.metrics && typeof parsed.metrics === 'object') {
    return { ...DEFAULT_THRESHOLD_FLOOR, ...parsed.metrics };
  }
  return { ...DEFAULT_THRESHOLD_FLOOR, ...(parsed ?? {}) };
}

function buildTraceMeta(baseConfig, caseConfig) {
  return {
    caseId: caseConfig.id,
    canvas: {
      ...(baseConfig.canvas ?? { width: 0, height: 0, dpi: 72 }),
      ...(caseConfig.canvas ?? {}),
    },
    brushPreset: caseConfig.brushPreset ?? baseConfig.brushPreset ?? 'krita-tail-pressure-only',
    runtimeFlags: {
      ...(baseConfig.runtimeFlags ?? {}),
      ...(caseConfig.runtimeFlags ?? {}),
    },
    build: {
      ...(baseConfig.build ?? {}),
      ...(caseConfig.build ?? {}),
    },
  };
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
const thresholds = loadGateThresholds(thresholdsPath);
const allCases = Array.isArray(baselineConfig.cases) ? baselineConfig.cases : [];
const caseFilter = cli.case
  ? new Set(
      String(cli.case)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    )
  : null;
const selectedCases = caseFilter ? allCases.filter((item) => caseFilter.has(item.id)) : allCases;

if (selectedCases.length === 0) {
  throw new Error('No cases selected for gate run');
}

ensureDir(outputRoot);

const browser = await chromium.launch({
  headless,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer'],
});

const summary = {
  schemaVersion: 'krita-tail-gate-run-v1',
  generatedAt: new Date().toISOString(),
  appUrl,
  thresholdsPath: path.relative(repoRoot, thresholdsPath).replace(/\\/g, '/'),
  cases: [],
  passed: true,
};

try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitForTraceApis(page);

  for (const caseConfig of selectedCases) {
    const caseOutputDir = path.join(outputRoot, caseConfig.id);
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
    const traceMeta = buildTraceMeta(baselineConfig, caseConfig);
    const replaySpeed = toNumber(caseConfig.replaySpeed, toNumber(baselineConfig.defaultReplaySpeed, 1));
    const waitMs = Math.max(0, Math.floor(toNumber(caseConfig.waitMs, toNumber(baselineConfig.defaultWaitMs, 200))));
    const strokeId = `${caseConfig.id}-${Date.now()}`;

    const traceRun = await runTraceCase(page, {
      capture,
      traceMeta,
      replaySpeed,
      waitMs,
      strokeId,
    });
    const sutuTrace = traceRun.trace;
    if (!sutuTrace) {
      throw new Error(`Trace export failed for case "${caseConfig.id}"`);
    }

    const sutuSchemaErrors = await validateTraceSchema(page, sutuTrace);
    const kritaSchemaErrors = await validateTraceSchema(page, kritaTrace);
    if (sutuSchemaErrors.length > 0) {
      throw new Error(`Sutu trace schema invalid for "${caseConfig.id}": ${sutuSchemaErrors.join('; ')}`);
    }
    if (kritaSchemaErrors.length > 0) {
      throw new Error(`Krita trace schema invalid for "${caseConfig.id}": ${kritaSchemaErrors.join('; ')}`);
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
      caseId: caseConfig.id,
      outputPath: path.join(caseOutputDir, 'tail_chart.png'),
    });

    const caseSummary = {
      caseId: caseConfig.id,
      passed: gateResult.passed,
      failures: gateResult.failures,
      warnings: gateResult.warnings,
      metrics: gateResult.metrics,
      outputDir: path.relative(repoRoot, caseOutputDir).replace(/\\/g, '/'),
    };
    summary.cases.push(caseSummary);
    if (!gateResult.passed) {
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
