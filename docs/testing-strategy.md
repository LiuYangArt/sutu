# 测试与验证策略

> 版本: 0.2.1 | 最后更新: 2026-02-10

> [!IMPORTANT]
> 当前绘画主链路是 GPU-First。测试策略以 `docs/design/done/2026-02-05-gpu-first-brush-design.md`（GPU-first 改造归档）为准：
> 1) 实时绘画不走 GPU→CPU readback；2) 导出/截图允许显式分块 readback；3) GPU 改动需通过 parity gate 与稳定性门禁。

## 1. 测试哲学

### 1.1 核心原则

对于长期 Vibe Coding 项目，测试策略的目标是：

1. **快速反馈** — 本地检查应在 30 秒内完成
2. **防止回归** — 核心功能必须有自动化保护
3. **GPU 主链路可信** — 实时绘画路径要有 no-readback 与 parity 门禁
4. **性能监控** — 延迟敏感的部分需要持续基准测试
5. **低维护成本** — 测试代码不应成为负担

### 1.2 测试金字塔

```
                    ┌─────────┐
                    │  E2E    │  ← 少量关键路径
                    │  Tests  │     (5-10 个)
                   ─┴─────────┴─
                  ┌─────────────┐
                  │ Integration │  ← IPC 通信、模块集成
                  │   Tests     │     (20-30 个)
                 ─┴─────────────┴─
                ┌─────────────────┐
                │   Unit Tests    │  ← 核心算法、工具函数
                │                 │     (100+ 个)
               ─┴─────────────────┴─
              ┌───────────────────────┐
              │   Static Analysis     │  ← TypeScript + Clippy
              │   (类型检查 + Lint)    │     (每次保存)
              └───────────────────────┘
```

---

## 2. 静态分析（第一道防线）

### 2.1 TypeScript 严格模式

```json
// tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

### 2.2 ESLint 规则

```javascript
// .eslintrc.cjs
module.exports = {
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  rules: {
    // 防止常见错误
    '@typescript-eslint/no-unused-vars': 'error',
    '@typescript-eslint/no-explicit-any': 'warn',
    'react-hooks/exhaustive-deps': 'error',

    // 代码风格
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
};
```

### 2.3 Rust Clippy 配置

```toml
# src-tauri/.clippy.toml 或 Cargo.toml
[lints.clippy]
# 严格检查
unwrap_used = "warn"
expect_used = "warn"
panic = "warn"

# 性能相关
inefficient_to_string = "warn"
large_enum_variant = "warn"

# 代码风格
module_name_repetitions = "allow"
```

---

## 3. 单元测试

### 3.1 Rust 单元测试

**测试重点**：
- 笔刷插值算法
- 压感曲线计算
- 文件格式解析

```rust
// src-tauri/src/brush/interpolation.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_catmull_rom_interpolation() {
        let points = vec![
            Point2D { x: 0.0, y: 0.0 },
            Point2D { x: 1.0, y: 1.0 },
            Point2D { x: 2.0, y: 0.0 },
            Point2D { x: 3.0, y: 1.0 },
        ];

        let result = interpolate_catmull_rom(&points, 0.5);

        // 中点应该在合理范围内
        assert!(result.x > 1.0 && result.x < 2.0);
        assert!(result.y > 0.0 && result.y < 1.0);
    }

    #[test]
    fn test_pressure_curve_linear() {
        let curve = PressureCurve::linear();

        assert_eq!(curve.apply(0.0), 0.0);
        assert_eq!(curve.apply(0.5), 0.5);
        assert_eq!(curve.apply(1.0), 1.0);
    }

    #[test]
    fn test_pressure_curve_soft() {
        let curve = PressureCurve::soft();

        // Soft 曲线在低压感时更敏感
        assert!(curve.apply(0.3) > 0.3);
        assert!(curve.apply(0.7) < 0.7);
    }
}
```

### 3.2 前端单元测试 (Vitest)

**测试重点**：
- 状态管理 (Zustand stores)
- 工具函数
- React Hooks

```typescript
// src/stores/__tests__/document.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useDocumentStore } from '../document';

describe('DocumentStore', () => {
  beforeEach(() => {
    useDocumentStore.getState().reset();
  });

  it('should add a new layer', () => {
    const store = useDocumentStore.getState();

    store.addLayer({ name: 'Layer 1', type: 'raster' });

    expect(store.layers).toHaveLength(1);
    expect(store.layers[0].name).toBe('Layer 1');
  });

  it('should set active layer', () => {
    const store = useDocumentStore.getState();
    store.addLayer({ name: 'Layer 1', type: 'raster' });
    const layerId = store.layers[0].id;

    store.setActiveLayer(layerId);

    expect(store.activeLayerId).toBe(layerId);
  });

  it('should reorder layers correctly', () => {
    const store = useDocumentStore.getState();
    store.addLayer({ name: 'Layer 1', type: 'raster' });
    store.addLayer({ name: 'Layer 2', type: 'raster' });
    const layer1Id = store.layers[0].id;
    const layer2Id = store.layers[1].id;

    store.moveLayer(layer2Id, 0);

    expect(store.layers[0].id).toBe(layer2Id);
    expect(store.layers[1].id).toBe(layer1Id);
  });
});
```

```typescript
// src/utils/__tests__/color.test.ts
import { describe, it, expect } from 'vitest';
import { rgbToHsl, hslToRgb, blendColors } from '../color';

describe('Color Utils', () => {
  it('should convert RGB to HSL correctly', () => {
    // Pure red
    expect(rgbToHsl(255, 0, 0)).toEqual({ h: 0, s: 100, l: 50 });

    // Pure green
    expect(rgbToHsl(0, 255, 0)).toEqual({ h: 120, s: 100, l: 50 });

    // White
    expect(rgbToHsl(255, 255, 255)).toEqual({ h: 0, s: 0, l: 100 });
  });

  it('should round-trip RGB -> HSL -> RGB', () => {
    const original = { r: 128, g: 64, b: 192 };
    const hsl = rgbToHsl(original.r, original.g, original.b);
    const result = hslToRgb(hsl.h, hsl.s, hsl.l);

    expect(result.r).toBeCloseTo(original.r, 0);
    expect(result.g).toBeCloseTo(original.g, 0);
    expect(result.b).toBeCloseTo(original.b, 0);
  });
});
```

---

## 4. 集成测试

### 4.1 Tauri IPC 测试

```rust
// src-tauri/src/commands.rs
#[cfg(test)]
mod tests {
    use tauri::test::{mock_builder, MockRuntime};
    use crate::commands::*;

    #[tokio::test]
    async fn test_create_document() {
        let app = mock_builder().build().unwrap();

        let result = create_document(
            app.handle(),
            1920,
            1080,
            72,
        ).await;

        assert!(result.is_ok());
        let doc = result.unwrap();
        assert_eq!(doc.width, 1920);
        assert_eq!(doc.height, 1080);
    }

    #[tokio::test]
    async fn test_brush_stroke_processing() {
        let app = mock_builder().build().unwrap();

        let input_points = vec![
            RawInputPoint { x: 0.0, y: 0.0, pressure: 0.5, .. },
            RawInputPoint { x: 10.0, y: 10.0, pressure: 0.7, .. },
            RawInputPoint { x: 20.0, y: 15.0, pressure: 0.8, .. },
        ];

        let result = process_stroke(app.handle(), input_points).await;

        assert!(result.is_ok());
        let segments = result.unwrap();
        assert!(!segments.is_empty());
    }
}
```

### 4.2 WebGPU 渲染测试（GPU-first）

```typescript
// src/gpu/layers/GpuStrokeCommitCoordinator.test.ts
import { describe, it, expect, vi } from 'vitest';
import { GpuStrokeCommitCoordinator } from './GpuStrokeCommitCoordinator';

describe('GpuStrokeCommitCoordinator', () => {
  it('accumulates readbackBypassedCount across multiple disabled commits', async () => {
    const coordinator = new GpuStrokeCommitCoordinator({
      gpuRenderer: {
        commitStroke: vi.fn(() => [{ x: 0, y: 0 }]),
        readbackTilesToLayer: vi.fn(async () => undefined),
      } as never,
      prepareStrokeEndGpu: vi.fn(async () => ({
        dirtyRect: { left: 0, top: 0, right: 10, bottom: 10 },
        strokeOpacity: 1,
        scratch: { texture: {} as GPUTexture, renderScale: 1 },
      })),
      clearScratchGpu: vi.fn(),
      getTargetLayer: vi.fn(
        () => ({ canvas: {} as HTMLCanvasElement, ctx: {} as CanvasRenderingContext2D }) as const
      ),
    });

    coordinator.setReadbackMode('disabled');
    await coordinator.commit('layer-1');
    await coordinator.commit('layer-1');

    const snapshot = coordinator.getCommitMetricsSnapshot();
    expect(snapshot.readbackMode).toBe('disabled');
    expect(snapshot.readbackBypassedCount).toBe(2);
  });
});
```

```typescript
// src/gpu/layers/exportReadback.test.ts
import { describe, expect, it } from 'vitest';
import { buildExportChunkRects, computeReadbackBytesPerRow } from './exportReadback';

describe('exportReadback', () => {
  it('builds chunk rects with edge clipping', () => {
    const rects = buildExportChunkRects(5000, 3000, 2048);
    expect(rects).toHaveLength(6);
  });

  it('aligns bytesPerRow for GPU readback requirements', () => {
    expect(computeReadbackBytesPerRow(65)).toBe(512);
  });
});
```

建议重点覆盖以下现有模块：
- `src/gpu/layers/GpuStrokeCommitCoordinator.test.ts`
- `src/gpu/layers/GpuStrokeHistoryStore.test.ts`
- `src/gpu/layers/layerStackCache.test.ts`
- `src/gpu/layers/dirtyTileClip.test.ts`
- `src/gpu/layers/exportReadback.test.ts`

### 4.3 GPU 一致性门禁（M4 Parity Gate）

在 GPU 笔刷特性（scatter/wet-edge/dual/texture/combo）变更时，必须执行 parity gate：

```typescript
// 浏览器控制台（开发模式）
const result = await window.__gpuM4ParityGate?.();
if (!result?.passed) {
  throw new Error(result?.report ?? 'M4 parity gate failed');
}
console.log(result.report);
```

手工前置条件：
1. 先准备或录制 `debug-stroke-capture` 数据。
2. 确保 `window.__gpuM4ParityGate` 可用（Canvas 全局导出已挂载）。
3. 结果至少包含：每个 case 的通过状态、阈值、最终 PASS/FAIL。

---

## 5. 端到端测试 (E2E)

### 5.1 Playwright 配置

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',

  use: {
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'pnpm dev:frontend',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
```

### 5.2 关键路径 E2E 测试

```typescript
// e2e/stroke-flicker.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Stroke Flicker Tests', () => {
  test('should not drop strokes in grid test (10x10)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const canvas = page.getByTestId('main-canvas');
    await canvas.waitFor({ state: 'visible', timeout: 10000 });
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    for (let i = 0; i < 100; i += 1) {
      const x = box.x + 50 + (i % 10) * 30;
      const y = box.y + 50 + Math.floor(i / 10) * 30;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.waitForTimeout(5);
      await page.mouse.up();
      await page.waitForTimeout(15);
    }

    await expect(canvas).toBeVisible();
  });
});
```

---

## 6. 性能测试

### 6.1 Rust 基准测试 (Criterion)

```rust
// src-tauri/benches/brush_benchmark.rs
use criterion::{criterion_group, criterion_main, Criterion, BenchmarkId};
use paintboard::brush::{BrushEngine, interpolate_points};

fn benchmark_interpolation(c: &mut Criterion) {
    let mut group = c.benchmark_group("Interpolation");

    for count in [10, 100, 500, 1000].iter() {
        let points: Vec<_> = (0..*count)
            .map(|i| Point2D {
                x: i as f32,
                y: (i as f32).sin() * 100.0
            })
            .collect();

        group.bench_with_input(
            BenchmarkId::new("catmull_rom", count),
            &points,
            |b, points| {
                b.iter(|| interpolate_points(points, 5))
            },
        );
    }

    group.finish();
}

fn benchmark_brush_engine(c: &mut Criterion) {
    let engine = BrushEngine::new();

    c.bench_function("process_stroke_100_points", |b| {
        let points = generate_test_stroke(100);
        b.iter(|| engine.process(&points))
    });

    c.bench_function("process_stroke_1000_points", |b| {
        let points = generate_test_stroke(1000);
        b.iter(|| engine.process(&points))
    });
}

criterion_group!(benches, benchmark_interpolation, benchmark_brush_engine);
criterion_main!(benches);
```

### 6.2 前端性能监控

```typescript
// src/utils/performance.ts
export class PerformanceMonitor {
  private frameTimings: number[] = [];
  private readonly maxSamples = 120;

  recordFrame(startTime: number): void {
    const duration = performance.now() - startTime;
    this.frameTimings.push(duration);

    if (this.frameTimings.length > this.maxSamples) {
      this.frameTimings.shift();
    }
  }

  getAverageFrameTime(): number {
    if (this.frameTimings.length === 0) return 0;
    return this.frameTimings.reduce((a, b) => a + b, 0) / this.frameTimings.length;
  }

  getP95FrameTime(): number {
    if (this.frameTimings.length === 0) return 0;
    const sorted = [...this.frameTimings].sort((a, b) => a - b);
    const index = Math.floor(sorted.length * 0.95);
    return sorted[index];
  }

  getFPS(): number {
    const avgTime = this.getAverageFrameTime();
    return avgTime > 0 ? 1000 / avgTime : 0;
  }

  // 用于开发时的性能警告
  checkThresholds(): void {
    const p95 = this.getP95FrameTime();
    if (p95 > 16.67) { // 低于 60fps
      console.warn(`Performance degradation: P95 frame time ${p95.toFixed(2)}ms`);
    }
  }
}

// 使用示例
const monitor = new PerformanceMonitor();

function renderLoop() {
  const start = performance.now();

  // 渲染逻辑...

  monitor.recordFrame(start);
  requestAnimationFrame(renderLoop);
}
```

### 6.3 实时链路指标采集（no-readback 门禁）

```typescript
// 浏览器控制台（开发模式）
window.__gpuBrushCommitMetricsReset?.();
window.__gpuBrushCommitReadbackModeSet?.('disabled');
// 手动画 20~50 笔后执行：
const snapshot = window.__gpuBrushCommitMetrics?.();
console.log(snapshot);

if (!snapshot) throw new Error('Missing commit metrics snapshot');
if (snapshot.readbackMode !== 'disabled') throw new Error('readback mode is not disabled');
if (snapshot.readbackBypassedCount <= 0) throw new Error('readback was not bypassed');
if (snapshot.avgReadbackMs > 2) throw new Error(`readback regression: ${snapshot.avgReadbackMs}ms`);
```

### 6.4 Texture Each Tip=Off 回归检查

当涉及 Texture 混合模式（特别是 `darken / colorBurn / linearBurn`）改动时，额外执行以下回归：

1. 固定同一笔刷与纹理，关闭 `Texture Each Tip`。
2. 使用同一条长笔触，分别切换 `darken / colorBurn / linearBurn`，观察是否出现串珠（dab）感。
3. 开启 `Texture Each Tip` 后重复一次，确认仅语义切换，不出现异常闪烁或断裂。
4. GPU 与 CPU fallback 各跑一轮，确保两条链路趋势一致。

建议记录产物：

1. 参数截图（Scale/Brightness/Contrast/Depth/Invert/Texture Each Tip）。
2. 三个模式的画布截图（至少各 1 张）。
3. 如有脚本对比，附 `report.json` 和 diff 图。

---

## 7. CI/CD 质量门禁

### 7.1 GitHub Actions 工作流

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

env:
  CARGO_TERM_COLOR: always
  RUST_BACKTRACE: 1

jobs:
  # 静态分析
  lint:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: TypeScript check
        run: pnpm typecheck

      - name: ESLint
        run: pnpm lint

      - name: Rust format check
        run: cargo fmt --manifest-path src-tauri/Cargo.toml -- --check

      - name: Clippy
        run: cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

  # 单元测试
  test:
    runs-on: windows-latest
    needs: lint
    steps:
      - uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run frontend tests
        run: pnpm test -- --coverage

      - name: Run Rust tests
        run: cargo test --manifest-path src-tauri/Cargo.toml --all-features

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: ./coverage/lcov.info

  # 构建验证
  build:
    runs-on: windows-latest
    needs: test
    steps:
      - uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build

      - name: Upload build artifacts
        uses: actions/upload-artifact@v4
        with:
          name: build-artifacts
          path: src-tauri/target/release/bundle/

  # 性能基准（仅 main 分支）
  benchmark:
    runs-on: windows-latest
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    needs: build
    steps:
      - uses: actions/checkout@v4

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Run benchmarks
        run: cargo bench --manifest-path src-tauri/Cargo.toml -- --save-baseline main

      - name: Upload benchmark results
        uses: actions/upload-artifact@v4
        with:
          name: benchmark-results
          path: src-tauri/target/criterion/
          retention-days: 30
```

### 7.2 质量门禁标准

| 检查项 | 阈值 | 阻断级别 |
|--------|------|----------|
| TypeScript 类型错误 | 0 | 🚫 阻断合并 |
| ESLint 错误 | 0 | 🚫 阻断合并 |
| Clippy 警告 | 0 | 🚫 阻断合并 |
| 单元测试通过率 | 100% | 🚫 阻断合并 |
| 代码覆盖率 | ≥ 60% | ⚠️ 警告 |
| 构建成功 | 必须 | 🚫 阻断合并 |
| 性能回归 | < 10% | ⚠️ 警告 |
| GPU M4 parity gate | PASS（涉及 GPU 笔刷变更时） | ⚠️ 警告 |
| no-readback 门禁 | `readbackBypassedCount > 0`（disabled 模式） | ⚠️ 警告 |

---

## 8. 本地快速检查

### 8.1 本地一键检查命令

```bash
pnpm typecheck
pnpm lint
pnpm lint:rust
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml --all-features
# 可选：端到端
pnpm test:e2e
```

### 8.2 VSCode 任务

```json
// .vscode/tasks.json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Quick Check",
      "type": "shell",
      "command": "pnpm check:all",
      "problemMatcher": ["$tsc", "$eslint-stylish"],
      "group": {
        "kind": "test",
        "isDefault": true
      }
    },
    {
      "label": "Run Tests",
      "type": "shell",
      "command": "pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --all-features",
      "problemMatcher": []
    }
  ]
}
```

---

## 9. 测试覆盖率目标

| 模块 | 覆盖率目标 | 原因 |
|------|------------|------|
| `brush/` (Rust) | ≥ 80% | 核心算法，必须正确 |
| `input/` (Rust) | ≥ 70% | 涉及硬件，部分需要真机测试 |
| `stores/` (TS) | ≥ 90% | 状态管理是 bug 高发区 |
| `utils/` (TS) | ≥ 85% | 工具函数应该简单可测 |
| `gpu/` (TS) | ≥ 50% | GPU 代码难以自动化测试 |
| `components/` (TS) | ≥ 40% | UI 组件优先用 E2E 测试 |

---

## 10. Move Tool V 专项回归矩阵（2026-02-10）

### 10.1 覆盖目标

| 目标 | 自动化用例 | 关注点 |
|------|-----------|--------|
| 拖动首帧反馈不被历史快照阻塞 | `src/components/Canvas/__tests__/useMoveTool.test.ts` | `pointerdown -> preview` 可立即触发；`saveStrokeToHistory` 必须等待 `captureBeforeImage` 完成 |
| 混合模式下拖动预览与落盘一致 | `src/utils/__tests__/layerRenderer.movePreviewBlend.test.ts` | `normal/multiply/screen/overlay` 下，move preview 像素结果与真实提交后结果一致 |
| GPU movePreview 主路径调用顺序正确 | `src/components/Canvas/__tests__/movePreviewGpuSync.test.ts` | `syncLayerTilesFromCanvas -> render` 顺序稳定；结束拖动后可恢复 authoritative tiles |
| 端到端交互稳定性 | `e2e/move-tool.spec.ts` | 首帧可见位移、混合预览与提交一致、undo/redo 与切工具取消无残影 |

### 10.2 推荐回归命令

```bash
# 逻辑与渲染专项
pnpm -s vitest src/components/Canvas/__tests__/useMoveTool.test.ts src/components/Canvas/__tests__/movePreviewGpuSync.test.ts src/utils/__tests__/layerRenderer.movePreviewBlend.test.ts --run

# 端到端专项
pnpm -s playwright test e2e/move-tool.spec.ts
```

---

## 11. 总结：Vibe Coding 的测试平衡

**核心原则**：测试应该帮助你更快地 Vibe，而不是成为负担。

| 场景 | 推荐做法 |
|------|----------|
| 新功能探索 | 先跳过测试，快速验证想法 |
| 功能稳定后 | 补充关键路径测试 |
| 核心算法 | 必须有单元测试 |
| UI 组件 | E2E 覆盖即可 |
| 重构时 | 先写测试，再改代码 |

**自动化程度**：
- ✅ 静态分析：每次保存自动运行
- ✅ 单元测试：每次提交前运行
- ✅ E2E 测试：每次 PR 运行
- ✅ 性能基准：每次合并到 main 运行
