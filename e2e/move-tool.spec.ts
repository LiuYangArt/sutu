import { test, expect, type Page } from '@playwright/test';

async function getVisibleRenderDataUrl(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const gpu = document.querySelector('[data-testid="gpu-canvas"]') as HTMLCanvasElement | null;
    const main = document.querySelector('[data-testid="main-canvas"]') as HTMLCanvasElement | null;
    if (!main) return undefined;
    const source =
      gpu && window.getComputedStyle(gpu).display !== 'none' && gpu.width > 0 && gpu.height > 0
        ? gpu
        : main;
    return source.toDataURL('image/png');
  });
}

async function waitForAppReady(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('main-canvas')).toBeVisible({ timeout: 10000 });
}

async function prepareBlendMoveScene(page: Page): Promise<{ x: number; y: number }> {
  const canvas = page.getByTestId('main-canvas');
  const box = await canvas.boundingBox();
  if (!box) {
    test.skip();
    return { x: 0, y: 0 };
  }

  const newLayerBtn = page.getByTitle('New Layer').first();
  if (!(await newLayerBtn.isVisible().catch(() => false))) {
    test.skip();
    return { x: 0, y: 0 };
  }

  await page.evaluate(() => {
    const win = window as Window & { __canvasFillLayer?: (color: string) => void };
    win.__canvasFillLayer?.('#6a90c0');
  });
  await newLayerBtn.click();
  await page.evaluate(() => {
    const win = window as Window & { __canvasClearLayer?: () => void };
    win.__canvasClearLayer?.();
  });

  await page.keyboard.press('b');
  const startX = Math.round(box.x + box.width * 0.45);
  const startY = Math.round(box.y + box.height * 0.45);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 56, startY + 18, { steps: 6 });
  await page.mouse.up();

  const blendTrigger = page.locator('.blend-mode-trigger').first();
  if (await blendTrigger.isVisible().catch(() => false)) {
    await blendTrigger.click();
    await page.getByRole('option', { name: 'Multiply' }).click();
  }

  return { x: startX + 24, y: startY + 8 };
}

test.describe('Move Tool', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
  });

  test('large-canvas style drag gives immediate visible feedback', async ({ page }) => {
    const point = await prepareBlendMoveScene(page);
    await page.keyboard.press('v');

    const beforeDrag = await getVisibleRenderDataUrl(page);
    expect(beforeDrag).toBeTruthy();

    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 40, point.y + 20, { steps: 1 });

    await expect
      .poll(async () => {
        const current = await getVisibleRenderDataUrl(page);
        return !!beforeDrag && !!current && current !== beforeDrag;
      }, { timeout: 420 })
      .toBe(true);

    await page.mouse.up();
  });

  test('blend mode preview matches committed result while moving', async ({ page }) => {
    const point = await prepareBlendMoveScene(page);
    await page.keyboard.press('v');

    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 52, point.y + 24, { steps: 2 });
    await page.waitForTimeout(32);
    const draggingImage = await getVisibleRenderDataUrl(page);
    expect(draggingImage).toBeTruthy();

    await page.mouse.up();
    await page.waitForTimeout(96);
    const committedImage = await getVisibleRenderDataUrl(page);
    expect(committedImage).toBeTruthy();
    expect(committedImage).toBe(draggingImage);
  });

  test('continuous drag + undo/redo + tool-switch cancel keeps image stable', async ({ page }) => {
    const point = await prepareBlendMoveScene(page);
    await page.keyboard.press('v');

    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 36, point.y + 22, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(64);
    const movedImage = await getVisibleRenderDataUrl(page);
    expect(movedImage).toBeTruthy();

    const undoBtn = page.getByTestId('undo-btn');
    const redoBtn = page.getByTestId('redo-btn');
    if (!(await undoBtn.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    await undoBtn.click();
    await page.waitForTimeout(64);
    const undoImage = await getVisibleRenderDataUrl(page);
    expect(undoImage).toBeTruthy();
    expect(undoImage).not.toBe(movedImage);

    await redoBtn.click();
    await page.waitForTimeout(64);
    const redoImage = await getVisibleRenderDataUrl(page);
    expect(redoImage).toBe(movedImage);

    await page.keyboard.press('v');
    await page.mouse.move(point.x + 36, point.y + 22);
    await page.mouse.down();
    await page.mouse.move(point.x + 68, point.y + 38, { steps: 2 });
    await page.keyboard.press('b');
    await page.mouse.up();
    await page.waitForTimeout(64);

    const cancelImage = await getVisibleRenderDataUrl(page);
    expect(cancelImage).toBe(movedImage);
  });
});
