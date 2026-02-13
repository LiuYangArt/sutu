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

function toBoolean(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return fallback;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resolveDefaultCapturePath() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return path.join(appData, 'com.sutu', 'debug-data', 'debug-stroke-capture.json');
}

const cli = parseArgs(process.argv.slice(2));
const repoRoot = process.cwd();
const appUrl = cli.url ?? 'http://localhost:1420';
const capturePath = path.resolve(
  repoRoot,
  cli.capture ?? resolveDefaultCapturePath() ?? 'debug-stroke-capture.json'
);
const texturePath = path.resolve(
  repoRoot,
  cli.texture ?? 'debug_output/pat_decoded/pat5_sparthtex01.png'
);
const outputDir = path.resolve(
  repoRoot,
  cli.output ?? 'debug_output/texture_formula_compare/eachtip_off_nonempty_regression'
);
const waitMs = Math.max(0, Math.floor(toNumber(cli['wait-ms'], 300)));
const replaySpeed = Math.max(0.05, toNumber(cli.speed, 1));
const headless = toBoolean(cli.headless, true);
const replaySeed = Math.max(1, Math.floor(toNumber(cli.seed, 424242)));
const minNonZeroPixels = Math.max(1, Math.floor(toNumber(cli['min-nonzero-pixels'], 200)));
const minAlphaSum = Math.max(1, Math.floor(toNumber(cli['min-alpha-sum'], 5000)));
const patternId = cli['pattern-id'] ?? '__debug_eachtip_off_nonempty_pattern__';

if (!fs.existsSync(capturePath)) {
  throw new Error(`Capture not found: ${capturePath}`);
}
if (!fs.existsSync(texturePath)) {
  throw new Error(`Texture not found: ${texturePath}`);
}

const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
const textureRel = path.relative(repoRoot, texturePath).replace(/\\/g, '/');
if (textureRel.startsWith('..')) {
  throw new Error(`Texture must be inside repo root for dev-server access: ${texturePath}`);
}
const textureUrl = `${appUrl.replace(/\/+$/, '')}/${textureRel}`;

ensureDir(outputDir);

const browser = await chromium.launch({
  headless,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

  await page.waitForFunction(
    () =>
      typeof window.__strokeCaptureReplay === 'function' &&
      typeof window.__canvasClearLayer === 'function' &&
      typeof window.__getFlattenedImage === 'function',
    undefined,
    { timeout: 120000 }
  );

  const result = await page.evaluate(
    async ({
      capture,
      textureUrl,
      patternId,
      waitMs,
      replaySpeed,
      replaySeed,
    }) => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitRaf = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const createSeededRandom = (seed) => {
        let t = seed >>> 0;
        return () => {
          t += 0x6d2b79f5;
          let x = t;
          x = Math.imul(x ^ (x >>> 15), x | 1);
          x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
          return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
        };
      };
      const withSeededRandom = async (seed, task) => {
        const mathObject = Math;
        const originalRandom = mathObject.random;
        mathObject.random = createSeededRandom(seed);
        try {
          return await task();
        } finally {
          mathObject.random = originalRandom;
        }
      };

      const settingsMod = await import('/src/stores/settings.ts');
      const patternMod = await import('/src/utils/patternManager.ts');
      const useSettingsStore = settingsMod.useSettingsStore;
      const patternManager = patternMod.patternManager;

      const loadPatternFromImage = async () => {
        const img = new Image();
        img.src = textureUrl;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Failed to create canvas for pattern');
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, c.width, c.height).data;
        const bytes = new Uint8Array(imageData.buffer.slice(0));
        patternManager.registerPattern({
          id: patternId,
          width: c.width,
          height: c.height,
          data: bytes,
        });
      };

      await loadPatternFromImage();

      const patchedCapture = JSON.parse(JSON.stringify(capture));
      const tool = patchedCapture?.metadata?.tool ?? {};
      patchedCapture.metadata.tool = {
        ...tool,
        currentTool: 'brush',
        textureEnabled: true,
        dualBrushEnabled: false,
        textureSettings: {
          ...(tool.textureSettings ?? {}),
          patternId,
          textureEachTip: false,
        },
      };

      const setRenderMode = useSettingsStore.getState().setRenderMode;
      const getRenderMode = () => useSettingsStore.getState().brush.renderMode;
      const originalMode = getRenderMode();

      setRenderMode('gpu');
      await waitRaf();
      await waitRaf();

      window.__canvasClearLayer();
      await waitRaf();
      await waitRaf();
      const replayResult = await withSeededRandom(replaySeed, async () =>
        window.__strokeCaptureReplay(patchedCapture, { speed: replaySpeed })
      );
      if (!replayResult) throw new Error('Replay failed in GPU mode');
      await wait(waitMs);
      await waitRaf();
      await waitRaf();

      const flattened = await window.__getFlattenedImage();
      if (!flattened) throw new Error('Flattened export failed in GPU mode');

      const img = new Image();
      img.src = flattened;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Failed to create canvas for alpha stats');
      ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, c.width, c.height).data;

      let nonZeroAlphaPixels = 0;
      let alphaSum = 0;
      for (let i = 3; i < pixels.length; i += 4) {
        const a = pixels[i] ?? 0;
        alphaSum += a;
        if (a > 0) nonZeroAlphaPixels += 1;
      }

      setRenderMode(originalMode);
      await waitRaf();

      return {
        replayResult,
        width: c.width,
        height: c.height,
        nonZeroAlphaPixels,
        alphaSum,
      };
    },
    {
      capture,
      textureUrl,
      patternId,
      waitMs,
      replaySpeed,
      replaySeed,
    }
  );

  const report = {
    at: new Date().toISOString(),
    appUrl,
    capturePath,
    texturePath,
    replaySeed,
    waitMs,
    replaySpeed,
    minNonZeroPixels,
    minAlphaSum,
    result,
  };

  const reportPath = path.join(
    outputDir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-eachtip-off-nonempty-report.json`
  );
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  if (result.nonZeroAlphaPixels < minNonZeroPixels || result.alphaSum < minAlphaSum) {
    throw new Error(
      `Regression detected: nonZeroAlphaPixels=${result.nonZeroAlphaPixels}, alphaSum=${result.alphaSum}, report=${reportPath}`
    );
  }

  console.log('[OK] GPU EachTipOff non-empty regression check passed');
  console.log(`report: ${reportPath}`);
} finally {
  await browser.close();
}
