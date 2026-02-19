#!/usr/bin/env node
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:1420',
    capture: '',
    runs: 100,
    speed: 1,
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
    if (token === '--runs' && next) {
      const runs = Number.parseInt(next, 10);
      if (Number.isFinite(runs) && runs > 0) {
        args.runs = runs;
      }
      i += 1;
      continue;
    }
    if (token === '--speed' && next) {
      const speed = Number.parseFloat(next);
      if (Number.isFinite(speed) && speed > 0) {
        args.speed = speed;
      }
      i += 1;
      continue;
    }
    if (token === '--help') {
      console.log(
        [
          'Usage: node scripts/pressure/run-shadow-stability.mjs [options]',
          '',
          'Options:',
          '  --url <url>       App URL (default: http://127.0.0.1:1420)',
          '  --capture <path>  Capture JSON path (optional; fallback to fixed capture)',
          '  --runs <n>        Replay count (default: 100)',
          '  --speed <x>       Replay speed multiplier (default: 1)',
        ].join('\n')
      );
      process.exit(0);
    }
  }

  return args;
}

async function waitTwoFrames(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
}

async function main() {
  const args = parseArgs(process.argv);
  let captureInput = null;
  if (args.capture) {
    const raw = await fs.readFile(args.capture, 'utf-8');
    captureInput = JSON.parse(raw);
  }

  const browser = await chromium.launch({ headless: true });
  const runId = `kp_shadow_${Date.now().toString(36)}`;
  try {
    const page = await browser.newPage();
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    await page.waitForFunction(() => typeof window.__strokeCaptureReplay === 'function', null, {
      timeout: 60_000,
    });
    await page.waitForFunction(
      () =>
        typeof window.__kritaPressurePipelineModeSet === 'function' &&
        typeof window.__kritaPressureShadowDiffGet === 'function' &&
        typeof window.__kritaPressureShadowDiffReset === 'function',
      null,
      { timeout: 60_000 }
    );

    const result = await page.evaluate(async ({ capture, runs, speed }) => {
      const modeSet = window.__kritaPressurePipelineModeSet;
      const shadowReset = window.__kritaPressureShadowDiffReset;
      const shadowGet = window.__kritaPressureShadowDiffGet;
      const replay = window.__strokeCaptureReplay;
      const clearLayer = window.__canvasClearLayer;
      const loadFixed = window.__strokeCaptureLoadFixed;
      if (
        typeof modeSet !== 'function' ||
        typeof shadowReset !== 'function' ||
        typeof shadowGet !== 'function' ||
        typeof replay !== 'function'
      ) {
        throw new Error('Missing shadow runtime APIs');
      }

      let resolvedCapture = capture;
      if (!resolvedCapture && typeof loadFixed === 'function') {
        const fixed = await loadFixed();
        resolvedCapture = fixed?.capture ?? null;
      }
      if (!resolvedCapture) {
        throw new Error('Missing capture for shadow stability run');
      }

      modeSet({
        pressurePipelineV2Primary: true,
        pressurePipelineV2Shadow: true,
        stageDiffLogEnabled: true,
        maxRecentEntries: 400,
      });
      shadowReset();

      const errors = [];
      let replayed = 0;

      for (let i = 0; i < runs; i += 1) {
        try {
          if (typeof clearLayer === 'function') {
            clearLayer();
          }
          const replayResult = await replay(resolvedCapture, { speed });
          if (!replayResult) {
            throw new Error('Replay returned null');
          }
          replayed += 1;
        } catch (error) {
          errors.push(`run_${i + 1}: ${String(error)}`);
        }
      }

      const snapshot = shadowGet({ recentLimit: 200 });
      modeSet({
        pressurePipelineV2Primary: true,
        pressurePipelineV2Shadow: false,
      });

      return {
        replayed,
        runs,
        speed,
        errors,
        shadow_snapshot: snapshot,
      };
    }, {
      capture: captureInput,
      runs: args.runs,
      speed: args.speed,
    });

    await waitTwoFrames(page);

    const outputDir = path.join('artifacts', 'krita-pressure-full', runId);
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'shadow_stability.json');
    const passed = result.errors.length === 0 && (result.shadow_snapshot?.total_samples ?? 0) > 0;
    const payload = {
      run_id: runId,
      passed,
      ...result,
    };
    await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf-8');

    console.log(
      JSON.stringify(
        {
          run_id: runId,
          passed,
          output_path: outputPath,
          replayed: result.replayed,
          runs: result.runs,
          error_count: result.errors.length,
          total_samples: result.shadow_snapshot?.total_samples ?? 0,
        },
        null,
        2
      )
    );

    process.exit(passed ? 0 : 2);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('[run-shadow-stability] failed:', error);
  process.exit(1);
});
