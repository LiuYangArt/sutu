import fs from 'node:fs';
import path from 'node:path';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function toBase64Buffer(dataUrl) {
  const marker = 'base64,';
  const index = dataUrl.indexOf(marker);
  if (index < 0) {
    throw new Error('Invalid data URL');
  }
  return Buffer.from(dataUrl.slice(index + marker.length), 'base64');
}

export async function writeKritaTailChartPng({
  browser,
  sutuTrace,
  kritaTrace,
  outputPath,
  caseId,
}) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 560 },
  });

  try {
    const dataUrl = await page.evaluate(
      ({ sutuTrace, kritaTrace, caseId }) => {
        const width = 1200;
        const height = 520;
        const margin = { top: 56, right: 28, bottom: 44, left: 56 };
        const innerWidth = width - margin.left - margin.right;
        const innerHeight = height - margin.top - margin.bottom;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('Failed to create canvas context');
        }

        const tailSlice = (dabs) => {
          if (!Array.isArray(dabs) || dabs.length === 0) return [];
          const last20Start = Math.max(0, dabs.length - 20);
          const cumulative = [0];
          for (let i = 1; i < dabs.length; i += 1) {
            const prev = dabs[i - 1];
            const curr = dabs[i];
            cumulative.push(
              cumulative[i - 1] + Math.hypot((curr?.x ?? 0) - (prev?.x ?? 0), (curr?.y ?? 0) - (prev?.y ?? 0))
            );
          }
          const total = cumulative[cumulative.length - 1] ?? 0;
          const threshold = total * 0.85;
          let arcStart = 0;
          for (let i = 0; i < cumulative.length; i += 1) {
            if (cumulative[i] >= threshold) {
              arcStart = i;
              break;
            }
          }
          return dabs.slice(Math.min(last20Start, arcStart));
        };

        const sutuTail = tailSlice(sutuTrace?.stages?.dab_emit ?? []);
        const kritaTail = tailSlice(kritaTrace?.stages?.dab_emit ?? []);
        const n = Math.max(2, sutuTail.length, kritaTail.length);

        const toPlot = (tail) => {
          if (!Array.isArray(tail) || tail.length === 0) return [];
          return tail.map((item, index) => ({
            xNorm: tail.length <= 1 ? 0 : index / (tail.length - 1),
            yNorm: Math.max(0, Math.min(1, item?.pressure ?? 0)),
          }));
        };

        const sutuPlot = toPlot(sutuTail);
        const kritaPlot = toPlot(kritaTail);

        ctx.fillStyle = '#0d1117';
        ctx.fillRect(0, 0, width, height);

        ctx.fillStyle = '#f0f6fc';
        ctx.font = '700 20px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif';
        ctx.fillText(`Krita Tail Pressure Chart - ${caseId}`, margin.left, 30);
        ctx.font = '500 13px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = '#8b949e';
        ctx.fillText(`sutu tail dabs=${sutuTail.length}, krita tail dabs=${kritaTail.length}, alignedN=${n}`, margin.left, 48);

        ctx.strokeStyle = '#30363d';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 5; i += 1) {
          const y = margin.top + (innerHeight * i) / 5;
          ctx.beginPath();
          ctx.moveTo(margin.left, y);
          ctx.lineTo(margin.left + innerWidth, y);
          ctx.stroke();
        }
        for (let i = 0; i <= 10; i += 1) {
          const x = margin.left + (innerWidth * i) / 10;
          ctx.beginPath();
          ctx.moveTo(x, margin.top);
          ctx.lineTo(x, margin.top + innerHeight);
          ctx.stroke();
        }

        ctx.strokeStyle = '#58a6ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        sutuPlot.forEach((point, index) => {
          const x = margin.left + point.xNorm * innerWidth;
          const y = margin.top + (1 - point.yNorm) * innerHeight;
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        if (sutuPlot.length > 0) {
          ctx.stroke();
        }

        ctx.strokeStyle = '#f2cc60';
        ctx.lineWidth = 2;
        ctx.beginPath();
        kritaPlot.forEach((point, index) => {
          const x = margin.left + point.xNorm * innerWidth;
          const y = margin.top + (1 - point.yNorm) * innerHeight;
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        if (kritaPlot.length > 0) {
          ctx.stroke();
        }

        ctx.fillStyle = '#58a6ff';
        ctx.fillRect(margin.left, height - 28, 14, 4);
        ctx.fillStyle = '#f0f6fc';
        ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText('Sutu tail pressure', margin.left + 20, height - 22);

        const legendX = margin.left + 190;
        ctx.fillStyle = '#f2cc60';
        ctx.fillRect(legendX, height - 28, 14, 4);
        ctx.fillStyle = '#f0f6fc';
        ctx.fillText('Krita baseline tail pressure', legendX + 20, height - 22);

        return canvas.toDataURL('image/png');
      },
      { sutuTrace, kritaTrace, caseId }
    );

    ensureDir(path.dirname(outputPath));
    fs.writeFileSync(outputPath, toBase64Buffer(dataUrl));
  } finally {
    await page.close();
  }
}
