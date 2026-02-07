const CONTROL_SOURCES = new Set([
  'off',
  'fade',
  'penPressure',
  'penTilt',
  'rotation',
  'direction',
  'initial',
]);

const TEXTURE_BLEND_MODES = new Set([
  'multiply',
  'subtract',
  'darken',
  'overlay',
  'colorDodge',
  'colorBurn',
  'linearBurn',
  'hardMix',
  'linearHeight',
  'height',
]);

const DUAL_BLEND_MODES = new Set([
  'multiply',
  'darken',
  'overlay',
  'colorDodge',
  'colorBurn',
  'linearBurn',
  'hardMix',
  'linearHeight',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function parseScatterSettings(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const next: Record<string, unknown> = {};
  const scatter = asFiniteNumber(value.scatter);
  const scatterControl = asString(value.scatterControl);
  const bothAxes = asBoolean(value.bothAxes);
  const count = asFiniteNumber(value.count);
  const countControl = asString(value.countControl);
  const countJitter = asFiniteNumber(value.countJitter);
  if (scatter !== null) next.scatter = scatter;
  if (scatterControl && CONTROL_SOURCES.has(scatterControl)) next.scatterControl = scatterControl;
  if (bothAxes !== null) next.bothAxes = bothAxes;
  if (count !== null) next.count = count;
  if (countControl && CONTROL_SOURCES.has(countControl)) next.countControl = countControl;
  if (countJitter !== null) next.countJitter = countJitter;
  return Object.keys(next).length > 0 ? next : null;
}

export function parseTextureSettings(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const next: Record<string, unknown> = {};
  const patternId = value.patternId;
  const scale = asFiniteNumber(value.scale);
  const brightness = asFiniteNumber(value.brightness);
  const contrast = asFiniteNumber(value.contrast);
  const mode = asString(value.mode);
  const depth = asFiniteNumber(value.depth);
  const invert = asBoolean(value.invert);
  if (patternId === null || typeof patternId === 'string') next.patternId = patternId;
  if (scale !== null) next.scale = scale;
  if (brightness !== null) next.brightness = brightness;
  if (contrast !== null) next.contrast = contrast;
  if (mode && TEXTURE_BLEND_MODES.has(mode)) next.mode = mode;
  if (depth !== null) next.depth = depth;
  if (invert !== null) next.invert = invert;
  return Object.keys(next).length > 0 ? next : null;
}

export function parseDualBrushSettings(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const next: Record<string, unknown> = {};
  const enabled = asBoolean(value.enabled);
  const brushId = value.brushId;
  const brushIndex = asFiniteNumber(value.brushIndex);
  const brushName = asString(value.brushName);
  const mode = asString(value.mode);
  const flip = asBoolean(value.flip);
  const size = asFiniteNumber(value.size);
  const sizeRatio = asFiniteNumber(value.sizeRatio);
  const spacing = asFiniteNumber(value.spacing);
  const roundness = asFiniteNumber(value.roundness);
  const scatter = asFiniteNumber(value.scatter);
  const bothAxes = asBoolean(value.bothAxes);
  const count = asFiniteNumber(value.count);
  if (enabled !== null) next.enabled = enabled;
  if (brushId === null || typeof brushId === 'string') next.brushId = brushId;
  if (brushIndex !== null) next.brushIndex = brushIndex;
  if (brushName !== null) next.brushName = brushName;
  if (mode && DUAL_BLEND_MODES.has(mode)) next.mode = mode;
  if (flip !== null) next.flip = flip;
  if (size !== null) next.size = size;
  if (sizeRatio !== null) next.sizeRatio = sizeRatio;
  if (spacing !== null) next.spacing = spacing;
  if (roundness !== null) next.roundness = roundness;
  if (scatter !== null) next.scatter = scatter;
  if (bothAxes !== null) next.bothAxes = bothAxes;
  if (count !== null) next.count = count;
  return Object.keys(next).length > 0 ? next : null;
}
