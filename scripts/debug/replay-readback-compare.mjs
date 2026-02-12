#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
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

function toPosix(filePath) {
  return filePath.replace(/\\/g, '/');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stripDataUrlPrefix(dataUrl) {
  const i = dataUrl.indexOf(',');
  if (i < 0) {
    throw new Error('Invalid data URL');
  }
  return dataUrl.slice(i + 1);
}

function writePngDataUrl(dataUrl, outputPath) {
  const base64 = stripDataUrlPrefix(dataUrl);
  const bytes = Buffer.from(base64, 'base64');
  fs.writeFileSync(outputPath, bytes);
}

function resolveDefaultCapturePath() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return path.join(appData, 'com.paintboard', 'debug-data', 'debug-stroke-capture.json');
}

function loadCaptureFromFile(capturePath) {
  const text = fs.readFileSync(capturePath, 'utf8');
  return JSON.parse(text);
}

function safeName(text) {
  return text.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

const cli = parseArgs(process.argv.slice(2));
const repoRoot = process.cwd();
const defaultOutDir = path.resolve(repoRoot, 'debug_output', 'replay_readback_compare');
const outputDir = path.resolve(repoRoot, cli.output ?? defaultOutDir);
const appUrl = cli.url ?? 'http://127.0.0.1:1420';
const waitMs = Math.max(0, Math.floor(toNumber(cli['wait-ms'], 300)));
const replaySpeed = Math.max(0.05, toNumber(cli.speed, 1));
const label = safeName(cli.label ?? 'readback-compare');
const capturePathArg = cli.capture ? path.resolve(repoRoot, cli.capture) : null;
const capturePath = capturePathArg ?? resolveDefaultCapturePath();

let captureFromFile = null;
if (capturePath && fs.existsSync(capturePath)) {
  captureFromFile = loadCaptureFromFile(capturePath);
}

ensureDir(outputDir);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });

  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

  await page.waitForFunction(
    () =>
      typeof window.__strokeCaptureReplay === 'function' &&
      typeof window.__canvasClearLayer === 'function' &&
      typeof window.__getFlattenedImage === 'function' &&
      typeof window.__gpuBrushCommitReadbackMode === 'function' &&
      typeof window.__gpuBrushCommitReadbackModeSet === 'function',
    undefined,
    { timeout: 120000 }
  );

  const runResult = await page.evaluate(
    async ({ captureFromFile, waitMs, replaySpeed }) => {
      const waitRaf = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      const loadCapture = async () => {
        if (captureFromFile) return captureFromFile;
        if (typeof window.__strokeCaptureLoadFixed === 'function') {
          const fixed = await window.__strokeCaptureLoadFixed();
          if (fixed?.capture) return fixed.capture;
        }
        return null;
      };

      const capture = await loadCapture();
      if (!capture) {
        throw new Error(
          'No capture available. Provide --capture or save fixed capture in Debug Panel.'
        );
      }

      const getMode = window.__gpuBrushCommitReadbackMode;
      const setMode = window.__gpuBrushCommitReadbackModeSet;
      const clearLayer = window.__canvasClearLayer;
      const replay = window.__strokeCaptureReplay;
      const exportFlattened = window.__getFlattenedImage;

      const originalMode = getMode();
      const runOne = async (mode) => {
        const ok = setMode(mode);
        const actualMode = getMode();
        if (!ok || actualMode !== mode) {
          throw new Error(`Failed to set readback mode: expected=${mode}, actual=${actualMode}`);
        }

        clearLayer();
        await waitRaf();
        await waitRaf();
        const replayResult = await replay(capture, { speed: replaySpeed });
        if (!replayResult) {
          throw new Error(`Replay failed in mode=${mode}`);
        }

        await wait(waitMs);
        await waitRaf();
        await waitRaf();

        const flattened = await exportFlattened();
        if (!flattened) {
          throw new Error(`Flattened image export failed in mode=${mode}`);
        }
        return { dataUrl: flattened, replayResult };
      };

      const enabled = await runOne('enabled');
      const disabled = await runOne('disabled');

      setMode(originalMode);

      const calcDiff = async (aUrl, bUrl) => {
        const load = async (url) => {
          const img = new Image();
          img.src = url;
          await img.decode();
          return img;
        };

        const imgA = await load(aUrl);
        const imgB = await load(bUrl);
        const w = Math.min(imgA.width, imgB.width);
        const h = Math.min(imgA.height, imgB.height);
        const cA = document.createElement('canvas');
        cA.width = w;
        cA.height = h;
        const cB = document.createElement('canvas');
        cB.width = w;
        cB.height = h;
        const cD = document.createElement('canvas');
        cD.width = w;
        cD.height = h;
        const ctxA = cA.getContext('2d', { willReadFrequently: true });
        const ctxB = cB.getContext('2d', { willReadFrequently: true });
        const ctxD = cD.getContext('2d');
        if (!ctxA || !ctxB || !ctxD) {
          throw new Error('Failed to create 2D context');
        }

        ctxA.drawImage(imgA, 0, 0, w, h);
        ctxB.drawImage(imgB, 0, 0, w, h);
        const dataA = ctxA.getImageData(0, 0, w, h).data;
        const dataB = ctxB.getImageData(0, 0, w, h).data;
        const out = ctxD.createImageData(w, h);

        let sumAbs = 0;
        let maxDiff = 0;
        let mismatch = 0;
        const threshold = 4;
        const pixels = w * h;
        for (let i = 0; i < pixels; i += 1) {
          const o = i * 4;
          const dr = Math.abs((dataA[o] ?? 0) - (dataB[o] ?? 0));
          const dg = Math.abs((dataA[o + 1] ?? 0) - (dataB[o + 1] ?? 0));
          const db = Math.abs((dataA[o + 2] ?? 0) - (dataB[o + 2] ?? 0));
          const da = Math.abs((dataA[o + 3] ?? 0) - (dataB[o + 3] ?? 0));
          const d = Math.max(dr, dg, db, da);
          sumAbs += dr + dg + db + da;
          if (d > maxDiff) maxDiff = d;
          if (d > threshold) mismatch += 1;

          out.data[o] = d;
          out.data[o + 1] = d;
          out.data[o + 2] = d;
          out.data[o + 3] = 255;
        }
        ctxD.putImageData(out, 0, 0);
        return {
          width: w,
          height: h,
          meanAbsDiff: sumAbs / (pixels * 4),
          maxDiff,
          mismatchRatio: (mismatch / pixels) * 100,
          diffDataUrl: cD.toDataURL('image/png'),
        };
      };

      const diff = await calcDiff(enabled.dataUrl, disabled.dataUrl);
      return {
        originalMode,
        enabled,
        disabled,
        diff,
      };
    },
    { captureFromFile, waitMs, replaySpeed }
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `${stamp}-${label}`;
  const enabledPath = path.join(outputDir, `${baseName}-enabled.png`);
  const disabledPath = path.join(outputDir, `${baseName}-disabled.png`);
  const diffPath = path.join(outputDir, `${baseName}-diff.png`);
  const reportPath = path.join(outputDir, `${baseName}-report.json`);

  writePngDataUrl(runResult.enabled.dataUrl, enabledPath);
  writePngDataUrl(runResult.disabled.dataUrl, disabledPath);
  writePngDataUrl(runResult.diff.diffDataUrl, diffPath);

  const report = {
    appUrl,
    capturePath: capturePath ? toPosix(capturePath) : null,
    outputDir: toPosix(outputDir),
    originalMode: runResult.originalMode,
    replay: {
      enabled: runResult.enabled.replayResult,
      disabled: runResult.disabled.replayResult,
      waitMs,
      speed: replaySpeed,
    },
    metrics: {
      meanAbsDiff: runResult.diff.meanAbsDiff,
      maxDiff: runResult.diff.maxDiff,
      mismatchRatio: runResult.diff.mismatchRatio,
      width: runResult.diff.width,
      height: runResult.diff.height,
    },
    files: {
      enabled: toPosix(enabledPath),
      disabled: toPosix(disabledPath),
      diff: toPosix(diffPath),
    },
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`[ReplayCompare] enabled:  ${enabledPath}`);
  console.log(`[ReplayCompare] disabled: ${disabledPath}`);
  console.log(`[ReplayCompare] diff:     ${diffPath}`);
  console.log(`[ReplayCompare] report:   ${reportPath}`);
  console.log(
    `[ReplayCompare] meanAbsDiff=${report.metrics.meanAbsDiff.toFixed(4)} maxDiff=${
      report.metrics.maxDiff
    } mismatchRatio=${report.metrics.mismatchRatio.toFixed(4)}%`
  );
} finally {
  await browser.close();
}
