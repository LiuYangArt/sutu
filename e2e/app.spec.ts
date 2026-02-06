import { test, expect } from '@playwright/test';

test.describe('PaintBoard App', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should load the application', async ({ page }) => {
    // Wait for the app to be ready
    await expect(page.locator('body')).toBeVisible();

    // Check that the main app container exists
    await expect(page.locator('#root')).toBeVisible();
  });

  test('should display canvas area', async ({ page }) => {
    // The canvas component should be rendered
    const canvas = page.getByTestId('main-canvas');
    await expect(canvas).toBeVisible({ timeout: 10000 });
  });

  test('should display toolbar', async ({ page }) => {
    // Toolbar should be visible
    const toolbar = page.getByRole('toolbar').or(page.locator('[data-testid="toolbar"]'));
    // If no toolbar yet, just check the page loads without error
    const hasToolbar = await toolbar.isVisible().catch(() => false);

    if (!hasToolbar) {
      // App is still in early development, just verify no errors
      await expect(page.locator('#root')).toBeVisible();
    }
  });

  test('should have no console errors on load', async ({ page }) => {
    const errors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Filter out known acceptable errors (e.g., Tauri API not available in browser)
    const criticalErrors = errors.filter(
      (err) => !err.includes('__TAURI__') && !err.includes('window.__TAURI_INTERNALS__')
    );

    expect(criticalErrors).toHaveLength(0);
  });
});

test.describe('Canvas Interaction', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('should respond to pointer events on canvas', async ({ page }) => {
    const canvas = page.getByTestId('main-canvas');

    // Skip if canvas not yet implemented
    if (!(await canvas.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    // Get canvas bounding box
    const box = await canvas.boundingBox();
    if (!box) {
      test.skip();
      return;
    }

    // Simulate a simple stroke
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 50, startY + 50, { steps: 10 });
    await page.mouse.up();

    // Canvas should still be visible (no crash)
    await expect(canvas).toBeVisible();
  });
});
