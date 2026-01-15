# 抬笔闪烁问题：自动化测试与验证方案

> **日期**: 2026-01-15
> **状态**: ✅ 已完成
> **优先级**: P1
> **关联**:
>
> - [stroke-end-flicker-fix-plan.md](./stroke-end-flicker-fix-plan.md) - 问题修复计划
> - [stroke-end-flicker.md](../postmortem/stroke-end-flicker.md) - 问题总结

## 结论

该工具集将为后续彻底修复笔触闪烁问题提供坚实的验证基础。通过 Debug 面板，开发者可以在数位板上观察到每一笔的详细遥测数据，结合自动化 E2E 测试，可以确保修复方案不会引入新的回归。

**验证结果 (2026-01-15):**

- 5/5 E2E 测试用例通过。
- 遥测系统成功通过 `any` 类型修复进入 `Canvas.tsx`。
- 快捷键 `Shift+Ctrl+D` 响应正常。

---

## 背景

### 问题现状

Phase 2.7 状态机 + 输入缓冲已解决大部分抬笔闪烁问题，但**极端偶发情况**仍存在：

| 现象       | 频率   | 可能原因                             |
| ---------- | ------ | ------------------------------------ |
| 笔触闪一下 | 极偶尔 | GPU readback 延迟、浏览器 Paint 交错 |
| 方块残留   | 极偶尔 | previewCanvas 数据不完整             |
| 笔触丢失   | 极偶尔 | 状态机边缘情况                       |

### 验证困境

- **手动测试不可靠**：无法保证压感、时序一致性
- **偶发性**：问题难以复现，靠肉眼观察主观且低效
- **缺乏确定性指标**：无法量化"闪烁"

---

## 设计目标

1. **自动化**：脚本模拟输入，绕过硬件不确定性
2. **确定性**：建立可量化的丢笔/闪烁检测指标
3. **可重复**：测试可在 CI/CD 中执行
4. **零干扰**：测试代码不影响被测系统行为

---

## 测试入口

### 方式 1：批处理入口 (推荐)

双击运行 `.dev/test.bat`，选择测试类型：

```
  ============================================
       PaintBoard Test Runner
  ============================================

  [1] unit           Run unit tests (Vitest)
  [2] e2e            Run E2E tests (Playwright)
  [3] visual         Open GPU/CPU comparison page
  [4] all            Run all automated tests
  [5] e2e:flicker    Run flicker stress tests
  [6] e2e:headed     Run E2E with browser visible
  [0] exit           Exit
```

### 方式 2：Debug 快捷键

在主应用中按 `Shift + Ctrl + D` 打开 Debug 面板，可直接在当前画布运行压力测试。

> [!NOTE]
> Debug 面板仅在开发模式 (`pnpm dev`) 下可用。

---

## 核心设计原则

> [!CAUTION]
> **观察者效应警告**：实时使用 `getImageData()` 会强制 GPU Pipeline Flush，人为同步渲染流程，可能**掩盖**竞态 Bug。

### 修正后的验证策略

| 问题类型 | 检测方法                  | 时机       |
| -------- | ------------------------- | ---------- |
| 笔触丢失 | 网格法 + 事后像素验证     | 测试结束后 |
| 闪烁     | 状态机遥测（逻辑埋点）    | 运行中     |
| 视觉回归 | Playwright trace 视频录制 | 事后回放   |

---

## 验证方案

### 第一层：确定性输入模拟器（Robot Hand）

> **核心思想**：用脚本模拟"完美的一击"和"极速的乱击"，绕过硬件不确定性。

#### 1.1 输入模拟器

创建 `src/test/InputSimulator.ts`：

```typescript
/**
 * 模拟指针事件，用于自动化测试
 * 与 requestAnimationFrame 对齐，模拟真实帧率
 */
export class InputSimulator {
  private canvas: HTMLCanvasElement;
  private pointerId = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  /**
   * 模拟单次点击
   */
  async tap(
    x: number,
    y: number,
    options: {
      pressure?: number;
      durationMs?: number;
      pointerType?: 'pen' | 'mouse';
    } = {}
  ): Promise<void> {
    const { pressure = 0.5, durationMs = 10, pointerType = 'pen' } = options;

    this.canvas.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: this.pointerId,
        bubbles: true,
        clientX: x,
        clientY: y,
        pressure,
        pointerType,
      })
    );

    await this.waitFrame(durationMs);

    this.canvas.dispatchEvent(
      new PointerEvent('pointerup', {
        pointerId: this.pointerId,
        bubbles: true,
        clientX: x,
        clientY: y,
        pressure: 0,
        pointerType,
      })
    );
  }

  /**
   * 网格点击测试（确定性验证）
   * @param rows 行数
   * @param cols 列数
   * @param spacing 点间距
   * @returns 预期点位数组
   */
  async drawGrid(
    rows: number,
    cols: number,
    spacing: number,
    options: { startX?: number; startY?: number; intervalMs?: number } = {}
  ): Promise<Array<{ x: number; y: number }>> {
    const { startX = 50, startY = 50, intervalMs = 20 } = options;
    const points: Array<{ x: number; y: number }> = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = startX + c * spacing;
        const y = startY + r * spacing;
        points.push({ x, y });

        await this.tap(x, y, { pressure: 0.6, durationMs: 5 });
        await this.waitFrame(intervalMs);
      }
    }

    return points;
  }

  /**
   * 与 requestAnimationFrame 对齐的等待
   */
  private waitFrame(minMs: number): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now();
      const check = () => {
        if (performance.now() - start >= minMs) {
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      };
      requestAnimationFrame(check);
    });
  }
}
```

---

### 第二层：事后验证器（Grid Verifier）

> **核心思想**：测试结束后一次性 `getImageData`，验证预期点位是否有像素。

#### 2.1 网格验证器

创建 `src/test/GridVerifier.ts`：

```typescript
export interface VerificationResult {
  total: number;
  found: number;
  missing: Array<{ x: number; y: number }>;
  passed: boolean;
}

/**
 * 验证画布上的预期点位是否都有像素
 * 在测试完成后调用，避免干扰渲染
 */
export async function verifyGrid(
  canvas: HTMLCanvasElement,
  expectedPoints: Array<{ x: number; y: number }>,
  options: { threshold?: number; sampleRadius?: number } = {}
): Promise<VerificationResult> {
  const { threshold = 10, sampleRadius = 3 } = options;

  // 等待渲染完全空闲
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r)); // 双帧保证

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Cannot get canvas context');

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const missing: Array<{ x: number; y: number }> = [];

  for (const pt of expectedPoints) {
    // 在采样半径内检查是否有非透明像素
    const hasPixel = checkPixelArea(imgData, pt.x, pt.y, sampleRadius, threshold);
    if (!hasPixel) {
      missing.push(pt);
    }
  }

  return {
    total: expectedPoints.length,
    found: expectedPoints.length - missing.length,
    missing,
    passed: missing.length === 0,
  };
}

function checkPixelArea(
  imgData: ImageData,
  centerX: number,
  centerY: number,
  radius: number,
  threshold: number
): boolean {
  const { width, height, data } = imgData;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = Math.round(centerX) + dx;
      const y = Math.round(centerY) + dy;

      if (x < 0 || x >= width || y < 0 || y >= height) continue;

      const i = (y * width + x) * 4;
      const alpha = data[i + 3];

      if (alpha > threshold) {
        return true; // 找到非透明像素
      }
    }
  }

  return false;
}
```

---

### 第三层：状态机遥测（Internal Telemetry）

> **核心思想**：闪烁本质是状态机异常，用逻辑埋点检测"产生闪烁的条件"。

#### 3.1 诊断钩子

创建 `src/test/DiagnosticHooks.ts`：

```typescript
export interface StrokeTelemetry {
  strokeId: number;
  startTime: number;
  endTime?: number;
  state: 'starting' | 'active' | 'finishing' | 'completed' | 'error';
  bufferedPoints: number;
  droppedPoints: number;
  startingDuration?: number; // starting 状态持续时间
}

export interface DiagnosticHooks {
  strokes: StrokeTelemetry[];
  currentStroke: StrokeTelemetry | null;
  anomalies: Array<{
    type: 'long_starting' | 'buffer_cleared' | 'premature_end';
    strokeId: number;
    timestamp: number;
    details: string;
  }>;
  cleanup: () => void;
}

export function installDiagnosticHooks(): DiagnosticHooks {
  let strokeCounter = 0;

  const hooks: DiagnosticHooks = {
    strokes: [],
    currentStroke: null,
    anomalies: [],
    cleanup: () => {},
  };

  // 挂载到 window 供 Canvas 组件调用
  const win = window as Window & { __strokeDiagnostics?: DiagnosticHooks };
  win.__strokeDiagnostics = hooks;

  // 提供给 Canvas 组件调用的 API
  win.__strokeDiagnostics.onStrokeStart = () => {
    const stroke: StrokeTelemetry = {
      strokeId: ++strokeCounter,
      startTime: performance.now(),
      state: 'starting',
      bufferedPoints: 0,
      droppedPoints: 0,
    };
    hooks.currentStroke = stroke;
    hooks.strokes.push(stroke);
  };

  win.__strokeDiagnostics.onStateChange = (newState: string) => {
    if (!hooks.currentStroke) return;

    const stroke = hooks.currentStroke;
    const prevState = stroke.state;
    stroke.state = newState as StrokeTelemetry['state'];

    // 检测异常：starting 状态超过 100ms
    if (prevState === 'starting' && newState === 'active') {
      stroke.startingDuration = performance.now() - stroke.startTime;
      if (stroke.startingDuration > 100) {
        hooks.anomalies.push({
          type: 'long_starting',
          strokeId: stroke.strokeId,
          timestamp: performance.now(),
          details: `Starting 状态持续 ${stroke.startingDuration.toFixed(0)}ms`,
        });
      }
    }
  };

  win.__strokeDiagnostics.onPointBuffered = () => {
    if (hooks.currentStroke) hooks.currentStroke.bufferedPoints++;
  };

  win.__strokeDiagnostics.onPointDropped = () => {
    if (hooks.currentStroke) hooks.currentStroke.droppedPoints++;
  };

  win.__strokeDiagnostics.onStrokeEnd = () => {
    if (hooks.currentStroke) {
      hooks.currentStroke.endTime = performance.now();
      hooks.currentStroke.state = 'completed';
      hooks.currentStroke = null;
    }
  };

  hooks.cleanup = () => {
    delete win.__strokeDiagnostics;
  };

  return hooks;
}

export function getTestReport(hooks: DiagnosticHooks): string {
  const completed = hooks.strokes.filter((s) => s.state === 'completed').length;
  const dropped = hooks.strokes.reduce((sum, s) => sum + s.droppedPoints, 0);
  const avgStarting =
    hooks.strokes
      .filter((s) => s.startingDuration !== undefined)
      .reduce((sum, s) => sum + (s.startingDuration ?? 0), 0) / hooks.strokes.length || 0;

  return `
=== Stroke Test Report ===
Total Strokes: ${hooks.strokes.length}
Completed: ${completed}
Dropped Points: ${dropped}
Avg Starting Duration: ${avgStarting.toFixed(1)}ms
Anomalies: ${hooks.anomalies.length}
${hooks.anomalies.map((a) => `  - [${a.type}] ${a.details}`).join('\n')}
`;
}
```

---

### 第四层：E2E 测试（Playwright）

> **核心思想**：真实浏览器环境 + trace 视频录制。

#### 4.1 网格验证测试

创建 `e2e/stroke-flicker.spec.ts`：

```typescript
import { test, expect } from '@playwright/test';

test.describe('Stroke Reliability Tests', () => {
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

    // 绘制网格
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

    // 等待渲染完成
    await page.waitForTimeout(500);

    // 事后验证：检查每个点位是否有像素
    const result = await page.evaluate(
      ({ points, boxX, boxY }) => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return { passed: false, missing: points.length };

        const ctx = canvas.getContext('2d');
        if (!ctx) return { passed: false, missing: points.length };

        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let missing = 0;

        for (const pt of points) {
          // 转换为画布坐标
          const canvasX = Math.round(pt.x - boxX);
          const canvasY = Math.round(pt.y - boxY);

          // 检查 5x5 区域
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

        return { passed: missing === 0, missing, total: points.length };
      },
      { points, boxX: box.x, boxY: box.y }
    );

    console.log(`Grid Test: ${result.total - result.missing}/${result.total} points found`);
    expect(result.passed).toBe(true);
  });

  test('should handle rapid taps (100x) without crash', async ({ page }) => {
    const canvas = page.locator('canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    // 极速点击
    for (let i = 0; i < 100; i++) {
      const x = box.x + 50 + (i % 20) * 15;
      const y = box.y + 100 + Math.floor(i / 20) * 30;

      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.waitForTimeout(1); // 极短
      await page.mouse.up();
      await page.waitForTimeout(5); // 极短间隔
    }

    // 验证无崩溃
    await expect(canvas).toBeVisible();
  });
});
```

#### 4.2 启用 Trace 录制

在 `playwright.config.ts` 中启用 trace：

```typescript
export default defineConfig({
  use: {
    trace: 'on-first-retry', // 失败时录制视频
    video: 'on-first-retry',
  },
});
```

---

### 第五层：混沌测试（Chaos Monkey）

> **核心思想**：随机输入，验证程序健壮性。

```typescript
// src/test/ChaosTest.ts

export async function chaosClicker(
  canvas: HTMLCanvasElement,
  duration: number = 5000
): Promise<{ clicks: number; errors: number }> {
  const simulator = new InputSimulator(canvas);
  const startTime = performance.now();
  let clicks = 0;
  let errors = 0;

  while (performance.now() - startTime < duration) {
    try {
      const x = Math.random() * canvas.width;
      const y = Math.random() * canvas.height;
      const pressure = 0.1 + Math.random() * 0.9;
      const interval = 1 + Math.random() * 50; // 1-50ms 随机间隔

      await simulator.tap(x, y, { pressure, durationMs: Math.random() * 20 });
      await new Promise((r) => setTimeout(r, interval));
      clicks++;
    } catch (e) {
      errors++;
      console.error('Chaos test error:', e);
    }
  }

  return { clicks, errors };
}
```

---

## 通过标准

| 测试项           | 通过标准                         |
| ---------------- | -------------------------------- |
| 网格测试 (10x10) | missing = 0 (100 个点全部画出)   |
| 极速点击 (100x)  | 无崩溃，无控制台错误             |
| 状态机遥测       | anomalies = 0, droppedPoints = 0 |
| 混沌测试 (5s)    | errors = 0                       |
| Playwright trace | 视频回放无可见闪烁               |

---

## 实施计划

> [!NOTE]
> 方案已根据 [review.md](./review.md) 优化，移除实时 `getImageData` 检测。

### Phase 1: 基础设施 (预计 1.5 小时) ✅

- [x] 创建 `src/test/InputSimulator.ts` - 输入模拟器（含网格模式）
- [x] 创建 `src/test/GridVerifier.ts` - 事后像素验证器
- [x] 创建 `src/test/DiagnosticHooks.ts` - 状态机遥测

### Phase 2: E2E 测试 (预计 1 小时) ✅

- [x] 创建 `e2e/stroke-flicker.spec.ts` - 网格验证 + 极速点击
- [x] 配置 Playwright trace 录制
- [x] 验证 CI 中可运行（本地测试通过 5/5）

### Phase 3: Debug 面板 (预计 1 小时) ✅

- [x] 创建 `src/components/DebugPanel/index.tsx`
- [x] 添加快捷键 `Shift + Ctrl + D`
- [x] 集成网格测试和混沌测试

### Phase 4: 集成诊断钩子 (预计 0.5 小时) ✅

- [x] 将 `window.__strokeDiagnostics` 集成到 `Canvas.tsx`
- [x] 验证遥测数据准确性

---

## 关键文件

| 文件                          | 用途           |
| ----------------------------- | -------------- |
| `src/test/InputSimulator.ts`  | 输入模拟器     |
| `src/test/GridVerifier.ts`    | 事后像素验证器 |
| `src/test/DiagnosticHooks.ts` | 状态机遥测     |
| `src/test/ChaosTest.ts`       | 混沌测试       |
| `e2e/stroke-flicker.spec.ts`  | E2E 测试       |

---

## 参考

- [stroke-end-flicker-fix-plan.md](./stroke-end-flicker-fix-plan.md) - 修复计划
- [review.md](./review.md) - 验证方案 Review
- [stroke-end-flicker.md](../postmortem/stroke-end-flicker.md) - 问题总结
