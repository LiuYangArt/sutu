# 性能优化方案 v1.2

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

---

## 📝 测试环境

- **Device**: 800px 笔刷 + 4K 屏幕 (3840x2160)
- **Impact**:
  - **GPU Load**: 800px 笔刷每个点覆盖 ~50万像素，GPU 填充率压力巨大
  - **Visual Lag 感知**: 700px 在 4K 屏上约占 **18%** 宽度

### 归一化公式

```
lagAsScreenPercent = (maxVisualLag / viewportWidth) × 100
lagAsBrushRadii = maxVisualLag / (brushSize / 2)
```

---

## 🔍 问题诊断

### 核心问题：高帧率但高滞后 (High FPS, High Latency)

**根因**：生产者-消费者速率不匹配

```
输入事件 (240Hz) → 队列积压 → 渲染 (60Hz) → 视觉滞后
     ↑                 ↑              ↑
   生产快            积压爆炸      消费慢
```

### ⚠️ 关键发现：App 比 Browser 慢 ≈8ms

| 环境        | Render Latency | 差距     |
| ----------- | -------------- | -------- |
| Browser     | 12.81ms        | -        |
| App (Tauri) | 20.78ms        | **+8ms** |

---

## 🎯 优化路线图 v1.2

> 根据 Review 反馈调整，添加 GC 优化和软上限策略

### Phase 1: 止血与诊断 (P0 - 立即执行) ✅ 已完成

#### 1.1 监控探针 - Queue Depth ✅

在 Debug Panel 中显示队列深度：

```typescript
window.__benchmark.getQueueDepth = () => pendingPointsRef.current.length;
```

**验收**：Visual Lag 与 Queue Depth 强相关

#### 1.2 🚨 吞吐量释放 (核心修复) ✅

**问题**：当前每个点触发一次 composite，导致积压

**方案**：批量处理积压点，带软上限保护

```typescript
const MAX_POINTS_PER_FRAME = 2000; // 软上限，避免单帧冻结
const processingBuffer: Point[] = []; // 预分配，复用

function renderLoop() {
  processingBuffer.length = 0; // 复用数组，避免 GC
  const count = inputQueue.drainTo(processingBuffer, MAX_POINTS_PER_FRAME);

  if (count > 0) {
    const interpolated = computeSpline(processingBuffer);
    renderer.drawBatch(interpolated);
    renderer.present(); // 只 present 一次
  }

  requestAnimationFrame(renderLoop);
}
```

> ⚠️ **GC 优化**：使用 `drainTo` 模式复用数组，避免每帧创建新对象导致 GC 抖动

---

### Phase 2: App 性能专项排查 (P0) ✅ 已完成

**问题**：Browser 12ms vs App 20ms，差距 ≈8ms 去哪了？

#### 排查结论 (2026-01-15)

| 测试环境             | 测试类型       | 平均延迟  | 说明             |
| -------------------- | -------------- | --------- | ---------------- |
| Chrome               | 纯 Canvas 测试 | 8.87ms    | 基准线           |
| Tauri App (WebView2) | 完整应用       | 19.08ms   | 含完整渲染管线   |
| **差距**             |                | **~10ms** | 主要来自应用逻辑 |

**结论**：

1. ✅ **WebView2 固有开销**：约 2-3ms（可接受）
2. ✅ **应用逻辑开销**：约 7-8ms（笔刷算法、GPU 渲染）
3. ✅ **已排除**：getImageData、IPC 阻塞、console.log、DPR 差异

**当前状态**：

- Visual Lag: **254px (0.8x 笔刷半径)** → 已达标 (目标 < 1.0x)
- Queue Depth: **0** → 无积压
- Input Latency: **3.15ms** → 极低

> 📌 差距主要来自应用逻辑本身，非平台问题。进一步优化需要从 Phase 3/4 着手。

---

### Phase 3: 智能流控 (P1)

> 仅在吞吐量释放后仍有性能问题时启用

#### 3.1 动态追赶策略

**原则**：宁可掉帧也要清空队列

```typescript
function processFrame() {
  const queueDepth = getQueueDepth();

  // 追赶模式：积压 > 10 时，优先清空
  const isCatchingUp = queueDepth > 10;
  const limit = isCatchingUp ? MAX_POINTS_PER_FRAME : 50;

  processPoints(limit);
}
```

#### 3.2 动态 LOD

| Queue Depth | 策略               |
| ----------- | ------------------ |
| < 50        | 正常插值渲染       |
| 50-200      | 跳过插值，直线连接 |
| > 200       | 丢弃中间点         |

---

### Phase 4: 输入预测 (P2) ⏸️ 搁置

> 终极体验优化，从"流畅"到"丝滑"

**原理**：根据速度/加速度预测下一帧笔刷位置，先画预测线（临时图层），真实数据来后替换。

**目的**：掩盖 VSync 导致的必然滞后（约 16ms）

#### 实现尝试 (2026-01-15)

**已完成的工作**：

- `InputPredictor` 模块：基于线性外推的简单预测器
- 预测距离限制：最大 50px，防止过度外推
- 置信度机制：高速时降低置信度，减少摆尾效应
- UI 开关：BrushPanel → Renderer → Prediction ON/OFF
- 15 个单元测试全部通过

**搁置原因**：

- 实际效果不理想，预测点与真实笔触的过渡不够自然
- 需要更复杂的预测算法（如卡尔曼滤波）或不同的渲染策略

**分支保留**：

```bash
# 恢复方式
git checkout perf/63-input-prediction
git stash pop
```

**相关 Issue**: [#63](https://github.com/LiuYangArt/PaintBoard/issues/63)

---

### Phase 5: 测量改进 (P2)

| 任务               | 说明                        |
| ------------------ | --------------------------- |
| 修复 App Benchmark | 研究 Tauri WebView 合成事件 |
| 历史对比           | 保存 git commit + 结果      |

---

## 📋 实施计划

| 阶段    | 任务                 | 预估工时 | 优先级 | 状态    |
| ------- | -------------------- | -------- | ------ | ------- |
| **1.1** | Queue Depth 监控     | 0.5h     | **P0** | ✅ 完成 |
| **1.2** | 吞吐量释放 + GC 优化 | 2h       | **P0** | ✅ 完成 |
| **2**   | App 性能排查         | 2h       | **P0** | ✅ 完成 |
| **3.1** | 动态追赶策略         | 1h       | P1     | 待定    |
| **3.2** | 动态 LOD             | 2h       | P1     | 待定    |
| **4**   | 输入预测             | 4h       | P2     | ⏸️ 搁置 |

---

## ✅ 成功标准

| 指标                     | 初始值 | 当前值 | 目标值     | 状态 |
| ------------------------ | ------ | ------ | ---------- | ---- |
| **Visual Lag**           | 713px  | 254px  | < **50px** | 🟡   |
| **lagAsBrushRadii**      | 1.7x   | 0.8x   | < **1.0x** | ✅   |
| **Queue Depth**          | 未知   | 0      | **≈ 0**    | ✅   |
| **Render Latency (Avg)** | 20ms   | 19ms   | < 8ms      | 🟡   |
| **FPS**                  | 60     | 59.8   | ≥ 45       | ✅   |

---

## 🔗 相关文档

- [Benchmark Plan](./benchmark-plan.md)
- [Review 反馈](./review.md)
- [Architecture](../architecture.md)
