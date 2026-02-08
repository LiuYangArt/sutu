export interface ProceduralThumbnailParams {
  hardness: number; // 0-100
  roundness: number; // 0-100
  angle: number; // degrees
}

const HARD_EDGE_AA_THRESHOLD = 0.99;

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
  const centerX = width / 2;
  const centerY = height / 2;
  const falloffStart = radius * hardness;
  const falloffWidth = Math.max(0.001, radius - falloffStart);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - centerX + 0.5;
      const dy = y - centerY + 0.5;
      const rotX = dx * cosA + dy * sinA;
      const rotY = -dx * sinA + dy * cosA;
      const dist = Math.sqrt(rotX * rotX + (rotY / roundness) * (rotY / roundness));

      let alpha = 0;
      if (hardness >= HARD_EDGE_AA_THRESHOLD) {
        // Hard-edge brushes still need a 1px anti-aliasing band to avoid jagged circles.
        alpha = clamp(radius - dist, 0, 1);
      } else if (dist < radius) {
        if (dist < falloffStart) {
          alpha = 1;
        } else {
          alpha = 1 - (dist - falloffStart) / falloffWidth;
        }
      }

      const a = Math.round(clamp(alpha, 0, 1) * 255);
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
