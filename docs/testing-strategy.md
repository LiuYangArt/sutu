# 测试与验证策略

> 版本: 0.1.0 | 最后更新: 2026-01-11

## 1. 测试哲学

### 1.1 核心原则

对于长期 Vibe Coding 项目，测试策略的目标是：

1. **快速反馈** — 本地检查应在 30 秒内完成
2. **防止回归** — 核心功能必须有自动化保护
3. **低维护成本** — 测试代码不应成为负担
4. **性能监控** — 延迟敏感的部分需要持续基准测试

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
// src-tauri/tests/integration/commands.rs
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

### 4.2 WebGPU 渲染测试

```typescript
// src/gpu/__tests__/renderer.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { CanvasRenderer } from '../renderer';

describe('CanvasRenderer', () => {
  let renderer: CanvasRenderer;

  beforeAll(async () => {
    // 使用 headless WebGPU (如果可用) 或 mock
    if (!navigator.gpu) {
      console.warn('WebGPU not available, skipping GPU tests');
      return;
    }

    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter!.requestDevice();
    renderer = new CanvasRenderer(device);
  });

  it('should create a texture of specified size', async () => {
    if (!renderer) return;

    const texture = renderer.createLayerTexture(1024, 1024);

    expect(texture.width).toBe(1024);
    expect(texture.height).toBe(1024);
    expect(texture.format).toBe('rgba8unorm');
  });

  it('should composite layers in correct order', async () => {
    if (!renderer) return;

    const layer1 = renderer.createLayerTexture(100, 100);
    const layer2 = renderer.createLayerTexture(100, 100);

    // 填充测试数据...

    const result = renderer.compositeLayers([layer1, layer2]);

    // 验证合成结果...
    expect(result).toBeDefined();
  });
});
```

---

## 5. 端到端测试 (E2E)

### 5.1 Playwright 配置

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: 1,

  use: {
    headless: true,
    viewport: { width: 1920, height: 1080 },
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'Tauri App',
      use: {
        // Tauri 测试需要特殊配置
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
```

### 5.2 关键路径 E2E 测试

```typescript
// tests/e2e/critical-path.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Critical User Journeys', () => {
  test('create document and draw a stroke', async ({ page }) => {
    await page.goto('/');

    // 创建新文档
    await page.click('[data-testid="new-document-btn"]');
    await page.fill('[data-testid="width-input"]', '1920');
    await page.fill('[data-testid="height-input"]', '1080');
    await page.click('[data-testid="create-btn"]');

    // 验证画布出现
    const canvas = page.locator('[data-testid="main-canvas"]');
    await expect(canvas).toBeVisible();

    // 模拟绘制（用鼠标模拟，压感测试需要真实设备）
    await canvas.hover({ position: { x: 100, y: 100 } });
    await page.mouse.down();
    await page.mouse.move(200, 200, { steps: 10 });
    await page.mouse.up();

    // 验证图层有内容（通过检查 undo 按钮可用）
    await expect(page.locator('[data-testid="undo-btn"]')).toBeEnabled();
  });

  test('save and load document', async ({ page }) => {
    await page.goto('/');

    // 创建并保存
    await page.click('[data-testid="new-document-btn"]');
    await page.click('[data-testid="create-btn"]');

    // 绘制一些内容
    const canvas = page.locator('[data-testid="main-canvas"]');
    await canvas.click({ position: { x: 500, y: 500 } });

    // 保存
    await page.keyboard.press('Control+S');
    await page.fill('[data-testid="filename-input"]', 'test-document');
    await page.click('[data-testid="save-btn"]');

    // 关闭并重新打开
    await page.click('[data-testid="close-document-btn"]');
    await page.click('[data-testid="open-document-btn"]');
    await page.click('text=test-document.pbp');

    // 验证内容恢复
    await expect(canvas).toBeVisible();
    await expect(page.locator('[data-testid="undo-btn"]')).toBeEnabled();
  });

  test('layer operations', async ({ page }) => {
    await page.goto('/');
    await page.click('[data-testid="new-document-btn"]');
    await page.click('[data-testid="create-btn"]');

    // 添加图层
    await page.click('[data-testid="add-layer-btn"]');
    await expect(page.locator('[data-testid="layer-item"]')).toHaveCount(2);

    // 重命名图层
    await page.dblclick('[data-testid="layer-item"]:first-child');
    await page.fill('[data-testid="layer-name-input"]', 'My Layer');
    await page.keyboard.press('Enter');
    await expect(page.locator('text=My Layer')).toBeVisible();

    // 切换可见性
    await page.click('[data-testid="layer-visibility-toggle"]:first-child');
    // 验证图层内容隐藏（需要视觉检查或像素比较）
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

### 6.3 延迟测试脚本

```typescript
// tests/performance/latency.test.ts
import { describe, it, expect } from 'vitest';

describe('Input Latency', () => {
  it('should process input within 12ms budget', async () => {
    const samples: number[] = [];

    for (let i = 0; i < 100; i++) {
      const inputTime = performance.now();

      // 模拟输入处理
      await simulateInputProcessing({
        x: Math.random() * 1000,
        y: Math.random() * 1000,
        pressure: Math.random(),
      });

      const renderTime = performance.now();
      samples.push(renderTime - inputTime);
    }

    const average = samples.reduce((a, b) => a + b, 0) / samples.length;
    const p95 = samples.sort((a, b) => a - b)[Math.floor(samples.length * 0.95)];

    console.log(`Average latency: ${average.toFixed(2)}ms`);
    console.log(`P95 latency: ${p95.toFixed(2)}ms`);

    expect(average).toBeLessThan(8);   // 平均 < 8ms
    expect(p95).toBeLessThan(12);      // P95 < 12ms
  });
});
```

---

## 7. CI/CD 质量门禁

### 7.1 GitHub Actions 工作流

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  CARGO_TERM_COLOR: always

jobs:
  # 静态分析
  lint:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

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
        run: pnpm install

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

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Install dependencies
        run: pnpm install

      - name: Run frontend tests
        run: pnpm test

      - name: Run Rust tests
        run: cargo test --manifest-path src-tauri/Cargo.toml

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info

  # 构建验证
  build:
    runs-on: windows-latest
    needs: test
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Install dependencies
        run: pnpm install

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
    if: github.ref == 'refs/heads/main'
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

---

## 8. 本地快速检查

### 8.1 一键检查脚本

```bash
# scripts/check.sh (Windows: scripts/check.ps1)
#!/bin/bash
set -e

echo "🔍 Running type check..."
pnpm typecheck

echo "🔍 Running ESLint..."
pnpm lint

echo "🔍 Running Clippy..."
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

echo "🧪 Running tests..."
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml

echo "✅ All checks passed!"
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
      "command": "pnpm test && cargo test --manifest-path src-tauri/Cargo.toml",
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

## 10. 总结：Vibe Coding 的测试平衡

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
