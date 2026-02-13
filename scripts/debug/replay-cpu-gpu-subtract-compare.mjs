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

function safeName(text) {
  return String(text).replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stripDataUrlPrefix(dataUrl) {
  const i = dataUrl.indexOf(',');
  if (i < 0) throw new Error('Invalid data URL');
  return dataUrl.slice(i + 1);
}

function writePngDataUrl(dataUrl, outputPath) {
  const base64 = stripDataUrlPrefix(dataUrl);
  fs.writeFileSync(outputPath, Buffer.from(base64, 'base64'));
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
  cli.output ?? 'debug_output/texture_formula_compare/cpu_gpu_subtract_compare'
);
const waitMs = Math.max(0, Math.floor(toNumber(cli['wait-ms'], 300)));
const replaySpeed = Math.max(0.05, toNumber(cli.speed, 1));
const headless = toBoolean(cli.headless, false);
const patternId = cli['pattern-id'] ?? '__debug_subtract_pattern__';
const label = safeName(cli.label ?? 'cpu-gpu-subtract');
const depth = Math.max(0, Math.min(100, toNumber(cli.depth, 100)));
const scale = Math.max(1, toNumber(cli.scale, 100));
const brightness = Math.max(-255, Math.min(255, toNumber(cli.brightness, 0)));
const contrast = Math.max(-100, Math.min(100, toNumber(cli.contrast, 0)));
const invert = toBoolean(cli.invert, true);
const textureMode = cli.mode ?? 'subtract';
const replaySeed = Math.max(1, Math.floor(toNumber(cli.seed, 424242)));

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
      depth,
      scale,
      brightness,
      contrast,
      invert,
      textureMode,
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
        return { width: c.width, height: c.height };
      };

      const patternInfo = await loadPatternFromImage();

      const patchedCapture = JSON.parse(JSON.stringify(capture));
      const tool = patchedCapture?.metadata?.tool ?? {};
      patchedCapture.metadata.tool = {
        ...tool,
        currentTool: 'brush',
        textureEnabled: true,
        textureSettings: {
          ...(tool.textureSettings ?? {}),
          patternId,
          mode: textureMode,
          depth,
          scale,
          brightness,
          contrast,
          invert,
        },
      };

      const setRenderMode = useSettingsStore.getState().setRenderMode;
      const getRenderMode = () => useSettingsStore.getState().brush.renderMode;
      const originalMode = getRenderMode();

      const runOne = async (mode) => {
        setRenderMode(mode);
        await waitRaf();
        await waitRaf();

        const replayAndSettle = async (seed) => {
          window.__canvasClearLayer();
          await waitRaf();
          await waitRaf();
          const rr = await withSeededRandom(seed, async () =>
            window.__strokeCaptureReplay(patchedCapture, { speed: replaySpeed })
          );
          if (!rr) throw new Error(`Replay failed in mode=${mode}`);
          await wait(waitMs);
          await waitRaf();
          await waitRaf();
          return rr;
        };

        if (mode === 'gpu') {
          // Warm up GPU stroke pipeline: first replay after mode switch can miss leading stroke.
          await replayAndSettle(replaySeed);
          window.__canvasClearLayer();
          await waitRaf();
          await waitRaf();
        }

        const replayResult = await replayAndSettle(replaySeed);

        const flattened = await window.__getFlattenedImage();
        if (!flattened) throw new Error(`Flattened export failed in mode=${mode}`);
        return { dataUrl: flattened, replayResult };
      };

      const gpu = await runOne('gpu');
      const cpu = await runOne('cpu');
      setRenderMode(originalMode);
      await waitRaf();

      const compare = async (aUrl, bUrl) => {
        const load = async (url) => {
          const img = new Image();
          img.src = url;
          await img.decode();
          return img;
        };
        const a = await load(aUrl);
        const b = await load(bUrl);
        const w = Math.min(a.width, b.width);
        const h = Math.min(a.height, b.height);
        const ca = document.createElement('canvas');
        const cb = document.createElement('canvas');
        const cd = document.createElement('canvas');
        ca.width = cb.width = cd.width = w;
        ca.height = cb.height = cd.height = h;
        const cta = ca.getContext('2d', { willReadFrequently: true });
        const ctb = cb.getContext('2d', { willReadFrequently: true });
        const ctd = cd.getContext('2d');
        if (!cta || !ctb || !ctd) throw new Error('Failed to create compare canvas');
        cta.drawImage(a, 0, 0, w, h);
        ctb.drawImage(b, 0, 0, w, h);
        const da = cta.getImageData(0, 0, w, h).data;
        const db = ctb.getImageData(0, 0, w, h).data;
        const out = ctd.createImageData(w, h);

        let sumAbs = 0;
        let maxDiff = 0;
        let mismatch = 0;
        const threshold = 4;
        const pixels = w * h;
        for (let i = 0; i < pixels; i += 1) {
          const o = i * 4;
          const dr = Math.abs((da[o] ?? 0) - (db[o] ?? 0));
          const dg = Math.abs((da[o + 1] ?? 0) - (db[o + 1] ?? 0));
          const dbb = Math.abs((da[o + 2] ?? 0) - (db[o + 2] ?? 0));
          const daA = Math.abs((da[o + 3] ?? 0) - (db[o + 3] ?? 0));
          const d = Math.max(dr, dg, dbb, daA);
          sumAbs += dr + dg + dbb + daA;
          if (d > maxDiff) maxDiff = d;
          if (d > threshold) mismatch += 1;
          out.data[o] = d;
          out.data[o + 1] = d;
          out.data[o + 2] = d;
          out.data[o + 3] = 255;
        }
        ctd.putImageData(out, 0, 0);
        return {
          width: w,
          height: h,
          meanAbsDiff: sumAbs / (pixels * 4),
          maxDiff,
          mismatchRatio: (mismatch / pixels) * 100,
          diffDataUrl: cd.toDataURL('image/png'),
        };
      };

      const diff = await compare(cpu.dataUrl, gpu.dataUrl);

      return {
        originalMode,
        patternInfo,
        patchedTextureSettings: patchedCapture.metadata.tool.textureSettings,
        replay: { cpu: cpu.replayResult, gpu: gpu.replayResult },
        cpuDataUrl: cpu.dataUrl,
        gpuDataUrl: gpu.dataUrl,
        diff,
      };
    },
    {
      capture,
      textureUrl,
      patternId,
      waitMs,
      replaySpeed,
      depth,
      scale,
      brightness,
      contrast,
      invert,
      textureMode,
      replaySeed,
    }
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `${stamp}-${label}`;
  const cpuPath = path.join(outputDir, `${baseName}-cpu.png`);
  const gpuPath = path.join(outputDir, `${baseName}-gpu.png`);
  const diffPath = path.join(outputDir, `${baseName}-diff.png`);
  const reportPath = path.join(outputDir, `${baseName}-report.json`);

  writePngDataUrl(result.cpuDataUrl, cpuPath);
  writePngDataUrl(result.gpuDataUrl, gpuPath);
  writePngDataUrl(result.diff.diffDataUrl, diffPath);

  const report = {
    appUrl,
    capturePath,
    texturePath,
    textureUrl,
    patternId,
    outputDir,
    originalMode: result.originalMode,
    patchedTextureSettings: result.patchedTextureSettings,
    patternInfo: result.patternInfo,
    replay: result.replay,
    replaySeed,
    metrics: {
      meanAbsDiff: result.diff.meanAbsDiff,
      maxDiff: result.diff.maxDiff,
      mismatchRatio: result.diff.mismatchRatio,
      width: result.diff.width,
      height: result.diff.height,
    },
    files: {
      cpu: cpuPath,
      gpu: gpuPath,
      diff: diffPath,
    },
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`[CpuGpuSubtractCompare] cpu:    ${cpuPath}`);
  console.log(`[CpuGpuSubtractCompare] gpu:    ${gpuPath}`);
  console.log(`[CpuGpuSubtractCompare] diff:   ${diffPath}`);
  console.log(`[CpuGpuSubtractCompare] report: ${reportPath}`);
  console.log(
    `[CpuGpuSubtractCompare] pattern=${result.patternInfo.width}x${
      result.patternInfo.height
    } meanAbsDiff=${report.metrics.meanAbsDiff.toFixed(4)} maxDiff=${report.metrics.maxDiff} mismatchRatio=${report.metrics.mismatchRatio.toFixed(4)}%`
  );
} finally {
  await browser.close();
}
