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
      return [src[0], src[1], src[2]];
    case 'multiply':
      return [dst[0] * src[0], dst[1] * src[1], dst[2] * src[2]];
    case 'screen':
      return [
        1 - (1 - dst[0]) * (1 - src[0]),
        1 - (1 - dst[1]) * (1 - src[1]),
        1 - (1 - dst[2]) * (1 - src[2]),
      ];
    case 'overlay':
      return [
        dst[0] < 0.5 ? 2 * dst[0] * src[0] : 1 - 2 * (1 - dst[0]) * (1 - src[0]),
        dst[1] < 0.5 ? 2 * dst[1] * src[1] : 1 - 2 * (1 - dst[1]) * (1 - src[1]),
        dst[2] < 0.5 ? 2 * dst[2] * src[2] : 1 - 2 * (1 - dst[2]) * (1 - src[2]),
      ];
    case 'darken':
      return [Math.min(dst[0], src[0]), Math.min(dst[1], src[1]), Math.min(dst[2], src[2])];
    case 'lighten':
      return [Math.max(dst[0], src[0]), Math.max(dst[1], src[1]), Math.max(dst[2], src[2])];
    case 'color-dodge':
      return [
        channelColorDodge(dst[0], src[0]),
        channelColorDodge(dst[1], src[1]),
        channelColorDodge(dst[2], src[2]),
      ];
    case 'color-burn':
      return [
        channelColorBurn(dst[0], src[0]),
        channelColorBurn(dst[1], src[1]),
        channelColorBurn(dst[2], src[2]),
      ];
    case 'hard-light':
      return [
        src[0] < 0.5 ? 2 * dst[0] * src[0] : 1 - 2 * (1 - dst[0]) * (1 - src[0]),
        src[1] < 0.5 ? 2 * dst[1] * src[1] : 1 - 2 * (1 - dst[1]) * (1 - src[1]),
        src[2] < 0.5 ? 2 * dst[2] * src[2] : 1 - 2 * (1 - dst[2]) * (1 - src[2]),
      ];
    case 'soft-light':
      return [
        channelSoftLight(dst[0], src[0]),
        channelSoftLight(dst[1], src[1]),
        channelSoftLight(dst[2], src[2]),
      ];
    case 'difference':
      return [Math.abs(dst[0] - src[0]), Math.abs(dst[1] - src[1]), Math.abs(dst[2] - src[2])];
    case 'exclusion':
      return [
        dst[0] + src[0] - 2 * dst[0] * src[0],
        dst[1] + src[1] - 2 * dst[1] * src[1],
        dst[2] + src[2] - 2 * dst[2] * src[2],
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
  transparentBackdropEps?: number;
}): { rgb: [number, number, number]; alpha: number } {
  const dstAlpha = clampUnit(args.dstAlpha);
  const srcAlpha = clampUnit(args.srcAlpha);

  if (srcAlpha <= 0.0001) {
    return {
      rgb: [clampUnit(args.dstRgb[0]), clampUnit(args.dstRgb[1]), clampUnit(args.dstRgb[2])],
      alpha: dstAlpha,
    };
  }

  const outAlpha = srcAlpha + dstAlpha * (1 - srcAlpha);
  if (outAlpha <= 0.0001) {
    return { rgb: [0, 0, 0], alpha: 0 };
  }

  const eps = args.transparentBackdropEps ?? TRANSPARENT_BACKDROP_EPS;
  const useNormal = args.blendMode === 'normal' || dstAlpha <= eps;
  const blendedSrc = useNormal ? args.srcRgb : blendRgb(args.blendMode, args.dstRgb, args.srcRgb);

  const outR =
    (args.srcRgb[0] * srcAlpha * (1 - dstAlpha) +
      args.dstRgb[0] * dstAlpha * (1 - srcAlpha) +
      blendedSrc[0] * dstAlpha * srcAlpha) /
    outAlpha;
  const outG =
    (args.srcRgb[1] * srcAlpha * (1 - dstAlpha) +
      args.dstRgb[1] * dstAlpha * (1 - srcAlpha) +
      blendedSrc[1] * dstAlpha * srcAlpha) /
    outAlpha;
  const outB =
    (args.srcRgb[2] * srcAlpha * (1 - dstAlpha) +
      args.dstRgb[2] * dstAlpha * (1 - srcAlpha) +
      blendedSrc[2] * dstAlpha * srcAlpha) /
    outAlpha;

  return {
    rgb: [clampUnit(outR), clampUnit(outG), clampUnit(outB)],
    alpha: clampUnit(outAlpha),
  };
}
