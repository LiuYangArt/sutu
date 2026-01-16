# 绘图性能优化路线图 v1.1

> 基于 `review.md` 分析 + 项目现状调研 (2026-01-16)

## 📊 项目当前状态

| 优化项                  | 状态    | 说明                         |
| ----------------------- | ------- | ---------------------------- |
| **desynchronized**      | ✅      | `layerRenderer.ts:88`        |
| **硬件光标**            | ✅ 部分 | ≤64px 使用 SVG CSS cursor    |
| **pointerrawupdate**    | ❌      | 仍用 `pointermove`           |
| **GPU Timestamp Query** | ✅      | `profiler.ts` + `context.ts` |
| **批量处理**            | ✅      | RAF 循环 + inputQueue        |

---

## 🎯 Quick Wins (Q1-Q3)

| ID     | 优化项             | 工作量 | 预期收益             |
| ------ | ------------------ | ------ | -------------------- |
| **Q1** | `pointerrawupdate` | ~1h    | Input Latency -1~3ms |
| **Q2** | 硬件光标 64→128px  | ~0.5h  | 更大笔刷跟手         |
| **Q3** | 延迟分段剖析       | ~2h    | 定位瓶颈             |

### Q1: pointerrawupdate

```typescript
if ('onpointerrawupdate' in window) {
  container.addEventListener('pointerrawupdate', handleRawUpdate);
}
```

> ⚠️ **Review 警告**：1000Hz 设备会产生巨大事件量，确保 inputQueue 批处理足够健壮

### Q2: 硬件光标阈值

```typescript
// useCursor.ts - 64 → 128
screenBrushSize <= 128;
```

> ⚠️ **Review 警告**：Windows 系统限制约 128x128，超过时浏览器可能静默回退软件渲染

---

## 🔧 Medium Effort (M1-M3)

| ID     | 优化项               | 工作量 | 备注                      |
| ------ | -------------------- | ------ | ------------------------- |
| **M1** | 减少 CSS 合成层      | ~2-4h  | 检查多余 transform/filter |
| **M2** | 局部 Dirty Rect 合成 | ~3-5h  | **4K 屏必做**             |
| **M3** | 笔刷纹理预生成       | ~4-6h  | GPU ALU 减负              |

> 📌 **Review 建议**：若 Q1/Q2 后 GPU 耗时仍高，M2 应提权至 P1

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
Q1 (pointerrawupdate) → Q2 (硬件光标) → Q3 (延迟剖析)
      ↓ 评估效果后
M2 (Dirty Rect) → M1 (合成层) → M3 (纹理预生成)
```

---

## 🔗 相关文档

- [review.md](./review.md) - 架构师反馈
- [performance-optimization-plan.md](./done/performance-optimization-plan.md) - 历史优化
- [benchmark-plan.md](./benchmark-plan.md) - 测量方法
