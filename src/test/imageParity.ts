export interface ImageParityMetrics {
  meanAbsDiff: number;
  mismatchRatio: number;
  maxDiff: number;
  pixelCount: number;
}

export interface ImageParityThresholds {
  meanAbsDiffMax: number;
  mismatchRatioMax: number;
}

export const DEFAULT_MISMATCH_PIXEL_DELTA = 3;

function ensureComparable(a: ImageData, b: ImageData): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`Image size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
}

export function computeImageParityMetrics(
  baseline: ImageData,
  candidate: ImageData,
  mismatchPixelDelta: number = DEFAULT_MISMATCH_PIXEL_DELTA
): ImageParityMetrics {
  ensureComparable(baseline, candidate);

  const baselineData = baseline.data;
  const candidateData = candidate.data;
  const pixelCount = baseline.width * baseline.height;
  if (pixelCount <= 0) {
    return { meanAbsDiff: 0, mismatchRatio: 0, maxDiff: 0, pixelCount: 0 };
  }

  let sumAbsDiff = 0;
  let mismatchPixels = 0;
  let maxDiff = 0;

  for (let i = 0; i < baselineData.length; i += 4) {
    const dr = Math.abs((baselineData[i] ?? 0) - (candidateData[i] ?? 0));
    const dg = Math.abs((baselineData[i + 1] ?? 0) - (candidateData[i + 1] ?? 0));
    const db = Math.abs((baselineData[i + 2] ?? 0) - (candidateData[i + 2] ?? 0));
    const da = Math.abs((baselineData[i + 3] ?? 0) - (candidateData[i + 3] ?? 0));

    const pixelMaxDiff = Math.max(dr, dg, db, da);
    if (pixelMaxDiff > mismatchPixelDelta) {
      mismatchPixels += 1;
    }
    if (pixelMaxDiff > maxDiff) {
      maxDiff = pixelMaxDiff;
    }

    sumAbsDiff += dr + dg + db + da;
  }

  return {
    meanAbsDiff: sumAbsDiff / (pixelCount * 4),
    mismatchRatio: (mismatchPixels / pixelCount) * 100,
    maxDiff,
    pixelCount,
  };
}

export function isImageParityPass(
  metrics: ImageParityMetrics,
  thresholds: ImageParityThresholds
): boolean {
  return (
    metrics.meanAbsDiff <= thresholds.meanAbsDiffMax &&
    metrics.mismatchRatio <= thresholds.mismatchRatioMax
  );
}

export async function decodeDataUrlToImageData(dataUrl: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (width <= 0 || height <= 0) {
        reject(new Error('Decoded image has invalid dimensions'));
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to create canvas context for parity decode'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(ctx.getImageData(0, 0, width, height));
    };
    img.onerror = () => reject(new Error('Failed to decode parity data URL'));
    img.src = dataUrl;
  });
}

export async function compareImageDataUrls(
  baselineDataUrl: string,
  candidateDataUrl: string,
  mismatchPixelDelta: number = DEFAULT_MISMATCH_PIXEL_DELTA
): Promise<ImageParityMetrics> {
  const [baseline, candidate] = await Promise.all([
    decodeDataUrlToImageData(baselineDataUrl),
    decodeDataUrlToImageData(candidateDataUrl),
  ]);
  return computeImageParityMetrics(baseline, candidate, mismatchPixelDelta);
}
