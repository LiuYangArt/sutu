# GPU 笔刷渲染问题总结

> **日期**: 2026-01-14
> **状态**: 进行中
> **目标**: 解决大笔刷（500px+）CPU 性能瓶颈，同时保持视觉与 CPU 版本完全一致

---

## 背景与现状

### 实现方案

采用 **WebGPU Render Pipeline + GPU Instancing** 方案加速软笔刷渲染：

- 使用 Ping-Pong Buffer 避免 WebGPU 读写冲突
- Alpha Darken 混合在 Fragment Shader 中实现
- GPU Instancing 批量渲染多个 dab

### 目标达成情况

| 目标                           | 状态          | 说明                                     |
| ------------------------------ | ------------- | ---------------------------------------- |
| 大笔刷性能提升                 | ✅ **已达成** | 用户确认大笔触（500px+）性能明显优于 CPU |
| 视觉效果与 CPU 一致            | ❌ **未达成** | 多个算法差异导致视觉缺陷                 |
| WYSIWYG（Preview = Composite） | ❌ **未达成** | 抬笔时有闪烁                             |

---

## 发现的问题

### 问题 1：Gaussian 曲线计算错误

**现象**

- 软笔刷（hardness < 100）边缘过渡不柔和
- 与 CPU 版本相比，笔触形状有明显差异

**根因**
`distfactor` 计算缺少对 `radiusX`（`dab_size`）的归一化。

**CPU 版本** (`src/utils/maskCache.ts:171`):

```javascript
const distfactor = (SQRT_2 * 12500.0) / (6761.0 * safeFade * radiusX);
const physicalDist = normDist * radiusX;
const scaledDist = physicalDist * distfactor;
```

**GPU 版本** (`src/gpu/shaders/brush.wgsl:147`):

```wgsl
let distfactor = (SQRT_2 * 12500.0) / (6761.0 * safe_fade);  // ❌ 缺少 * dab_size
let scaled_dist = dist * distfactor;  // dist 是归一化距离 0-1
```

**修复方案**

```wgsl
let distfactor = (SQRT_2 * 12500.0) / (6761.0 * safe_fade * in.dab_size);
```

---

### 问题 2：白色圆圈边缘线

**现象**

- 快速绘画时出现白色圆圈边缘线
- 特别是在深色背景上画浅色笔触时明显

**根因分析**

- GPU 纹理初始化为 `rgba(0, 0, 0, 0)`
- 当 `dst_a > 0.001` 但 `dst.rgb = (0, 0, 0)` 时
- 颜色混合公式：`dst.rgb + (in.color - dst.rgb) * src_alpha`
- 可能是 Ping-Pong Buffer 的 `copySourceToDest()` 或 Alpha Darken 逻辑问题

**待验证**

1. 检查 `PingPongBuffer.clear()` 是否正确清空
2. 检查颜色混合逻辑是否处理了 `dst` 为未初始化状态

---

### 问题 3：画完一笔闪烁

**现象**

- 抬笔时画面闪烁一下
- Preview 和 Composite 结果不一致

**根因**
Preview 和 Composite 使用不同的数据路径：

```
Preview 路径：GPU Texture → 异步 readback → previewCanvas → 显示
Composite 路径：GPU Texture → 同步 readback → layer
```

两次 readback 时机不同，导致数据不一致。

**正确做法**

- Preview 和 Composite 应该使用相同的单次 readback 结果
- 或者 Preview 直接从 GPU 渲染（WebGPU canvas context），只在 Composite 时 readback

---

### 问题 4：hardness=100 边缘渐变问题

**现象**（已修复）

- hardness=100 时，中间有渐变，应该是纯色圆

**根因**
AA 带计算使用归一化距离而非物理像素：

```wgsl
// 错误：AA 带覆盖半径的 50%
if (edge_dist > -0.5) { mask = 0.5 - edge_dist; }
```

**修复方案**
使用物理像素计算 1px AA 带：

```wgsl
let pixel_size = 1.0 / in.dab_size;
let half_pixel = pixel_size * 0.5;
```

---

## 架构对比

### CPU 实现（参考标准）

```
stampDab() → bufferData (内存，Uint8ClampedArray)
                          ↓
              syncToCanvas() (同步，每 N dabs 一次)
                          ↓
                    previewCanvas
                          ↓
            endStroke() 读取同一 previewCanvas → 合成到 layer
```

**特点**：

- 数据源唯一，Preview = Composite
- 同步操作，无延迟
- 简单可靠

### GPU 实现（当前，有问题）

```
stampDab() → GPU Texture (显存)
                          ↓
              异步 readback (copyTextureToBuffer + mapAsync)
                          ↓
                    previewCanvas (有 1-2 帧延迟)
                          ↓
            endStroke() 再次 readback → 合成到 layer
                          ↑
                    两次 readback 可能不一致 → 闪烁
```

**问题**：

- 异步 readback 导致 Preview 延迟
- 两次 readback 数据可能不一致
- Canvas 2D 无法直接显示 GPU 纹理

### 理想 GPU 实现

```
stampDab() → GPU Texture (显存)
                          ↓
        WebGPU Canvas Context 直接渲染 → 显示 (无 readback)
                          ↓
            endStroke() 单次 readback → 合成到 layer
```

**特点**：

- Preview 无延迟（直接 GPU 渲染）
- 只在 Composite 时 readback 一次
- Preview = Composite

---

## 经验教训

### 1. 先保证正确性，再优化性能

- 应该先用单元测试验证 shader 与 CPU 算法完全一致
- 再进行性能优化和架构替换
- 当前实现跳过了验证步骤，导致多个算法差异

### 2. 架构设计要考虑数据流一致性

- WYSIWYG 要求 Preview 和 Composite 使用相同数据
- 异步操作会破坏一致性，需要精心设计
- 双缓冲、异步更新都会增加复杂度

### 3. GPU readback 是昂贵的

- `copyTextureToBuffer` + `mapAsync` 需要 1-2 帧
- 应该尽量减少 readback 次数
- 考虑使用 WebGPU canvas context 直接渲染，避免 readback

### 4. 渐进式迁移策略

- 不应该一步到位替换整个渲染层
- 应该先验证核心算法（单个 dab 渲染）
- 再验证批处理（多个 dab）
- 最后验证完整流程（插值、压感等）

### 5. 参考实现的重要性

- CPU 版本 (`maskCache.ts`) 是正确的参考
- shader 算法必须逐行对比 CPU 版本
- 常数、公式、边界条件都要一致

### 6. GPU Instancing 与顺序依赖渲染不兼容 ⚠️ 新增

**问题**：Alpha Darken 等累积混合模式需要每个 dab 读取前一个 dab 的结果。

**陷阱**：GPU Instancing (`draw(6, count)`) 让所有 dab 在同一 render pass 中从**同一纹理**读取，导致所有 dab 都认为 `dst_a = 0`，累积失效。

**解决方案**：改用 Per-dab Loop，每个 dab 单独一个 render pass：

```typescript
for (const dab of dabs) {
  copySourceToDest(encoder); // 保留前一帧
  const pass = encoder.beginRenderPass(dest);
  pass.draw(6, 1); // 单个 dab
  pass.end();
  swap(); // 结果变成下一次的 source
}
submit([encoder.finish()]); // 批量提交
```

### 7. WebGPU `writeBuffer` 同步语义陷阱 ⚠️ 新增

**问题**：尝试复用单个 vertex buffer 优化内存时导致所有 dab 使用最后一次写入的数据。

**陷阱**：`queue.writeBuffer()` 在 `submit()` 之前批量执行，多次写入同一 buffer 会**覆盖**而非排队。

```typescript
// ❌ 错误：所有 dab 都使用最后一次写入的数据
for (const dab of dabs) {
  writeBuffer(sharedBuffer, 0, dabData); // 覆盖前一次
  pass.setVertexBuffer(0, sharedBuffer);
}

// ✅ 正确：每个 dab 使用独立 buffer（mappedAtCreation 是同步的）
for (const dab of dabs) {
  const buf = createBuffer({ mappedAtCreation: true });
  new Float32Array(buf.getMappedRange()).set(dabData);
  buf.unmap();
  pass.setVertexBuffer(0, buf);
}
// 提交后销毁临时 buffers
```

**要点**：`mappedAtCreation: true` 是同步写入，`writeBuffer` 是异步批量执行。

---

## 测试方案：Shader 算法一致性验证

### 测试目标

确保 GPU shader 渲染结果与 CPU 版本像素级一致，误差控制在 ±1 范围内。

### 测试方法

#### 方案概述

1. **创建测试环境**：一个独立的测试页面，运行 CPU 和 GPU 渲染
2. **固定参数测试**：使用相同的参数（位置、颜色、大小、硬度等）渲染单个 dab
3. **像素对比**：读取两者的 ImageData 进行逐像素对比
4. **可视化输出**：生成差异图像，直观显示不一致区域

#### 实现步骤

**步骤 1：创建测试页面**

文件路径：`tests/visual/gpu-cpu-comparison.html`

```html
<!DOCTYPE html>
<html>
  <head>
    <title>GPU vs CPU 渲染对比测试</title>
    <style>
      .canvas-container {
        display: flex;
        gap: 20px;
      }
      .canvas-wrapper {
        text-align: center;
      }
      canvas {
        border: 1px solid #ccc;
      }
    </style>
  </head>
  <body>
    <h1>GPU vs CPU 渲染对比</h1>

    <div class="controls">
      <label>
        Brush Size: <input type="range" id="size" min="10" max="500" value="100" />
        <span id="sizeValue">100</span>
      </label>
      <label>
        Hardness: <input type="range" id="hardness" min="0" max="100" value="50" />
        <span id="hardnessValue">50</span>
      </label>
      <label>
        Flow: <input type="range" id="flow" min="0" max="100" value="50" />
        <span id="flowValue">50</span>
      </label>
      <button id="runTest">运行测试</button>
    </div>

    <div class="canvas-container">
      <div class="canvas-wrapper">
        <h3>CPU 渲染</h3>
        <canvas id="cpuCanvas" width="500" height="500"></canvas>
      </div>
      <div class="canvas-wrapper">
        <h3>GPU 渲染</h3>
        <canvas id="gpuCanvas" width="500" height="500"></canvas>
      </div>
      <div class="canvas-wrapper">
        <h3>差异</h3>
        <canvas id="diffCanvas" width="500" height="500"></canvas>
      </div>
    </div>

    <div id="results"></div>

    <script type="module">
      import { StrokeAccumulator } from '../src/utils/strokeBuffer.ts';
      import { GPUContext, GPUStrokeAccumulator } from '../src/gpu/index.ts';

      // 测试参数
      const testCases = [
        { size: 100, hardness: 100, flow: 0.5, x: 250, y: 250, color: '#ff0000' },
        { size: 100, hardness: 50, flow: 0.5, x: 250, y: 250, color: '#ff0000' },
        { size: 100, hardness: 0, flow: 0.5, x: 250, y: 250, color: '#ff0000' },
        { size: 500, hardness: 50, flow: 0.5, x: 250, y: 250, color: '#ff0000' },
      ];

      // 运行单个测试
      async function runSingleTest(testCase) {
        const { size, hardness, flow, x, y, color } = testCase;

        // CPU 渲染
        const cpuAccumulator = new StrokeAccumulator(500, 500);
        cpuAccumulator.beginStroke(hardness / 100);
        cpuAccumulator.stampDab({ x, y, size, flow, hardness: hardness / 100, color });
        const cpuCanvas = cpuAccumulator.getCanvas();

        // GPU 渲染
        const gpuCtx = GPUContext.getInstance();
        await gpuCtx.initialize();
        const gpuAccumulator = new GPUStrokeAccumulator(gpuCtx.device, 500, 500);
        gpuAccumulator.beginStroke();
        gpuAccumulator.stampDab({ x, y, size, flow, hardness: hardness / 100, color });
        // 等待 GPU 完成并读取结果
        const dummyCtx = new OffscreenCanvas(500, 500).getContext('2d');
        await gpuAccumulator.endStroke(dummyCtx, 1.0);
        const gpuCanvas = gpuAccumulator.getCanvas();

        return { cpuCanvas, gpuCanvas, testCase };
      }

      // 像素对比
      function compareCanvases(cpuCanvas, gpuCanvas) {
        const cpuData = cpuCanvas.getContext('2d').getImageData(0, 0, 500, 500);
        const gpuData = gpuCanvas.getContext('2d').getImageData(0, 0, 500, 500);

        const diffData = new ImageData(500, 500);
        let maxDiff = 0;
        let diffPixels = 0;
        const threshold = 2; // 允许 ±2 误差

        for (let i = 0; i < cpuData.data.length; i += 4) {
          const rDiff = Math.abs(cpuData.data[i] - gpuData.data[i]);
          const gDiff = Math.abs(cpuData.data[i + 1] - gpuData.data[i + 1]);
          const bDiff = Math.abs(cpuData.data[i + 2] - gpuData.data[i + 2]);
          const aDiff = Math.abs(cpuData.data[i + 3] - gpuData.data[i + 3]);

          const maxChannelDiff = Math.max(rDiff, gDiff, bDiff, aDiff);

          if (maxChannelDiff > threshold) {
            diffPixels++;
            maxDiff = Math.max(maxDiff, maxChannelDiff);
          }

          // 差异可视化：红色表示差异
          if (maxChannelDiff > threshold) {
            diffData.data[i] = 255;
            diffData.data[i + 1] = 0;
            diffData.data[i + 2] = 0;
            diffData.data[i + 3] = 255;
          } else {
            diffData.data[i] = cpuData.data[i];
            diffData.data[i + 1] = cpuData.data[i + 1];
            diffData.data[i + 2] = cpuData.data[i + 2];
            diffData.data[i + 3] = 128; // 半透明
          }
        }

        return { diffData, maxDiff, diffPixels, totalPixels: 500 * 500 };
      }

      // 主测试函数
      document.getElementById('runTest').addEventListener('click', async () => {
        const results = [];

        for (const testCase of testCases) {
          const { cpuCanvas, gpuCanvas, testCase: tc } = await runSingleTest(testCase);

          // 显示结果
          document.getElementById('cpuCanvas').getContext('2d').drawImage(cpuCanvas, 0, 0);
          document.getElementById('gpuCanvas').getContext('2d').drawImage(gpuCanvas, 0, 0);

          // 对比
          const { diffData, maxDiff, diffPixels, totalPixels } = compareCanvases(
            cpuCanvas,
            gpuCanvas
          );
          document.getElementById('diffCanvas').getContext('2d').putImageData(diffData, 0, 0);

          results.push({
            testCase: tc,
            maxDiff,
            diffPixels,
            diffPercent: ((diffPixels / totalPixels) * 100).toFixed(2),
            passed: maxDiff <= 2,
          });
        }

        // 显示结果
        const resultsDiv = document.getElementById('results');
        resultsDiv.innerHTML =
          '<h2>测试结果</h2>' +
          results
            .map(
              (r) => `
        <div style="color: ${r.passed ? 'green' : 'red'}">
          ${JSON.stringify(r.testCase)}:
          最大差异=${r.maxDiff},
          差异像素=${r.diffPercent}%,
          ${r.passed ? '✓ 通过' : '✗ 失败'}
        </div>
      `
            )
            .join('');
      });
    </script>
  </body>
</html>
```

**步骤 2：自动化测试（可选）**

使用 Vitest + jsdom 创建自动化测试：

文件路径：`tests/visual/gpu-cpu-dab.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { StrokeAccumulator } from '@/utils/strokeBuffer';
import { GPUContext, GPUStrokeAccumulator } from '@/gpu';

describe('GPU vs CPU 渲染一致性', () => {
  it('hard brush (hardness=100) 应该像素一致', async () => {
    const params = { x: 250, y: 250, size: 100, hardness: 1.0, flow: 0.5, color: '#ff0000' };

    // CPU 渲染
    const cpu = new StrokeAccumulator(500, 500);
    cpu.beginStroke(1.0);
    cpu.stampDab(params);
    const cpuData = cpu.getCanvas().getContext('2d').getImageData(0, 0, 500, 500);

    // GPU 渲染
    const gpuCtx = GPUContext.getInstance();
    await gpuCtx.initialize();
    const gpu = new GPUStrokeAccumulator(gpuCtx.device, 500, 500);
    gpu.beginStroke();
    gpu.stampDab({ ...params, dabOpacity: 1.0 });
    const dummyCtx = new OffscreenCanvas(500, 500).getContext('2d')!;
    await gpu.endStroke(dummyCtx, 1.0);
    const gpuData = gpu.getCanvas().getContext('2d').getImageData(0, 0, 500, 500);

    // 像素对比
    let maxDiff = 0;
    for (let i = 0; i < cpuData.data.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(cpuData.data[i] - gpuData.data[i]));
    }

    expect(maxDiff).toBeLessThanOrThan(2); // 允许 ±1 误差
  });

  it('soft brush (hardness=0.5) Gaussian 曲线应该一致', async () => {
    const params = { x: 250, y: 250, size: 100, hardness: 0.5, flow: 0.5, color: '#ff0000' };

    // 同上...
  });
});
```

#### 测试用例覆盖

| 测试用例    | 参数          | 目的               |
| ----------- | ------------- | ------------------ |
| Hard brush  | hardness=1.0  | 验证 1px AA 边缘   |
| Medium soft | hardness=0.5  | 验证 Gaussian 曲线 |
| Full soft   | hardness=0.0  | 验证最软笔刷       |
| Small brush | size=10       | 验证小尺寸         |
| Large brush | size=500      | 验证大尺寸         |
| Dark color  | color=#000000 | 验证深色混合       |
| Light color | color=#ffffff | 验证浅色混合       |
| Low flow    | flow=0.1      | 验证低累积         |
| High flow   | flow=1.0      | 验证高累积         |

#### 差异分析

当测试失败时，需要分析差异来源：

1. **位置差异**：检查 quad 顶点坐标计算
2. **形状差异**：检查 mask/hardness 计算
3. **颜色差异**：检查 Alpha Darken 混合逻辑
4. **精度差异**：float32 vs uint8 的精度损失

---

## 修复计划

### Phase 0：建立测试环境（新增）

| 步骤 | 说明                     | 文件                                   |
| ---- | ------------------------ | -------------------------------------- |
| 0.1  | 创建视觉对比测试页面     | `tests/visual/gpu-cpu-comparison.html` |
| 0.2  | 运行测试，记录当前差异   | -                                      |
| 0.3  | 使用测试结果验证后续修复 | -                                      |

### Phase 1：修复 Shader 算法（视觉一致性）

| 步骤 | 说明                                   |
| ---- | -------------------------------------- |
| 1.1  | 修复 `distfactor` 添加 `/ in.dab_size` |
| 1.2  | 验证 erf 近似函数精度与 CPU 一致       |
| 1.3  | 修复颜色混合逻辑（白色边缘问题）       |
| 1.4  | 创建像素对比测试，确保 GPU = CPU       |

### Phase 2：解决 Preview/Composite 一致性

| 方案                  | 优点                  | 缺点         | 推荐度     |
| --------------------- | --------------------- | ------------ | ---------- |
| WebGPU Canvas Context | 直接渲染，无 readback | 需重构显示层 | ⭐⭐⭐⭐⭐ |
| 同步 readback（简化） | 改动小                | 可能有延迟   | ⭐⭐       |
| 双 Canvas 叠加        | 折中                  | 复杂度高     | ⭐⭐⭐     |

**推荐方案**：WebGPU Canvas Context

- 创建 `<canvas>` 的 WebGPU context 用于预览
- 直接将 stroke texture 渲染到 WebGPU canvas
- 主 Canvas 2D 用于最终合成和图层显示
- endStroke 时 readback 并合成到图层 Canvas 2D

### Phase 3：测试验证

| 测试项     | 方法                                    |
| ---------- | --------------------------------------- |
| 像素一致性 | GPU vs CPU 单个 dab 渲染对比，误差 < ±1 |
| WYSIWYG    | Preview 与抬笔后结果完全一致            |
| 性能       | 确认 GPU 性能保持优于 CPU               |
| 稳定性     | 连续绘画测试                            |

---

## 参考文件

| 文件                                      | 说明                                             |
| ----------------------------------------- | ------------------------------------------------ |
| `src/utils/maskCache.ts`                  | CPU 版 Alpha Darken 和 Gaussian mask（正确参考） |
| `src/utils/strokeBuffer.ts`               | CPU 版 StrokeAccumulator（正确参考）             |
| `src/gpu/shaders/brush.wgsl`              | GPU shader（需修复）                             |
| `src/gpu/GPUStrokeAccumulator.ts`         | GPU 版 StrokeAccumulator（需重构）               |
| `src/gpu/resources/PingPongBuffer.ts`     | Ping-Pong Buffer 实现                            |
| `docs/design/gpu-rendering-strategies.md` | 原始设计文档                                     |

---

## 下一步

1. **立即修复**：shader 中的 `distfactor` 计算
2. **短期**：设计并实现 WebGPU Canvas Context 方案
3. **长期**：建立完整的像素对比测试体系
