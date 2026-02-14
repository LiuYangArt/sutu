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
  cli.output ?? 'debug_output/texture_formula_compare/eachtip_compare'
);
const waitMs = Math.max(0, Math.floor(toNumber(cli['wait-ms'], 300)));
const replaySpeed = Math.max(0.05, toNumber(cli.speed, 1));
const headless = toBoolean(cli.headless, false);
const renderMode = cli['render-mode'] === 'cpu' ? 'cpu' : 'gpu';
const label = safeName(cli.label ?? `texture-eachtip-${renderMode}`);
const patternId = cli['pattern-id'] ?? '__debug_texture_eachtip_pattern__';
const textureMode = cli.mode ?? 'subtract';
const depth = Math.max(0, Math.min(100, toNumber(cli.depth, 100)));
const scale = Math.max(1, toNumber(cli.scale, 100));
const brightness = Math.max(-255, Math.min(255, toNumber(cli.brightness, 0)));
const contrast = Math.max(-100, Math.min(100, toNumber(cli.contrast, 0)));
const invert = toBoolean(cli.invert, true);
const depthControl = Math.max(0, Math.floor(toNumber(cli['depth-control'], 0)));
const minimumDepth = Math.max(0, Math.min(100, toNumber(cli['minimum-depth'], 0)));
const depthJitter = Math.max(0, Math.min(100, toNumber(cli['depth-jitter'], 35)));
const replaySeed = Math.max(1, Math.floor(toNumber(cli.seed, 424242)));
const mismatchThreshold = Math.max(0, Math.min(255, toNumber(cli['diff-threshold'], 4)));

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
      renderMode,
      textureMode,
      depth,
      scale,
      brightness,
      contrast,
      invert,
      depthControl,
      minimumDepth,
      depthJitter,
      replaySeed,
      mismatchThreshold,
    }) => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitRaf = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const deepClone = (value) => JSON.parse(JSON.stringify(value));
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

      const toAlphaStats = async (dataUrl) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Failed to create alpha-stat canvas');
        ctx.drawImage(img, 0, 0);
        const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
        let nonZeroAlphaPixels = 0;
        let alphaSum = 0;
        for (let i = 3; i < pixels.length; i += 4) {
          const a = pixels[i] ?? 0;
          alphaSum += a;
          if (a > 0) nonZeroAlphaPixels += 1;
        }
        return {
          width: c.width,
          height: c.height,
          nonZeroAlphaPixels,
          alphaSum,
        };
      };

      const compare = async (aUrl, bUrl, threshold) => {
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

      const buildPanel = async (items) => {
        if (items.length !== 3) throw new Error('Expected exactly 3 scenario items');
        const images = [];
        for (const item of items) {
          const img = new Image();
          img.src = item.dataUrl;
          await img.decode();
          images.push(img);
        }
        const maxWidth = Math.max(...images.map((img) => img.width));
        const maxHeight = Math.max(...images.map((img) => img.height));
        const header = 64;
        const gap = 24;
        const padding = 24;
        const width = padding * 2 + maxWidth * 3 + gap * 2;
        const height = padding * 2 + header + maxHeight;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Failed to create panel canvas');
        ctx.fillStyle = '#0b0b0d';
        ctx.fillRect(0, 0, width, height);
        ctx.font = 'bold 28px sans-serif';
        ctx.fillStyle = '#e6e6e6';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < 3; i += 1) {
          const x = padding + i * (maxWidth + gap);
          const y = padding + header;
          ctx.drawImage(images[i], x, y, maxWidth, maxHeight);
          ctx.fillText(items[i].name, x + maxWidth / 2, padding + header / 2);
        }
        return canvas.toDataURL('image/png');
      };

      const patternInfo = await loadPatternFromImage();

      const runScenario = async (scenario) => {
        const patchedCapture = deepClone(capture);
        const tool = patchedCapture?.metadata?.tool ?? {};
        patchedCapture.metadata.tool = {
          ...tool,
          currentTool: 'brush',
          textureEnabled: true,
          dualBrushEnabled: false,
          textureSettings: {
            ...(tool.textureSettings ?? {}),
            patternId,
            mode: textureMode,
            depth,
            scale,
            brightness,
            contrast,
            invert,
            textureEachTip: scenario.textureEachTip,
            depthControl: scenario.depthControl,
            minimumDepth: scenario.minimumDepth,
            depthJitter: scenario.depthJitter,
          },
        };

        window.__canvasClearLayer();
        await waitRaf();
        await waitRaf();
        const replayResult = await withSeededRandom(replaySeed, async () =>
          window.__strokeCaptureReplay(patchedCapture, { speed: replaySpeed })
        );
        if (!replayResult) {
          throw new Error(`Replay failed in scenario=${scenario.name}`);
        }
        await wait(waitMs);
        await waitRaf();
        await waitRaf();

        const dataUrl = await window.__getFlattenedImage();
        if (!dataUrl) {
          throw new Error(`Flattened export failed in scenario=${scenario.name}`);
        }
        const alphaStats = await toAlphaStats(dataUrl);
        return {
          ...scenario,
          replayResult,
          dataUrl,
          alphaStats,
          patchedTextureSettings: patchedCapture.metadata.tool.textureSettings,
        };
      };

      const setRenderMode = useSettingsStore.getState().setRenderMode;
      const getRenderMode = () => useSettingsStore.getState().brush.renderMode;
      const originalMode = getRenderMode();
      setRenderMode(renderMode);
      await waitRaf();
      await waitRaf();

      if (renderMode === 'gpu') {
        // Warm up once to avoid first-stroke instability in comparisons.
        const warmupCapture = deepClone(capture);
        warmupCapture.metadata = warmupCapture.metadata ?? {};
        warmupCapture.metadata.tool = {
          ...(warmupCapture.metadata.tool ?? {}),
          currentTool: 'brush',
          textureEnabled: true,
        };
        window.__canvasClearLayer();
        await waitRaf();
        await waitRaf();
        await withSeededRandom(replaySeed, async () =>
          window.__strokeCaptureReplay(warmupCapture, { speed: replaySpeed })
        );
        await wait(waitMs);
        window.__canvasClearLayer();
        await waitRaf();
        await waitRaf();
      }

      const scenarios = [
        {
          name: 'off',
          textureEachTip: false,
          depthControl,
          minimumDepth,
          depthJitter: 0,
        },
        {
          name: 'on',
          textureEachTip: true,
          depthControl,
          minimumDepth,
          depthJitter: 0,
        },
        {
          name: 'jitter',
          textureEachTip: true,
          depthControl,
          minimumDepth,
          depthJitter,
        },
      ];

      const outputs = [];
      for (const scenario of scenarios) {
        outputs.push(await runScenario(scenario));
      }

      const off = outputs[0];
      const on = outputs[1];
      const jitter = outputs[2];

      const offOnDiff = await compare(off.dataUrl, on.dataUrl, mismatchThreshold);
      const onJitterDiff = await compare(on.dataUrl, jitter.dataUrl, mismatchThreshold);
      const panelDataUrl = await buildPanel(outputs);

      setRenderMode(originalMode);
      await waitRaf();

      return {
        renderMode,
        originalMode,
        patternInfo,
        textureBaseSettings: {
          mode: textureMode,
          depth,
          scale,
          brightness,
          contrast,
          invert,
          depthControl,
          minimumDepth,
          depthJitter,
        },
        outputs,
        offOnDiff,
        onJitterDiff,
        panelDataUrl,
      };
    },
    {
      capture,
      textureUrl,
      patternId,
      waitMs,
      replaySpeed,
      renderMode,
      textureMode,
      depth,
      scale,
      brightness,
      contrast,
      invert,
      depthControl,
      minimumDepth,
      depthJitter,
      replaySeed,
      mismatchThreshold,
    }
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `${stamp}-${label}`;
  const offPath = path.join(outputDir, `${baseName}-off.png`);
  const onPath = path.join(outputDir, `${baseName}-on.png`);
  const jitterPath = path.join(outputDir, `${baseName}-jitter.png`);
  const panelPath = path.join(outputDir, `${baseName}-panel.png`);
  const offOnDiffPath = path.join(outputDir, `${baseName}-off-on-diff.png`);
  const onJitterDiffPath = path.join(outputDir, `${baseName}-on-jitter-diff.png`);
  const reportPath = path.join(outputDir, `${baseName}-report.json`);

  const off = result.outputs.find((item) => item.name === 'off');
  const on = result.outputs.find((item) => item.name === 'on');
  const jitter = result.outputs.find((item) => item.name === 'jitter');
  if (!off || !on || !jitter) {
    throw new Error('Missing one of required outputs: off/on/jitter');
  }

  writePngDataUrl(off.dataUrl, offPath);
  writePngDataUrl(on.dataUrl, onPath);
  writePngDataUrl(jitter.dataUrl, jitterPath);
  writePngDataUrl(result.panelDataUrl, panelPath);
  writePngDataUrl(result.offOnDiff.diffDataUrl, offOnDiffPath);
  writePngDataUrl(result.onJitterDiff.diffDataUrl, onJitterDiffPath);

  const report = {
    at: new Date().toISOString(),
    appUrl,
    renderMode,
    capturePath,
    texturePath,
    textureUrl,
    replaySeed,
    waitMs,
    replaySpeed,
    mismatchThreshold,
    label,
    patternId,
    patternInfo: result.patternInfo,
    textureBaseSettings: result.textureBaseSettings,
    outputs: result.outputs.map((item) => ({
      name: item.name,
      alphaStats: item.alphaStats,
      patchedTextureSettings: item.patchedTextureSettings,
      replayResult: item.replayResult,
    })),
    diffs: {
      offOn: {
        meanAbsDiff: result.offOnDiff.meanAbsDiff,
        maxDiff: result.offOnDiff.maxDiff,
        mismatchRatio: result.offOnDiff.mismatchRatio,
      },
      onJitter: {
        meanAbsDiff: result.onJitterDiff.meanAbsDiff,
        maxDiff: result.onJitterDiff.maxDiff,
        mismatchRatio: result.onJitterDiff.mismatchRatio,
      },
    },
    files: {
      off: offPath,
      on: onPath,
      jitter: jitterPath,
      panel: panelPath,
      offOnDiff: offOnDiffPath,
      onJitterDiff: onJitterDiffPath,
    },
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('[OK] Texture Each Tip compare replay finished');
  console.log(`off: ${offPath}`);
  console.log(`on: ${onPath}`);
  console.log(`jitter: ${jitterPath}`);
  console.log(`panel: ${panelPath}`);
  console.log(`report: ${reportPath}`);
  console.log(
    `off-on diff: meanAbs=${report.diffs.offOn.meanAbsDiff.toFixed(4)}, mismatch=${report.diffs.offOn.mismatchRatio.toFixed(4)}%`
  );
  console.log(
    `on-jitter diff: meanAbs=${report.diffs.onJitter.meanAbsDiff.toFixed(4)}, mismatch=${report.diffs.onJitter.mismatchRatio.toFixed(4)}%`
  );
} finally {
  await browser.close();
}
