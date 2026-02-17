#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

function toPosix(filePath) {
  return filePath.replace(/\\/g, '/');
}

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined) return fallback;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return fallback;
}

function normalizeMode(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  switch (raw) {
    case 'subtract':
      return 'subtract';
    case 'linearheight':
    case 'linear-height':
    case 'linear_height':
      return 'linearHeight';
    case 'height':
      return 'height';
    default:
      throw new Error(`Unsupported --mode "${value}". Expected subtract|linearHeight|height`);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const cli = parseArgs(process.argv.slice(2));

const mode = normalizeMode(cli.mode ?? 'subtract');
const textureInput = cli.texture ?? 'debug_output/pat_decoded/pat5_sparthtex01.png';
const defaultOutputByMode = {
  subtract: 'debug_output/texture_formula_compare/subtract_formula_compare_canvas_hires.png',
  linearHeight: 'debug_output/texture_formula_compare/linear_height_formula_compare_canvas_hires.png',
  height: 'debug_output/texture_formula_compare/height_formula_compare_canvas_hires.png',
};
const outputInput = cli.output ?? defaultOutputByMode[mode];
const panelWidth = Math.max(320, Math.floor(toNumber(cli['panel-width'], 1280)));
const panelHeight = Math.max(240, Math.floor(toNumber(cli['panel-height'], 920)));
const gap = Math.max(8, Math.floor(toNumber(cli.gap, 48)));
const padding = Math.max(8, Math.floor(toNumber(cli.padding, 48)));
const headerHeight = Math.max(32, Math.floor(toNumber(cli.header, 140)));
const depth = Math.max(0, Math.min(1, toNumber(cli.depth, 0.78)));
const gamma = Math.max(0.01, toNumber(cli.gamma, 0.62));
const scale = Math.max(0.01, toNumber(cli.scale, 0.55));
const brightness = toNumber(cli.brightness, 0);
const contrast = toNumber(cli.contrast, 0);
const invert = toBoolean(cli.invert, true);
const stroke = cli.stroke === 'line' ? 'line' : 'curve';

const textureAbs = path.isAbsolute(textureInput)
  ? textureInput
  : path.resolve(repoRoot, textureInput);
const outputAbs = path.isAbsolute(outputInput) ? outputInput : path.resolve(repoRoot, outputInput);

if (!fs.existsSync(textureAbs)) {
  throw new Error(`Texture file not found: ${textureAbs}`);
}

const textureRel = path.relative(repoRoot, textureAbs);
if (textureRel.startsWith('..')) {
  throw new Error(
    `Texture must be inside repo for static serving. texture=${textureAbs}, repo=${repoRoot}`
  );
}

const canvasWidth = padding * 2 + panelWidth * 3 + gap * 2;
const canvasHeight = padding * 2 + headerHeight + panelHeight;

const server = http.createServer((req, res) => {
  const reqPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (reqPath === '/__blank') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#0b0b0d"></body></html>');
    return;
  }

  const normalized = path.normalize(reqPath).replace(/^([\\/])+/, '');
  const filePath = path.join(repoRoot, normalized);

  if (!filePath.startsWith(path.normalize(repoRoot))) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === '.png'
        ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.webp'
            ? 'image/webp'
            : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.end(data);
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Failed to get local server address');
}
const port = address.port;
const textureUrl = `http://127.0.0.1:${port}/${toPosix(textureRel)}`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: {
      width: Math.min(canvasWidth + 32, 8192),
      height: Math.min(canvasHeight + 32, 8192),
    },
  });
  await page.goto(`http://127.0.0.1:${port}/__blank`, { waitUntil: 'domcontentloaded' });

  await page.evaluate(
    async ({
      textureUrl,
      canvasWidth,
      canvasHeight,
      panelWidth,
      panelHeight,
      gap,
      padding,
      headerHeight,
      depth,
      gamma,
      scale,
      brightness,
      contrast,
      invert,
      stroke,
      mode,
    }) => {
      const clamp01 = (v) => Math.max(0, Math.min(1, v));
      const smoothstep = (edge0, edge1, x) => {
        const t = clamp01((x - edge0) / Math.max(1e-6, edge1 - edge0));
        return t * t * (3 - 2 * t);
      };
      const mix = (a, b, t) => a + (b - a) * t;

      const image = new Image();
      image.src = textureUrl;
      await image.decode();

      const texCanvas = document.createElement('canvas');
      texCanvas.width = image.width;
      texCanvas.height = image.height;
      const texCtx = texCanvas.getContext('2d', { willReadFrequently: true });
      texCtx.drawImage(image, 0, 0);
      const texData = texCtx.getImageData(0, 0, image.width, image.height).data;

      function sampleTextureLuma(x, y) {
        const tx = ((x * scale) % image.width + image.width) % image.width;
        const ty = ((y * scale) % image.height + image.height) % image.height;

        const x0 = Math.floor(tx);
        const y0 = Math.floor(ty);
        const x1 = (x0 + 1) % image.width;
        const y1 = (y0 + 1) % image.height;
        const fx = tx - x0;
        const fy = ty - y0;

        const idx00 = (y0 * image.width + x0) * 4;
        const idx10 = (y0 * image.width + x1) * 4;
        const idx01 = (y1 * image.width + x0) * 4;
        const idx11 = (y1 * image.width + x1) * 4;

        const l00 =
          (0.299 * texData[idx00] + 0.587 * texData[idx00 + 1] + 0.114 * texData[idx00 + 2]) / 255;
        const l10 =
          (0.299 * texData[idx10] + 0.587 * texData[idx10 + 1] + 0.114 * texData[idx10 + 2]) / 255;
        const l01 =
          (0.299 * texData[idx01] + 0.587 * texData[idx01 + 1] + 0.114 * texData[idx01 + 2]) / 255;
        const l11 =
          (0.299 * texData[idx11] + 0.587 * texData[idx11 + 1] + 0.114 * texData[idx11 + 2]) / 255;

        const top = l00 + (l10 - l00) * fx;
        const bottom = l01 + (l11 - l01) * fx;
        let luma = top + (bottom - top) * fy;

        if (invert) {
          luma = 1 - luma;
        }
        if (Math.abs(brightness) > 0.001) {
          luma -= brightness / 255;
        }
        if (Math.abs(contrast) > 0.001) {
          const factor = Math.pow((contrast + 100) / 100, 2);
          luma = (luma - 0.5) * factor + 0.5;
        }
        return clamp01(luma);
      }

      function distToSegment(px, py, ax, ay, bx, by) {
        const abx = bx - ax;
        const aby = by - ay;
        const apx = px - ax;
        const apy = py - ay;
        const abLenSq = abx * abx + aby * aby;
        if (abLenSq <= 1e-6) {
          const dx = px - ax;
          const dy = py - ay;
          return Math.hypot(dx, dy);
        }
        const t = clamp01((apx * abx + apy * aby) / abLenSq);
        const qx = ax + abx * t;
        const qy = ay + aby * t;
        return Math.hypot(px - qx, py - qy);
      }

      function buildStrokeAlpha() {
        const points =
          stroke === 'line'
            ? [
                [panelWidth * 0.14, panelHeight * 0.82],
                [panelWidth * 0.84, panelHeight * 0.18],
              ]
            : [
                [panelWidth * 0.12, panelHeight * 0.84],
                [panelWidth * 0.28, panelHeight * 0.62],
                [panelWidth * 0.46, panelHeight * 0.4],
                [panelWidth * 0.64, panelHeight * 0.2],
                [panelWidth * 0.8, panelHeight * 0.32],
                [panelWidth * 0.67, panelHeight * 0.58],
                [panelWidth * 0.4, panelHeight * 0.8],
              ];

        const alpha = new Float32Array(panelWidth * panelHeight);
        const radius = Math.min(panelWidth, panelHeight) * 0.095;
        const hardRadius = radius * 0.58;
        const softRadius = radius * 1.05;

        for (let y = 0; y < panelHeight; y++) {
          for (let x = 0; x < panelWidth; x++) {
            let minDist = Number.POSITIVE_INFINITY;
            for (let i = 0; i < points.length - 1; i++) {
              const a = points[i];
              const b = points[i + 1];
              const d = distToSegment(x + 0.5, y + 0.5, a[0], a[1], b[0], b[1]);
              if (d < minDist) minDist = d;
            }

            let a = 0;
            if (minDist <= hardRadius) {
              a = 1;
            } else if (minDist < softRadius) {
              a = 1 - smoothstep(hardRadius, softRadius, minDist);
            }
            alpha[y * panelWidth + x] = a;
          }
        }
        return alpha;
      }

      const baseAlpha = buildStrokeAlpha();

      function buildFormulaSet(currentMode) {
        if (currentMode === 'linearHeight') {
          return {
            title: 'Texture Linear Height Formula Candidates',
            subtitle: `mode=linearHeight  depth=${depth.toFixed(2)}  stroke=${stroke}  texture=${image.width}x${image.height}`,
            formulas: [
              {
                title: "1) Current: mix(A, A*(0.5+0.5*T), d)",
                fn: (a, t) => {
                  const blended = a * (0.5 + 0.5 * t);
                  return clamp01(mix(a, blended, depth));
                },
              },
              {
                title: "2) Krita PS: clamp(max((1-T)*M, M-T), 0, 1), M=10*d*A",
                fn: (a, t) => {
                  const m = 10 * depth * a;
                  const multiply = (1 - t) * m;
                  const height = m - t;
                  return clamp01(Math.max(multiply, height));
                },
              },
              {
                title: "3) Krita PS Soft: clamp(max(M*(1-Td), M-Td), 0, 1), M=A*(1+9d)",
                fn: (a, t) => {
                  const m = a * (1 + 9 * depth);
                  const td = t * depth;
                  const multiply = m * (1 - td);
                  const height = m - td;
                  return clamp01(Math.max(multiply, height));
                },
              },
            ],
          };
        }

        if (currentMode === 'height') {
          return {
            title: 'Texture Height Formula Candidates',
            subtitle: `mode=height  depth=${depth.toFixed(2)}  stroke=${stroke}  texture=${image.width}x${image.height}`,
            formulas: [
              {
                title: "1) Current: mix(A, min(1, A*2*T), d)",
                fn: (a, t) => {
                  const blended = Math.min(1, a * 2 * t);
                  return clamp01(mix(a, blended, depth));
                },
              },
              {
                title: "2) Krita PS: clamp(10*d*A - T, 0, 1)",
                fn: (a, t) => clamp01(10 * depth * a - t),
              },
              {
                title: "3) Krita PS Soft: clamp(A*(1+9d) - T*d, 0, 1)",
                fn: (a, t) => clamp01(a * (1 + 9 * depth) - t * depth),
              },
            ],
          };
        }

        return {
          title: 'Texture Subtract Formula Candidates',
          subtitle: `mode=subtract  depth=${depth.toFixed(2)}  gamma=${gamma.toFixed(2)}  stroke=${stroke}  texture=${image.width}x${image.height}`,
          formulas: [
            {
              title: "1) A' = clamp(A - d*T, 0, 1)",
              fn: (a, t) => clamp01(a - depth * t),
            },
            {
              title: "2) A' = A * clamp(1 - d*T, 0, 1)",
              fn: (a, t) => a * clamp01(1 - depth * t),
            },
            {
              title: `3) A' = clamp(A - d*T*A^g, 0, 1), g=${gamma.toFixed(2)}`,
              fn: (a, t) => clamp01(a - depth * t * Math.pow(Math.max(a, 1e-6), gamma)),
            },
          ],
        };
      }

      const formulaSet = buildFormulaSet(mode);
      const formulas = formulaSet.formulas;

      const canvas = document.createElement('canvas');
      canvas.id = 'compare-canvas';
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      canvas.style.display = 'block';
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#0b0b0d';
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);
      ctx.fillStyle = '#d5d5dd';
      ctx.font = 'bold 32px Segoe UI';
      ctx.fillText(formulaSet.title, padding, padding + 36);
      ctx.font = '20px Segoe UI';
      ctx.fillStyle = '#a9a9b2';
      ctx.fillText(formulaSet.subtitle, padding, padding + 76);

      const top = padding + headerHeight;
      for (let panel = 0; panel < formulas.length; panel++) {
        const left = padding + panel * (panelWidth + gap);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(left, top, panelWidth, panelHeight);

        const imgData = ctx.createImageData(panelWidth, panelHeight);
        const out = imgData.data;
        const formula = formulas[panel];

        for (let y = 0; y < panelHeight; y++) {
          for (let x = 0; x < panelWidth; x++) {
            const idx = y * panelWidth + x;
            const a = baseAlpha[idx];
            const t = sampleTextureLuma(x, y);
            const outAlpha = formula.fn(a, t);
            const gray = Math.round((1 - outAlpha) * 255);
            const o = idx * 4;
            out[o] = gray;
            out[o + 1] = gray;
            out[o + 2] = gray;
            out[o + 3] = 255;
          }
        }
        ctx.putImageData(imgData, left, top);

        ctx.strokeStyle = '#2f2f36';
        ctx.lineWidth = 2;
        ctx.strokeRect(left + 1, top + 1, panelWidth - 2, panelHeight - 2);

        ctx.fillStyle = '#ececf2';
        ctx.font = 'bold 24px Segoe UI';
        ctx.fillText(formula.title, left, top - 26);
      }
    },
    {
      textureUrl,
      canvasWidth,
      canvasHeight,
      panelWidth,
      panelHeight,
      gap,
      padding,
      headerHeight,
      depth,
      gamma,
      scale,
      brightness,
      contrast,
      invert,
      stroke,
      mode,
    }
  );

  await fs.promises.mkdir(path.dirname(outputAbs), { recursive: true });
  await page.locator('#compare-canvas').screenshot({ path: outputAbs });

  // eslint-disable-next-line no-console
  console.log(`Generated: ${outputAbs}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
