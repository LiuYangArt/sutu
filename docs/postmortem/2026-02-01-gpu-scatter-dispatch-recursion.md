# GPU Scatter 大参数触发 ComputeBrushPipeline 递归栈溢出

## 背景

在 GPU 笔刷（ComputeBrushPipeline）下，使用大笔刷 + 大 Scatter 参数时出现偶发报错。
Dual Brush + 大 Scatter + 大 Size 时也能触发类似问题。

## 现象

控制台报错：

```
RangeError: Maximum call stack size exceeded
    at ComputeBrushPipeline.computePreciseBoundingBox
    at ComputeBrushPipeline.dispatchInBatches
    at ComputeBrushPipeline.dispatch
    ...
```

## 复现条件（已知）

- GPU 笔刷
- 大 size + 大 scatter（Dual Brush 更容易）

## 根因分析

`ComputeBrushPipeline.dispatch()` 在以下两种条件下会进入 `dispatchInBatches()`：

1. dabs 数量超过 `MAX_DABS_PER_BATCH`
2. bbox 像素数超过 `MAX_PIXELS_PER_BATCH`

当 bbox 过大时，即使切分成 batch，**单个 batch 仍可能超过 `MAX_PIXELS_PER_BATCH`**。
此时 `dispatchInBatches()` 会调用 `dispatch()`，`dispatch()` 再次进入 `dispatchInBatches()`，
形成 **无终止条件的递归**，最终栈溢出。

## 影响范围

- 大笔刷 + 大 scatter
- Dual Brush + scatter
- 会导致 GPU 笔刷渲染中断并报错

## 解决方向（未实现）

**短期**：
- 当 `bboxPixels > MAX_PIXELS_PER_BATCH` 且 `dabs.length <= MAX_DABS_PER_BATCH` 时直接返回 false，
  上层回退到 render pipeline，避免递归。

**长期**：
- 引入 tile 化 bbox 分块，避免超大 bbox 触发递归与性能下降。

## 状态

已修复（2026-02-02）：Compute 侧按 bbox 分块 dispatch，避免递归与栈溢出；Dual/Texture 同步处理。
补充修复（2026-02-02）：动态偏移绑定补齐 size/offset，解决大 scatter 场景下 GPUValidationError。

---

## 补充经验：Brush Tip Shape Size 快速拖动触发 React 警告

### 现象

- Dev 服务器、Downsample off 下，快速拖动 Brush Settings → Brush Tip Shape → Size
- 控制台出现：`Warning: Maximum update depth exceeded`
- CPU/GPU 均可复现

### 复现条件（已知）

- 快速连续拖动 Size 滑块（高频 onChange）

### 根因分析

- Slider onChange 高频触发（短时间内 30+ 次更新），导致 store 更新与渲染回压
- Dev 模式下触发 React 的 nested update 保护警告（并非 useEffect 依赖问题）

### 修复

- 在 SliderRow 内对 onChange 做 `requestAnimationFrame` 合并：每帧只提交一次最新值
- 保持交互流畅，同时降低更新频率，警告消失

### 状态

已修复（2026-02-02）：SliderRow rAF 合并更新，CPU/GPU 不再触发该警告。
