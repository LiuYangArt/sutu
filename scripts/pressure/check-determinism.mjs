#!/usr/bin/env node
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:1420',
    capture: '',
    baseline: 'krita-5.2-default-wintab',
    threshold: 'krita-pressure-thresholds.v1',
    runs: 10,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--url' && next) {
      args.url = next;
      i += 1;
      continue;
    }
    if (token === '--capture' && next) {
      args.capture = next;
      i += 1;
      continue;
    }
    if (token === '--baseline' && next) {
      args.baseline = next;
      i += 1;
      continue;
    }
    if (token === '--threshold' && next) {
      args.threshold = next;
      i += 1;
      continue;
    }
    if (token === '--runs' && next) {
      const runs = Number.parseInt(next, 10);
      if (Number.isFinite(runs) && runs > 0) {
        args.runs = runs;
      }
      i += 1;
      continue;
    }
    if (token === '--help') {
      console.log(
        [
          'Usage: node scripts/pressure/check-determinism.mjs [options]',
          '',
          'Options:',
          '  --url <url>            App URL (default: http://127.0.0.1:1420)',
          '  --capture <path>       Capture JSON path (optional)',
          '  --baseline <version>   Baseline version (default: krita-5.2-default-wintab)',
          '  --threshold <version>  Threshold version (default: krita-pressure-thresholds.v1)',
          '  --runs <n>             Run count (default: 10)',
        ].join('\n')
      );
      process.exit(0);
    }
  }

  return args;
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys
    .filter((key) => key !== 'run_id' && key !== 'created_at')
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
  return `{${parts.join(',')}}`;
}

function summarize(result) {
  return {
    overall: result.overall,
    stage_gate: result.stage_gate,
    final_gate: result.final_gate,
    fast_gate: result.fast_gate,
    input_hash: result.input_hash,
    baseline_version: result.baseline_version,
    threshold_version: result.threshold_version,
    stage_metrics: result.stage_metrics,
    final_metrics: result.final_metrics,
    fast_windows_metrics: result.fast_windows_metrics,
    semantic_checks: result.semantic_checks,
    blocking_failures: result.blocking_failures,
    case_results: result.case_results,
    preset_results: result.preset_results,
    summary: result.summary,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  let captureInput = null;
  if (args.capture) {
    const raw = await fs.readFile(args.capture, 'utf-8');
    captureInput = JSON.parse(raw);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => typeof window.__kritaPressureFullGate === 'function', null, {
      timeout: 60_000,
    });

    const hashes = [];
    for (let i = 0; i < args.runs; i += 1) {
      const result = await page.evaluate(async ({ capture, baseline, threshold }) => {
        const modeSet = window.__kritaPressurePipelineModeSet;
        if (typeof modeSet === 'function') {
          modeSet({
            pressurePipelineV2Primary: true,
            pressurePipelineV2Shadow: false,
          });
        }
        const fn = window.__kritaPressureFullGate;
        if (typeof fn !== 'function') {
          throw new Error('window.__kritaPressureFullGate is not available');
        }
        return fn({
          capture,
          baselineVersion: baseline,
          thresholdVersion: threshold,
        });
      }, {
        capture: captureInput,
        baseline: args.baseline,
        threshold: args.threshold,
      });

      const normalized = summarize(result);
      const canonical = canonicalize(normalized);
      const hash = crypto.createHash('sha256').update(canonical).digest('hex');
      hashes.push(hash);
    }

    const first = hashes[0];
    const allEqual = hashes.every((hash) => hash === first);

    console.log(
      JSON.stringify(
        {
          runs: args.runs,
          stable: allEqual,
          hash: first,
          hashes,
        },
        null,
        2
      )
    );

    process.exit(allEqual ? 0 : 2);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('[check-determinism] failed:', error);
  process.exit(1);
});
