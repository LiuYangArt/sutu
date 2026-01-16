# 绘图性能优化路线图 v1.2

> 基于 `review.md` 分析 + 实测数据 (2026-01-16)

## 📊 项目当前状态

| 优化项                  | 状态 | 说明                                 |
| ----------------------- | ---- | ------------------------------------ |
| **desynchronized**      | ✅   | `layerRenderer.ts:88`                |
| **硬件光标**            | ✅   | ≤128px 使用 SVG CSS cursor (Q2 完成) |
| **pointerrawupdate**    | ✅   | `useRawPointerInput.ts` (Q1 完成)    |
| **GPU Timestamp Query** | ✅   | `profiler.ts` + `context.ts`         |
| **批量处理**            | ✅   | RAF 循环 + inputQueue                |
| **延迟分段剖析**        | ✅   | `LatencyProfiler.segments` (Q3 完成) |

---

## 🎯 Quick Wins (Q1-Q3) ✅ 已完成

| ID     | 优化项             | 工作量 | 预期收益             | 状态 |
| ------ | ------------------ | ------ | -------------------- | ---- |
| **Q1** | `pointerrawupdate` | ~1h    | Input Latency -1~3ms | ✅   |
| **Q2** | 硬件光标 64→128px  | ~0.5h  | 更大笔刷跟手         | ✅   |
| **Q3** | 延迟分段剖析       | ~2h    | 定位瓶颈             | ✅   |

### Q1: pointerrawupdate ✅

实现文件: `src/components/Canvas/useRawPointerInput.ts`

```typescript
// Check if pointerrawupdate is supported (non-standard, mainly Chromium)
export const supportsPointerRawUpdate =
  typeof window !== 'undefined' && 'onpointerrawupdate' in window;
```

- 在支持的浏览器中自动启用，提供 1-3ms 的输入延迟改善
- 优雅降级：不支持时自动回退到 `pointermove`
- 已处理 1000Hz 设备的高事件量问题（复用现有 inputQueue 批处理）

### Q2: 硬件光标阈值 ✅

实现文件: `src/components/Canvas/useCursor.ts`

```typescript
// Q2 Optimization: Windows limits cursor size to ~128x128px
screenBrushSize <= 128;
```

- 阈值从 64px 提升到 128px
- 更大笔刷也能享受硬件光标的零延迟跟手体验

### Q3: 延迟分段剖析 ✅

实现文件: `src/benchmark/LatencyProfiler.ts`, `src/benchmark/types.ts`

新增 `segments` 字段用于定位瓶颈：

```typescript
segments: {
  inputToQueue: number; // Event handler to queue entry
  queueWait: number; // Time in queue before processing
  cpuEncode: number; // CPU processing time
  gpuExecute: number; // GPU execution time (sampled)
}
```

通过 `window.__benchmark.latencyProfiler.getStats().segments` 可获取详细分段数据。

---

## 📈 当前基准数据 (Q3 完成后)

> 测试环境: 4K 画布 + 800px 软笔刷

| 指标                         | 值                | 说明            |
| ---------------------------- | ----------------- | --------------- |
| **FPS**                      | 59.8 (σ: 4.92ms)  | 边缘稳定        |
| **P99 Frame**                | 23.00ms           | 偶发掉帧        |
| **Render Latency (Avg/P99)** | 15.69ms / 25.30ms |                 |
| **Input Latency**            | 3.14ms            | ✅ 极低         |
| **CPU Encode**               | 0.07ms            | ✅ 极低         |
| **GPU Execute**              | 15.60ms           | ⚠️ 占帧预算 93% |
| **Visual Lag**               | 0.6x              | ✅ 优秀跟手     |

**结论**: CPU 优化到位，当前瓶颈为 **GPU bound**（填充率 + 带宽）。

---

## 🔧 Medium Effort (M1-M3)

| ID     | 优化项               | 工作量 | 备注                           |
| ------ | -------------------- | ------ | ------------------------------ |
| **Q4** | 动态降采样           | ~1-2h  | **Quick Win** 大笔刷填充率减负 |
| **M3** | 笔刷纹理预生成       | ~4-6h  | GPU 计算减负                   |
| **M2** | 局部 Dirty Rect 合成 | ~3-5h  | 大笔刷收益有限，小笔刷有效     |
| **M1** | 减少 CSS 合成层      | ~2-4h  | 检查多余 transform/filter      |
| --     | 动态 Spacing         | ~2h    | ⏸️ 暂缓                        |

> 📌 **优先级调整**：Q4 最快验证 GPU 降负效果，M3 次之

---

## 🏔️ Long-term (L1-L3)

| ID     | 优化项             | 说明                    |
| ------ | ------------------ | ----------------------- |
| **L1** | Native Rust + wgpu | 绕过 WebView，真正 <5ms |
| **L2** | 智能流控           | 积压时激进清空          |
| **L3** | 输入预测           | ⏸️ 搁置                 |

> � **战略**：Q1/Q2/M2 完成后若延迟 ≤16ms，已达 Web 物理极限（VSync）。进一步需 L1 或重启 L3。

---

## 🛡️ React 性能最佳实践

来自 `.agent/skills/react-best-practices`：

| 规则                       | 应用场景                        |
| -------------------------- | ------------------------------- |
| `rerender-memo`            | Canvas 组件避免不必要重渲染     |
| `rerender-dependencies`    | 优化 useEffect/useCallback 依赖 |
| `js-batch-dom-css`         | 批量 DOM/CSS 操作（光标更新）   |
| `js-cache-property-access` | 循环中缓存属性访问              |
| `js-early-exit`            | 提前返回优化                    |

---

## 📋 实施顺序

```
Q1 (pointerrawupdate) → Q2 (硬件光标) → Q3 (延迟剖析) ✅ 已完成
      ↓ GPU bound 确认
Q4 (动态降采样) → M3 (纹理预生成) → M2 (Dirty Rect) → M1 (合成层)
```

---

## 🔗 相关文档

- [review.md](./review.md) - 架构师反馈
- [performance-optimization-plan.md](./done/performance-optimization-plan.md) - 历史优化
- [benchmark-plan.md](./benchmark-plan.md) - 测量方法
