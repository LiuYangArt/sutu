# 绘图性能优化路线图

> 基于 `review.md` 分析 + 项目现状调研 (2026-01-16)

## 📊 项目当前状态总结

| 优化项                  | 当前状态    | 说明                                            |
| ----------------------- | ----------- | ----------------------------------------------- |
| **desynchronized**      | ✅ 已实现   | `layerRenderer.ts:88` 中已使用                  |
| **硬件光标**            | ✅ 部分实现 | `useCursor.ts` 对 ≤64px 笔刷使用 SVG CSS cursor |
| **pointerrawupdate**    | ❌ 未使用   | 仍使用 `pointermove`                            |
| **GPU Timestamp Query** | ✅ 可用     | `profiler.ts` + `context.ts` 已支持             |
| **批量处理**            | ✅ 已实现   | `Canvas/index.tsx` RAF 循环 + inputQueue        |
| **端到端延迟剖析**      | 🟡 部分     | 有 LatencyProfiler，缺详细分段                  |

---

## 🎯 优化优先级分类

### 快速可尝试 (Quick Wins) 🚀

| ID  | 优化项                                | 工作量 | 风险 | 预期收益             |
| --- | ------------------------------------- | ------ | ---- | -------------------- |
| Q1  | `pointerrawupdate` 替代 `pointermove` | ~1h    | 低   | Input Latency -1~3ms |
| Q2  | 硬件光标阈值 64px → 128px             | ~0.5h  | 低   | 更大笔刷保持跟手     |
| Q3  | 延迟分段剖析工具                      | ~2h    | 低   | 精确定位瓶颈         |

---

#### Q1: 使用 `pointerrawupdate`

```typescript
// Canvas/index.tsx - 优先使用 pointerrawupdate
if ('onpointerrawupdate' in window) {
  container.addEventListener('pointerrawupdate', handleRawUpdate);
} else {
  container.addEventListener('pointermove', handlePointerMove);
}
```

#### Q2: 扩展硬件光标

```typescript
// useCursor.ts line 40-44
screenBrushSize <= 128; // 64 → 128
```

#### Q3: 延迟剖析

在 `LatencyProfiler` 中添加分段打点：

- Input → JS 响应
- JS → GPU 提交
- GPU 渲染时间（Timestamp Query）
- 合成到屏幕

---

### 中等难度 (Medium Effort) 🔧

| ID  | 优化项               | 工作量 | 风险 |
| --- | -------------------- | ------ | ---- |
| M1  | 减少 CSS 合成层      | ~2-4h  | 中   |
| M2  | 局部 Dirty Rect 合成 | ~3-5h  | 中   |
| M3  | 笔刷纹理预生成       | ~4-6h  | 中   |

---

### 高难度 / 长期 (Long-term) 🏔️

| ID  | 优化项                        | 工作量  | 说明           |
| --- | ----------------------------- | ------- | -------------- |
| L1  | Native 直通管线 (Rust + wgpu) | ~数周   | 绕过 WebView   |
| L2  | 智能流控 (Phase 3)            | ~3h     | 积压时激进清空 |
| L3  | 输入预测 (Phase 4)            | ⏸️ 搁置 | 效果不理想     |

---

## 📋 建议实施顺序

**第一轮（1-2 天）**：Q1 → Q2 → Q3
**第二轮（视效果而定）**：M1 → M2
**长期探索**：L1

---

## ✅ 验证方法

| 优化项 | 验证方法                         |
| ------ | -------------------------------- |
| Q1/Q2  | Debug Panel 监控 Input Latency   |
| Q3     | 新增分段耗时显示                 |
| M1/M2  | Chrome DevTools Performance 面板 |
| M3     | GPU Profiler 对比帧耗时          |

---

## 🔗 相关文档

- [review.md](./review.md) - 优化分析来源
- [performance-optimization-plan.md](./performance-optimization-plan.md) - 现有优化进度
- [benchmark-plan.md](./benchmark-plan.md) - 性能测量方法
