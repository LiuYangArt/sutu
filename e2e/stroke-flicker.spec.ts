import { test, expect } from '@playwright/test';

/**
 * Stroke Reliability Tests
 * Verifies that strokes are rendered correctly and no flicker occurs
 */
test.describe('Stroke Flicker Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('canvas', { state: 'visible', timeout: 10000 });
  });

  test('should not drop strokes in grid test (10x10)', async ({ page }) => {
    const canvas = page.locator('canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    const rows = 10;
    const cols = 10;
    const spacing = 30;
    const points: Array<{ x: number; y: number }> = [];

    // Draw a grid of taps
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = box.x + 50 + c * spacing;
        const y = box.y + 50 + r * spacing;
        points.push({ x, y });

        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.waitForTimeout(5);
        await page.mouse.up();
        await page.waitForTimeout(15);
      }
    }

    // Wait for rendering to complete
    await page.waitForTimeout(500);

    // Post-test verification: check each point for pixels
    const result = await page.evaluate(
      ({ points, boxX, boxY }) => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return { passed: false, missing: points.length, total: points.length };

        const ctx = canvas.getContext('2d');
        if (!ctx) return { passed: false, missing: points.length, total: points.length };

        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let missing = 0;

        for (const pt of points) {
          // Convert to canvas coordinates
          const canvasX = Math.round(pt.x - boxX);
          const canvasY = Math.round(pt.y - boxY);

          // Check 5x5 area around the point
          let found = false;
          for (let dy = -2; dy <= 2 && !found; dy++) {
            for (let dx = -2; dx <= 2 && !found; dx++) {
              const x = canvasX + dx;
              const y = canvasY + dy;
              if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) continue;

              const i = (y * canvas.width + x) * 4;
              if (imgData.data[i + 3] > 10) {
                found = true;
              }
            }
          }

          if (!found) missing++;
        }

        return {
          passed: missing === 0,
          missing,
          total: points.length,
          found: points.length - missing,
        };
      },
      { points, boxX: box.x, boxY: box.y }
    );

    console.log(`Grid Test: ${result.found}/${result.total} points found`);
    expect(result.passed, `Missing ${result.missing} points out of ${result.total}`).toBe(true);
  });

  test('should handle rapid taps (100x) without crash', async ({ page }) => {
    const canvas = page.locator('canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Rapid fire taps
    for (let i = 0; i < 100; i++) {
      const x = box.x + 50 + (i % 20) * 15;
      const y = box.y + 100 + Math.floor(i / 20) * 30;

      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.waitForTimeout(1); // Very short press
      await page.mouse.up();
      await page.waitForTimeout(5); // Very short interval
    }

    // Wait and verify no crash
    await page.waitForTimeout(500);
    await expect(canvas).toBeVisible();

    // Filter out expected errors
    const criticalErrors = errors.filter(
      (err) => !err.includes('__TAURI__') && !err.includes('window.__TAURI_INTERNALS__')
    );

    expect(criticalErrors).toHaveLength(0);
  });

  test('should handle stroke start/end stress (50x short strokes)', async ({ page }) => {
    const canvas = page.locator('canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    // Draw 50 very short strokes quickly
    for (let i = 0; i < 50; i++) {
      const startX = box.x + 100 + (i % 10) * 30;
      const startY = box.y + 100 + Math.floor(i / 10) * 40;

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 20, startY + 10, { steps: 3 });
      await page.mouse.up();
      await page.waitForTimeout(10);
    }

    // Wait and verify canvas is still functional
    await page.waitForTimeout(500);
    await expect(canvas).toBeVisible();
  });

  test('should handle interleaved rapid pen up/down', async ({ page }) => {
    const canvas = page.locator('canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    // Simulate rapid pen lift/touch at same position (tablet behavior)
    for (let i = 0; i < 30; i++) {
      await page.mouse.move(x + i, y);
      await page.mouse.down();
      await page.waitForTimeout(2);
      await page.mouse.up();
      await page.waitForTimeout(2);
    }

    await page.waitForTimeout(300);
    await expect(canvas).toBeVisible();
  });
});

test.describe('Stroke Chaos Tests', () => {
  test('should survive 5 seconds of random input', async ({ page }) => {
    test.slow(); // Mark as potentially slow test

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const canvas = page.locator('canvas');
    await canvas.waitFor({ state: 'visible', timeout: 10000 });
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    const errors: string[] = [];
    page.on('pageerror', (err) => {
      errors.push(err.message);
    });

    // 5 seconds of random input
    const startTime = Date.now();
    const duration = 5000;
    let actions = 0;

    while (Date.now() - startTime < duration) {
      const x = box.x + 50 + Math.random() * (box.width - 100);
      const y = box.y + 50 + Math.random() * (box.height - 100);
      const isStroke = Math.random() > 0.5;

      if (isStroke) {
        const endX = x + (Math.random() - 0.5) * 100;
        const endY = y + (Math.random() - 0.5) * 100;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(endX, endY, { steps: 5 });
        await page.mouse.up();
      } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.waitForTimeout(1 + Math.random() * 10);
        await page.mouse.up();
      }

      actions++;
      await page.waitForTimeout(5 + Math.random() * 20);
    }

    console.log(`Chaos test completed: ${actions} actions in ${duration}ms`);

    // Verify no crashes
    await expect(canvas).toBeVisible();
    expect(errors).toHaveLength(0);
  });
});
