#!/usr/bin/env node
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:1420',
    capture: '',
    baseline: 'krita-5.2-default-wintab',
    threshold: 'krita-pressure-thresholds.v1',
    seed: '20260218',
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
    if (token === '--seed' && next) {
      args.seed = next;
      i += 1;
      continue;
    }
    if (token === '--help') {
      console.log(
        [
          'Usage: node scripts/pressure/run-gate.mjs [options]',
          '',
          'Options:',
          '  --url <url>            App URL (default: http://127.0.0.1:1420)',
          '  --capture <path>       Capture JSON path (optional)',
          '  --baseline <version>   Baseline version (default: krita-5.2-default-wintab)',
          '  --threshold <version>  Threshold version (default: krita-pressure-thresholds.v1)',
          '  --seed <number>        Reserved seed field (default: 20260218)',
        ].join('\n')
      );
      process.exit(0);
    }
  }

  return args;
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

    const runId = result?.run_meta?.run_id ?? `kp_${Date.now().toString(36)}`;
    const outputDir = path.join('artifacts', 'krita-pressure-full', runId);
    await fs.mkdir(outputDir, { recursive: true });

    await Promise.all([
      fs.writeFile(
        path.join(outputDir, 'stage_metrics.json'),
        JSON.stringify(result.stage_metrics ?? {}, null, 2),
        'utf-8'
      ),
      fs.writeFile(
        path.join(outputDir, 'final_metrics.json'),
        JSON.stringify(result.final_metrics ?? {}, null, 2),
        'utf-8'
      ),
      fs.writeFile(
        path.join(outputDir, 'fast_windows_metrics.json'),
        JSON.stringify(result.fast_windows_metrics ?? {}, null, 2),
        'utf-8'
      ),
      fs.writeFile(
        path.join(outputDir, 'case_results.json'),
        JSON.stringify(result.case_results ?? [], null, 2),
        'utf-8'
      ),
      fs.writeFile(
        path.join(outputDir, 'preset_results.json'),
        JSON.stringify(result.preset_results ?? [], null, 2),
        'utf-8'
      ),
      fs.writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(result, null, 2), 'utf-8'),
    ]);

    console.log(
      JSON.stringify(
        {
          overall: result.overall,
          run_id: runId,
          output_dir: outputDir,
          stage_gate: result.stage_gate,
          final_gate: result.final_gate,
          fast_gate: result.fast_gate,
          blocking_failures: result.blocking_failures,
        },
        null,
        2
      )
    );

    process.exit(result.overall === 'pass' ? 0 : 2);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('[run-gate] failed:', error);
  process.exit(1);
});
