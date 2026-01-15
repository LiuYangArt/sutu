# 性能优化方案 v1.1

> 基于 Benchmark 测试结果（2026-01-15）、Review 分析反馈

## 📊 测试结果对比

| 指标                     | App (实时)  | Browser | 评估              |
| ------------------------ | ----------- | ------- | ----------------- |
| **Avg FPS**              | 60.0        | 59.3    | ✅ 正常           |
| **P99 Frame**            | 18.0ms      | 23.5ms  | ⚠️ 超 16.6ms 预算 |
| **Input Latency**        | 5.56ms      | 10.29ms | ✅ 正常           |
| **Render Latency (Avg)** | **20.78ms** | 12.81ms | 🚨 App 严重       |
| **Render Latency (P99)** | **27.30ms** | 22.70ms | 🚨 两者都超标     |
| **Max Visual Lag**       | **713px**   | 580px   | 🚨 严重滞后       |

> ⚠️ 自动化 Benchmark 在 App 中采样存在问题，上述 App 数据来自实时面板截图。

## 📝 App Benchmark Context

用户补充测试环境信息：

- **Device**: 800px 笔刷 + 4K 屏幕 (3840x2160)
- **Impact**:
  - **GPU Load**: 800px 笔刷每个点覆盖 ~50万像素，GPU 填充率压力巨大。
  - **Visual Lag 感知**: 700px 在 4K 屏上约占 **18%** 宽度。虽然数值大，但在高分屏上感知相对较小（相当于 1080p 下的 350px）。

**新增归一化指标**：

- `lagAsScreenPercent`: 滞后距离占屏幕宽度的百分比
- `lagAsBrushRadii`: 滞后距离是笔刷半径的多少倍

---

## 🔍 问题诊断

### 核心问题：高帧率但高滞后 (High FPS, High Latency)

**根因**：生产者-消费者速率不匹配

```
输入事件 (240Hz) → 队列积压 → 渲染 (60Hz) → 视觉滞后
     ↑                 ↑              ↑
   生产快            积压爆炸      消费慢
```

### ⚠️ 关键发现：App 比 Browser 慢 13ms

| 环境        | Render Latency | 差距     |
| ----------- | -------------- | -------- |
| Browser     | 12.81ms        | -        |
| App (Tauri) | 20.78ms        | **+8ms** |

**这 8ms 是优化的突破口，必须找到原因。**

---

## 🎯 优化路线图 v1.1

> 根据 Review 反馈调整优先级，修正逻辑陷阱

### Phase 1: 止血与诊断 (P0 - 立即执行)

#### 1.1 监控探针 - Queue Depth

在 Debug Panel 中显示队列深度：

```typescript
window.__benchmark.getQueueDepth = () => pendingPointsRef.current.length;
```

**验收**：Visual Lag 与 Queue Depth 强相关

#### 1.2 🚨 吞吐量释放 (核心修复)

**问题**：当前每个点触发一次 composite，导致积压

**方案**：一次性处理所有积压点

```typescript
function renderLoop() {
  // 一次性取出所有积压的点，不要限制数量！
  const points = inputQueue.drain();

  if (points.length > 0) {
    // 批量插值 + 批量绘制
    const interpolated = computeSpline(points);
    renderer.drawBatch(interpolated);
    renderer.present(); // 只 present 一次
  }

  requestAnimationFrame(renderLoop);
}
```

**预期收益**：消除积压，Visual Lag → 0

---

### Phase 2: App 性能专项排查 (P0)

**问题**：Browser 12ms vs App 20ms，差距 8ms 去哪了？

#### 排查清单

| 嫌疑人                   | 排查方法                           | 修复方案         |
| ------------------------ | ---------------------------------- | ---------------- |
| **Canvas 回读**          | 搜索 `getImageData`/`toDataURL`    | 移除或降频       |
| **React State 高频更新** | React DevTools "Highlight updates" | 改用 `useRef`    |
| **Tauri IPC 阻塞**       | 检查每点是否调用 `invoke`          | 批量发送或异步化 |

---

### Phase 3: 智能流控 (P1)

> ⚠️ 仅在吞吐量释放后仍有性能问题时启用

#### 3.1 动态追赶策略 (替代 Frame Budgeting)

**关键修正**：~~超时就停止~~ → 宁可掉帧也要清空队列

```typescript
function processFrame() {
  const queueDepth = getQueueDepth();

  // 追赶模式：积压 > 10 时，优先清空，不限时间预算
  const isCatchingUp = queueDepth > 10;

  if (isCatchingUp) {
    // 全部处理，哪怕掉帧到 30FPS
    processAllPoints();
  } else {
    // 正常模式，保持平滑
    processBatch(5);
  }
}
```

#### 3.2 动态 LOD

当积压严重时，降低渲染精度：

| Queue Depth | 策略               |
| ----------- | ------------------ |
| < 50        | 正常插值渲染       |
| 50-200      | 跳过插值，直线连接 |
| > 200       | 丢弃中间点         |

---

### Phase 4: 测量改进 (P2)

| 任务               | 说明                        |
| ------------------ | --------------------------- |
| 修复 App Benchmark | 研究 Tauri WebView 合成事件 |
| 历史对比           | 保存 git commit + 结果      |

---

## 📋 实施计划

| 阶段    | 任务                          | 预估工时 | 优先级 |
| ------- | ----------------------------- | -------- | ------ |
| **1.1** | Queue Depth 监控              | 0.5h     | **P0** |
| **1.2** | 吞吐量释放 (Frame Coalescing) | 2h       | **P0** |
| **2**   | App 性能排查                  | 2h       | **P0** |
| **3.1** | 动态追赶策略                  | 1h       | P1     |
| **3.2** | 动态 LOD                      | 2h       | P1     |
| **4**   | GPU Instancing                | 4h       | P2     |

---

## ✅ 成功标准

| 指标                     | 当前值 | 目标值     | 说明               |
| ------------------------ | ------ | ---------- | ------------------ |
| **Visual Lag**           | 713px  | < **50px** | 跟手性优先         |
| **Queue Depth**          | 未知   | **≈ 0**    | 无积压             |
| **Render Latency (Avg)** | 20ms   | < 8ms      | -                  |
| **FPS**                  | 60     | ≥ 45       | 可接受掉帧换跟手性 |

---

## 🔗 相关文档

- [Benchmark Plan](./benchmark-plan.md)
- [Review 反馈](./review.md)
- [Architecture](../architecture.md)
