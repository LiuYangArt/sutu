/**
 * Expands short hex (e.g. "03F") to full 6-digit hex (e.g. "0033FF").
 * Handles optional # prefix.
 */
export const normalizeHex = (hex: string): string => {
  const c = hex.startsWith('#') ? hex.slice(1) : hex;
  if (c.length === 3) {
    return c
      .split('')
      .map((x) => x + x)
      .join('');
  }
  return c;
};

export const hexToHsva = (hex: string): { h: number; s: number; v: number; a: number } => {
  const expanded = normalizeHex(hex);

  const r = parseInt(expanded.slice(0, 2), 16) / 255;
  const g = parseInt(expanded.slice(2, 4), 16) / 255;
  const b = parseInt(expanded.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;

  let h = 0;
  if (max !== min) {
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }

  return { h: h * 360, s: s * 100, v: v * 100, a: 1 };
};

export const hsvaToHex = ({ h, s, v }: { h: number; s: number; v: number; a?: number }): string => {
  const S = s / 100;
  const V = v / 100;

  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return V - V * S * Math.max(0, Math.min(k, 4 - k, 1));
  };

  const toHex = (n: number) => {
    const hex = Math.round(n * 255)
      .toString(16)
      .padStart(2, '0');
    return hex.toUpperCase();
  };

  return `#${toHex(f(5))}${toHex(f(3))}${toHex(f(1))}`;
};
