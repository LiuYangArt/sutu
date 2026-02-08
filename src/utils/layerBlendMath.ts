import type { BlendMode } from '@/stores/document';

type Rgb = readonly [number, number, number];

export const TRANSPARENT_BACKDROP_EPS = 0.5 / 255;

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function channelColorDodge(dst: number, src: number): number {
  if (src >= 0.9999) return 1;
  return Math.min(1, dst / Math.max(0.0001, 1 - src));
}

function channelColorBurn(dst: number, src: number): number {
  if (src <= 0.0001) return 0;
  return Math.max(0, 1 - (1 - dst) / src);
}

function channelSoftLight(dst: number, src: number): number {
  if (src <= 0.5) {
    return dst - (1 - 2 * src) * dst * (1 - dst);
  }
  const g = dst > 0.25 ? Math.sqrt(dst) : ((16 * dst - 12) * dst + 4) * dst;
  return dst + (2 * src - 1) * (g - dst);
}

function channelLinearBurn(dst: number, src: number): number {
  return clampUnit(dst + src - 1);
}

function channelLinearDodge(dst: number, src: number): number {
  return clampUnit(dst + src);
}

function channelOverlay(dst: number, src: number): number {
  if (dst < 0.5) return 2 * dst * src;
  return 1 - 2 * (1 - dst) * (1 - src);
}

function channelHardLight(dst: number, src: number): number {
  if (src < 0.5) return 2 * dst * src;
  return 1 - 2 * (1 - dst) * (1 - src);
}

function channelVividLight(dst: number, src: number): number {
  if (src <= 0.5) {
    return channelColorBurn(dst, 2 * src);
  }
  return channelColorDodge(dst, 2 * (src - 0.5));
}

function channelLinearLight(dst: number, src: number): number {
  return clampUnit(dst + 2 * src - 1);
}

function channelPinLight(dst: number, src: number): number {
  if (src <= 0.5) {
    return Math.min(dst, 2 * src);
  }
  return Math.max(dst, 2 * src - 1);
}

function channelHardMix(dst: number, src: number): number {
  return channelVividLight(dst, src) < 0.5 ? 0 : 1;
}

function channelDivide(dst: number, src: number): number {
  if (src <= 0.0001) return 1;
  return clampUnit(dst / src);
}

function hashNoise01(x: number, y: number): number {
  const xi = x >>> 0;
  const yi = y >>> 0;
  const n = (Math.imul(xi, 1973) + Math.imul(yi, 9277) + 89173) >>> 0;
  const m = ((n << 13) ^ n) >>> 0;
  const mm = Math.imul(m, m);
  const t = (Math.imul(m, (Math.imul(mm, 15731) + 789221) >>> 0) + 1376312589) >>> 0;
  return (t & 0x00ffffff) / 0x00ffffff;
}

function resolveDissolveAlpha(srcAlpha: number, pixelX: number, pixelY: number): number {
  if (srcAlpha <= 0.0001) return 0;
  if (srcAlpha >= 0.9999) return 1;
  return hashNoise01(pixelX, pixelY) < srcAlpha ? 1 : 0;
}

function rgbToHsl(color: Rgb): [number, number, number] {
  const [r, g, b] = color;
  const cmax = Math.max(r, g, b);
  const cmin = Math.min(r, g, b);
  const delta = cmax - cmin;
  const l = (cmax + cmin) * 0.5;
  let h = 0;
  let s = 0;

  if (delta > 0.0001) {
    s = delta / Math.max(0.0001, 1 - Math.abs(2 * l - 1));
    if (cmax === r) {
      h = (g - b) / delta;
      if (g < b) h += 6;
    } else if (cmax === g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }
    h /= 6;
  }

  return [h, s, l];
}

function hueToRgb(p: number, q: number, tValue: number): number {
  let t = tValue;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 0.5) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(hsl: readonly [number, number, number]): [number, number, number] {
  const [h, s, l] = hsl;
  if (s <= 0.0001) return [l, l, l];

  const q = l >= 0.5 ? l + s - l * s : l * (1 + s);
  const p = 2 * l - q;
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
}

function lum(color: Rgb): number {
  return color[0] * 0.3 + color[1] * 0.59 + color[2] * 0.11;
}

function clipColor(color: Rgb): [number, number, number] {
  let out: [number, number, number] = [color[0], color[1], color[2]];
  const l = lum(out);
  const n = Math.min(out[0], out[1], out[2]);
  const x = Math.max(out[0], out[1], out[2]);

  if (n < 0) {
    const denom = Math.max(0.0001, l - n);
    out = [
      l + ((out[0] - l) * l) / denom,
      l + ((out[1] - l) * l) / denom,
      l + ((out[2] - l) * l) / denom,
    ];
  }
  if (x > 1) {
    const denom = Math.max(0.0001, x - l);
    out = [
      l + ((out[0] - l) * (1 - l)) / denom,
      l + ((out[1] - l) * (1 - l)) / denom,
      l + ((out[2] - l) * (1 - l)) / denom,
    ];
  }

  return [clampUnit(out[0]), clampUnit(out[1]), clampUnit(out[2])];
}

function setLum(color: Rgb, l: number): [number, number, number] {
  const delta = l - lum(color);
  return clipColor([color[0] + delta, color[1] + delta, color[2] + delta]);
}

export function blendRgb(mode: BlendMode, dst: Rgb, src: Rgb): [number, number, number] {
  switch (mode) {
    case 'normal':
    case 'dissolve':
      return [src[0], src[1], src[2]];
    case 'darken':
      return [Math.min(dst[0], src[0]), Math.min(dst[1], src[1]), Math.min(dst[2], src[2])];
    case 'multiply':
      return [dst[0] * src[0], dst[1] * src[1], dst[2] * src[2]];
    case 'color-burn':
      return [
        channelColorBurn(dst[0], src[0]),
        channelColorBurn(dst[1], src[1]),
        channelColorBurn(dst[2], src[2]),
      ];
    case 'linear-burn':
      return [
        channelLinearBurn(dst[0], src[0]),
        channelLinearBurn(dst[1], src[1]),
        channelLinearBurn(dst[2], src[2]),
      ];
    case 'darker-color': {
      const dstSum = dst[0] + dst[1] + dst[2];
      const srcSum = src[0] + src[1] + src[2];
      return srcSum < dstSum ? [src[0], src[1], src[2]] : [dst[0], dst[1], dst[2]];
    }
    case 'lighten':
      return [Math.max(dst[0], src[0]), Math.max(dst[1], src[1]), Math.max(dst[2], src[2])];
    case 'screen':
      return [
        1 - (1 - dst[0]) * (1 - src[0]),
        1 - (1 - dst[1]) * (1 - src[1]),
        1 - (1 - dst[2]) * (1 - src[2]),
      ];
    case 'color-dodge':
      return [
        channelColorDodge(dst[0], src[0]),
        channelColorDodge(dst[1], src[1]),
        channelColorDodge(dst[2], src[2]),
      ];
    case 'linear-dodge':
      return [
        channelLinearDodge(dst[0], src[0]),
        channelLinearDodge(dst[1], src[1]),
        channelLinearDodge(dst[2], src[2]),
      ];
    case 'lighter-color': {
      const dstSum = dst[0] + dst[1] + dst[2];
      const srcSum = src[0] + src[1] + src[2];
      return srcSum > dstSum ? [src[0], src[1], src[2]] : [dst[0], dst[1], dst[2]];
    }
    case 'overlay':
      return [
        channelOverlay(dst[0], src[0]),
        channelOverlay(dst[1], src[1]),
        channelOverlay(dst[2], src[2]),
      ];
    case 'soft-light':
      return [
        channelSoftLight(dst[0], src[0]),
        channelSoftLight(dst[1], src[1]),
        channelSoftLight(dst[2], src[2]),
      ];
    case 'hard-light':
      return [
        channelHardLight(dst[0], src[0]),
        channelHardLight(dst[1], src[1]),
        channelHardLight(dst[2], src[2]),
      ];
    case 'vivid-light':
      return [
        channelVividLight(dst[0], src[0]),
        channelVividLight(dst[1], src[1]),
        channelVividLight(dst[2], src[2]),
      ];
    case 'linear-light':
      return [
        channelLinearLight(dst[0], src[0]),
        channelLinearLight(dst[1], src[1]),
        channelLinearLight(dst[2], src[2]),
      ];
    case 'pin-light':
      return [
        channelPinLight(dst[0], src[0]),
        channelPinLight(dst[1], src[1]),
        channelPinLight(dst[2], src[2]),
      ];
    case 'hard-mix':
      return [
        channelHardMix(dst[0], src[0]),
        channelHardMix(dst[1], src[1]),
        channelHardMix(dst[2], src[2]),
      ];
    case 'difference':
      return [Math.abs(dst[0] - src[0]), Math.abs(dst[1] - src[1]), Math.abs(dst[2] - src[2])];
    case 'exclusion':
      return [
        dst[0] + src[0] - 2 * dst[0] * src[0],
        dst[1] + src[1] - 2 * dst[1] * src[1],
        dst[2] + src[2] - 2 * dst[2] * src[2],
      ];
    case 'subtract':
      return [
        Math.max(0, dst[0] - src[0]),
        Math.max(0, dst[1] - src[1]),
        Math.max(0, dst[2] - src[2]),
      ];
    case 'divide':
      return [
        channelDivide(dst[0], src[0]),
        channelDivide(dst[1], src[1]),
        channelDivide(dst[2], src[2]),
      ];
    case 'hue': {
      const dstHsl = rgbToHsl(dst);
      const srcHsl = rgbToHsl(src);
      return hslToRgb([srcHsl[0], dstHsl[1], dstHsl[2]]);
    }
    case 'saturation': {
      const dstHsl = rgbToHsl(dst);
      const srcHsl = rgbToHsl(src);
      return hslToRgb([dstHsl[0], srcHsl[1], dstHsl[2]]);
    }
    case 'color':
      return setLum(src, lum(dst));
    case 'luminosity':
      return setLum(dst, lum(src));
    default:
      return [src[0], src[1], src[2]];
  }
}

export function compositePixelWithTransparentFallback(args: {
  blendMode: BlendMode;
  dstRgb: Rgb;
  dstAlpha: number;
  srcRgb: Rgb;
  srcAlpha: number;
  pixelX?: number;
  pixelY?: number;
  transparentBackdropEps?: number;
}): { rgb: [number, number, number]; alpha: number } {
  const {
    blendMode,
    dstRgb,
    dstAlpha: rawDstAlpha,
    srcRgb,
    srcAlpha: rawSrcAlpha,
    pixelX,
    pixelY,
    transparentBackdropEps,
  } = args;
  const dstAlpha = clampUnit(rawDstAlpha);
  const srcAlpha = clampUnit(rawSrcAlpha);
  const effectiveSrcAlpha =
    blendMode === 'dissolve' ? resolveDissolveAlpha(srcAlpha, pixelX ?? 0, pixelY ?? 0) : srcAlpha;
  const dstR = dstRgb[0];
  const dstG = dstRgb[1];
  const dstB = dstRgb[2];
  const srcR = srcRgb[0];
  const srcG = srcRgb[1];
  const srcB = srcRgb[2];

  if (effectiveSrcAlpha <= 0.0001) {
    return {
      rgb: [clampUnit(dstR), clampUnit(dstG), clampUnit(dstB)],
      alpha: dstAlpha,
    };
  }

  const outAlpha = effectiveSrcAlpha + dstAlpha * (1 - effectiveSrcAlpha);
  if (outAlpha <= 0.0001) {
    return { rgb: [0, 0, 0], alpha: 0 };
  }

  const eps = transparentBackdropEps ?? TRANSPARENT_BACKDROP_EPS;
  const useNormal = blendMode === 'normal' || blendMode === 'dissolve' || dstAlpha <= eps;
  const blendedSrc = useNormal ? srcRgb : blendRgb(blendMode, dstRgb, srcRgb);
  const srcOnlyWeight = effectiveSrcAlpha * (1 - dstAlpha);
  const dstOnlyWeight = dstAlpha * (1 - effectiveSrcAlpha);
  const overlapWeight = dstAlpha * effectiveSrcAlpha;

  const outR =
    (srcR * srcOnlyWeight + dstR * dstOnlyWeight + blendedSrc[0] * overlapWeight) / outAlpha;
  const outG =
    (srcG * srcOnlyWeight + dstG * dstOnlyWeight + blendedSrc[1] * overlapWeight) / outAlpha;
  const outB =
    (srcB * srcOnlyWeight + dstB * dstOnlyWeight + blendedSrc[2] * overlapWeight) / outAlpha;

  return {
    rgb: [clampUnit(outR), clampUnit(outG), clampUnit(outB)],
    alpha: clampUnit(outAlpha),
  };
}
