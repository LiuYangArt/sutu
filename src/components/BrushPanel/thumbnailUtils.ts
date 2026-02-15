export interface ProceduralThumbnailParams {
  hardness: number; // 0-100
  roundness: number; // 0-100
  angle: number; // degrees
}

const HARD_EDGE_AA_THRESHOLD = 0.99;
const HARD_EDGE_SUBPIXEL_GRID = 8;
const SOFT_EDGE_SUBPIXEL_GRID = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Render a procedural (computed) round-tip thumbnail.
 * The falloff model mirrors Rust ABR computed tip generation.
 */
export function renderProceduralThumbnail(
  ctx: CanvasRenderingContext2D,
  size: number,
  params: ProceduralThumbnailParams
): void {
  const width = Math.max(1, Math.floor(size));
  const height = width;
  const imageData = ctx.createImageData(width, height);
  const out = imageData.data;

  const hardness = clamp(params.hardness / 100, 0, 1);
  const roundness = clamp(params.roundness / 100, 0.01, 1);
  const angleRad = (params.angle * Math.PI) / 180;
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);

  // Keep visual padding so the tip does not touch thumbnail edges.
  const diameter = width * 0.82;
  const radius = diameter / 2;
  const radiusX = radius;
  const radiusY = Math.max(radius * roundness, 0.001);
  const inverseRadiusX = 1 / radiusX;
  const inverseRadiusY = 1 / radiusY;
  const centerX = width / 2;
  const centerY = height / 2;
  const falloffStart = hardness;
  const falloffWidth = Math.max(0.0001, 1 - falloffStart);
  const isHardEdge = hardness >= HARD_EDGE_AA_THRESHOLD;
  const subpixelGrid = isHardEdge ? HARD_EDGE_SUBPIXEL_GRID : SOFT_EDGE_SUBPIXEL_GRID;
  const subpixelCount = subpixelGrid * subpixelGrid;
  const subpixelStep = 1 / subpixelGrid;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let alphaSum = 0;

      for (let sy = 0; sy < subpixelGrid; sy += 1) {
        for (let sx = 0; sx < subpixelGrid; sx += 1) {
          const sampleX = x + (sx + 0.5) * subpixelStep - centerX;
          const sampleY = y + (sy + 0.5) * subpixelStep - centerY;
          const rotX = sampleX * cosA + sampleY * sinA;
          const rotY = -sampleX * sinA + sampleY * cosA;
          const nx = rotX * inverseRadiusX;
          const ny = rotY * inverseRadiusY;
          const normalizedRadius = Math.sqrt(nx * nx + ny * ny);

          if (isHardEdge) {
            alphaSum += normalizedRadius <= 1 ? 1 : 0;
            continue;
          }
          if (normalizedRadius >= 1) {
            continue;
          }
          if (normalizedRadius <= falloffStart) {
            alphaSum += 1;
            continue;
          }
          alphaSum += 1 - (normalizedRadius - falloffStart) / falloffWidth;
        }
      }

      const a = Math.round(clamp(alphaSum / subpixelCount, 0, 1) * 255);
      const idx = (y * width + x) * 4;
      out[idx] = 255;
      out[idx + 1] = 255;
      out[idx + 2] = 255;
      out[idx + 3] = a;
    }
  }

  ctx.clearRect(0, 0, width, height);
  ctx.putImageData(imageData, 0, 0);
}
