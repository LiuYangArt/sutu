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

function toOptionalNumber(value) {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

function writePngDataUrl(dataUrl, outputPath) {
  const i = dataUrl.indexOf(',');
  if (i < 0) throw new Error('Invalid data URL');
  const base64 = dataUrl.slice(i + 1);
  fs.writeFileSync(outputPath, Buffer.from(base64, 'base64'));
}

function resolveDefaultCapturePath() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const candidates = [
    path.join(appData, 'com.paintboard', 'debug-data', 'debug-stroke-capture.json'),
    path.join(appData, 'com.sutu', 'debug-data', 'debug-stroke-capture.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0] ?? null;
}

const cli = parseArgs(process.argv.slice(2));
const repoRoot = process.cwd();
const appUrl = cli.url ?? 'http://localhost:1420';
const capturePath = path.resolve(
  repoRoot,
  cli.capture ?? resolveDefaultCapturePath() ?? 'debug-stroke-capture.json'
);
const outputDir = path.resolve(
  repoRoot,
  cli.output ?? 'debug_output/brush_softness_compare'
);
const waitMs = Math.max(0, Math.floor(toNumber(cli['wait-ms'], 300)));
const replaySpeed = Math.max(0.05, toNumber(cli.speed, 1));
const headless = toBoolean(cli.headless, false);
const replaySeed = Math.max(1, Math.floor(toNumber(cli.seed, 20260213)));
const label = safeName(cli.label ?? 'cpu-softness-compare');

const maskTypeA = 'gaussian';
const maskTypeB = 'gaussian';
const hardness = toOptionalNumber(cli.hardness);
const spacing = toOptionalNumber(cli.spacing);
const roundness = toOptionalNumber(cli.roundness);
const angle = toOptionalNumber(cli.angle);

if (!fs.existsSync(capturePath)) {
  throw new Error(`Capture not found: ${capturePath}`);
}

const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
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
      waitMs,
      replaySpeed,
      replaySeed,
      maskTypeA,
      maskTypeB,
      hardness,
      spacing,
      roundness,
      angle,
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
      const useSettingsStore = settingsMod.useSettingsStore;

      const getRenderMode = () => useSettingsStore.getState().brush.renderMode;
      const setRenderMode = useSettingsStore.getState().setRenderMode;
      const originalMode = getRenderMode();

      const patchCapture = (srcCapture, maskType) => {
        const patched = JSON.parse(JSON.stringify(srcCapture));
        if (!patched.metadata || typeof patched.metadata !== 'object') {
          patched.metadata = {};
        }
        if (!patched.metadata.tool || typeof patched.metadata.tool !== 'object') {
          patched.metadata.tool = {};
        }
        const tool = patched.metadata.tool;

        tool.currentTool = 'brush';
        tool.textureEnabled = false;
        tool.dualBrushEnabled = false;
        tool.wetEdgeEnabled = false;
        tool.noiseEnabled = false;
        tool.buildupEnabled = false;
        tool.brushMaskType = maskType;
        tool.maskType = maskType;
        if (hardness !== null) tool.brushHardness = hardness;
        if (spacing !== null) tool.brushSpacing = spacing;
        if (roundness !== null) tool.brushRoundness = roundness;
        if (angle !== null) tool.brushAngle = angle;

        return patched;
      };

      const variantA = patchCapture(capture, maskTypeA);
      const variantB = patchCapture(capture, maskTypeB);

      const replayOne = async (patchedCapture, variantName) => {
        window.__canvasClearLayer();
        await waitRaf();
        await waitRaf();

        const replayResult = await withSeededRandom(replaySeed, async () =>
          window.__strokeCaptureReplay(patchedCapture, { speed: replaySpeed })
        );
        if (!replayResult) {
          throw new Error(`Replay failed for variant=${variantName}`);
        }

        await wait(waitMs);
        await waitRaf();
        await waitRaf();

        const flattened = await window.__getFlattenedImage();
        if (!flattened) {
          throw new Error(`Flattened export failed for variant=${variantName}`);
        }
        return {
          dataUrl: flattened,
          replayResult,
          tool: patchedCapture.metadata.tool,
        };
      };

      const analyzeImage = async (dataUrl) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();

        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Failed to create analysis canvas');
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const data = ctx.getImageData(0, 0, c.width, c.height).data;

        let minX = c.width;
        let minY = c.height;
        let maxX = -1;
        let maxY = -1;
        let alphaSum = 0;
        let alphaCount = 0;
        let softBandPixels = 0;
        let opaquePixels = 0;

        for (let y = 0; y < c.height; y += 1) {
          for (let x = 0; x < c.width; x += 1) {
            const idx = (y * c.width + x) * 4 + 3;
            const a = data[idx] ?? 0;
            if (a > 0) {
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
              alphaSum += a;
              alphaCount += 1;
              if (a > 8 && a < 245) softBandPixels += 1;
              if (a >= 245) opaquePixels += 1;
            }
          }
        }

        const hasCoverage = maxX >= minX && maxY >= minY;
        let bbox;
        if (hasCoverage) {
          bbox = {
            left: minX,
            top: minY,
            right: maxX + 1,
            bottom: maxY + 1,
            width: maxX - minX + 1,
            height: maxY - minY + 1,
          };
        } else {
          bbox = {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            width: 0,
            height: 0,
          };
        }

        let edgeGradientSum = 0;
        let edgeGradientCount = 0;
        if (hasCoverage) {
          for (let y = bbox.top; y < bbox.bottom - 1; y += 1) {
            for (let x = bbox.left; x < bbox.right - 1; x += 1) {
              const o = (y * c.width + x) * 4 + 3;
              const a = data[o] ?? 0;
              if (a <= 8 || a >= 245) continue;
              const ar = data[o + 4] ?? 0;
              const ad = data[o + c.width * 4] ?? 0;
              edgeGradientSum += Math.abs(a - ar) + Math.abs(a - ad);
              edgeGradientCount += 2;
            }
          }
        }

        return {
          width: c.width,
          height: c.height,
          bbox,
          coveragePixels: alphaCount,
          softBandPixels,
          opaquePixels,
          softBandRatio: alphaCount > 0 ? softBandPixels / alphaCount : 0,
          meanAlpha: alphaCount > 0 ? alphaSum / alphaCount : 0,
          meanEdgeGradient: edgeGradientCount > 0 ? edgeGradientSum / edgeGradientCount : 0,
        };
      };

      const compare = async (aUrl, bUrl) => {
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
        const cB = document.createElement('canvas');
        const cD = document.createElement('canvas');
        cA.width = cB.width = cD.width = w;
        cA.height = cB.height = cD.height = h;
        const ctxA = cA.getContext('2d', { willReadFrequently: true });
        const ctxB = cB.getContext('2d', { willReadFrequently: true });
        const ctxD = cD.getContext('2d');
        if (!ctxA || !ctxB || !ctxD) throw new Error('Failed to create diff canvas');
        ctxA.drawImage(imgA, 0, 0, w, h);
        ctxB.drawImage(imgB, 0, 0, w, h);
        const da = ctxA.getImageData(0, 0, w, h).data;
        const db = ctxB.getImageData(0, 0, w, h).data;
        const out = ctxD.createImageData(w, h);
        const pixels = w * h;
        const threshold = 4;
        let sumAbs = 0;
        let maxDiff = 0;
        let mismatch = 0;
        for (let i = 0; i < pixels; i += 1) {
          const o = i * 4;
          const dr = Math.abs((da[o] ?? 0) - (db[o] ?? 0));
          const dg = Math.abs((da[o + 1] ?? 0) - (db[o + 1] ?? 0));
          const dbb = Math.abs((da[o + 2] ?? 0) - (db[o + 2] ?? 0));
          const daa = Math.abs((da[o + 3] ?? 0) - (db[o + 3] ?? 0));
          const d = Math.max(dr, dg, dbb, daa);
          sumAbs += dr + dg + dbb + daa;
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

      setRenderMode('cpu');
      await waitRaf();
      await waitRaf();

      const a = await replayOne(variantA, maskTypeA);
      const b = await replayOne(variantB, maskTypeB);

      setRenderMode(originalMode);
      await waitRaf();

      const analysisA = await analyzeImage(a.dataUrl);
      const analysisB = await analyzeImage(b.dataUrl);
      const diff = await compare(a.dataUrl, b.dataUrl);

      return {
        originalMode,
        variantA: a,
        variantB: b,
        analysisA,
        analysisB,
        diff,
      };
    },
    {
      capture,
      waitMs,
      replaySpeed,
      replaySeed,
      maskTypeA,
      maskTypeB,
      hardness,
      spacing,
      roundness,
      angle,
    }
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `${stamp}-${label}`;
  const aPath = path.join(outputDir, `${baseName}-a-${safeName(maskTypeA)}.png`);
  const bPath = path.join(outputDir, `${baseName}-b-${safeName(maskTypeB)}.png`);
  const diffPath = path.join(outputDir, `${baseName}-diff.png`);
  const reportPath = path.join(outputDir, `${baseName}-report.json`);

  writePngDataUrl(result.variantA.dataUrl, aPath);
  writePngDataUrl(result.variantB.dataUrl, bPath);
  writePngDataUrl(result.diff.diffDataUrl, diffPath);

  const report = {
    appUrl,
    capturePath,
    outputDir,
    replaySeed,
    originalRenderMode: result.originalMode,
    options: {
      waitMs,
      speed: replaySpeed,
      maskTypeA,
      maskTypeB,
      hardness,
      spacing,
      roundness,
      angle,
    },
    variantA: {
      maskType: maskTypeA,
      replay: result.variantA.replayResult,
      toolPatch: result.variantA.tool,
      analysis: result.analysisA,
      file: aPath,
    },
    variantB: {
      maskType: maskTypeB,
      replay: result.variantB.replayResult,
      toolPatch: result.variantB.tool,
      analysis: result.analysisB,
      file: bPath,
    },
    diff: {
      meanAbsDiff: result.diff.meanAbsDiff,
      maxDiff: result.diff.maxDiff,
      mismatchRatio: result.diff.mismatchRatio,
      width: result.diff.width,
      height: result.diff.height,
      file: diffPath,
    },
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`[CpuSoftnessCompare] A(${maskTypeA}): ${aPath}`);
  console.log(`[CpuSoftnessCompare] B(${maskTypeB}): ${bPath}`);
  console.log(`[CpuSoftnessCompare] diff: ${diffPath}`);
  console.log(`[CpuSoftnessCompare] report: ${reportPath}`);
  console.log(
    `[CpuSoftnessCompare] meanAbsDiff=${report.diff.meanAbsDiff.toFixed(4)} maxDiff=${
      report.diff.maxDiff
    } mismatchRatio=${report.diff.mismatchRatio.toFixed(4)}%`
  );
} finally {
  await browser.close();
}
