# PaintBoard 性能基准测试方案

> **日期**: 2026-01-15
> **状态**: 📋 设计中 (v2.1 - 工程化优化)
> **优先级**: P1
> **目标**: 建立可量化的性能指标体系，驱动后续优化决策
> **Review**: v2.0 整合 WebGPU 异步测量、视觉滞后计；v2.1 修正采样策略、时钟同步、CI 兼容性

---

## 背景与动机

### 核心问题

1. **缺乏量化指标**：目前性能评估依赖主观手感，无法精确定位瓶颈。
2. **跟手感难以测量**：用户反馈"长笔触后段不跟手"，但无法量化问题严重程度。
3. **优化缺乏基线**：没有 Baseline 数据，无法评估优化效果。

### 设计原则

> **测量驱动优化 (Measure Before Optimize)**
>
> - 没有数据的优化是盲目的。
> - 性能回归必须能被自动检测。
> - 指标必须反映真实用户体验。

---

## 测量维度

### 1. 输入延迟 (Input Latency) ⭐⭐⭐

**定义**：从 Wacom 笔触接触画板到前端代码收到 PointerEvent 的时间。

**⚠️ 时钟同步风险 (v2.1 修正)**：

Rust/Tauri 后端的时间戳与 JS 的 `performance.now()` 不是同一时钟源，直接相减会产生 1~10ms 不可控偏差。

**测量方法（推荐）**：

统一使用前端时钟源，测量浏览器内部延迟：

```typescript
// 使用 PointerEvent.timeStamp（浏览器内部同源时钟）
const inputLatency = performance.now() - event.timeStamp;
```

**关键代码路径**：

```
Wacom 驱动 → WinTab DLL → Rust Backend → Tauri IPC → JS Event Handler
                                                      ↑
                                            [测量起点：event.timeStamp]
```

**理想值**：< 8ms (1 frame @ 120Hz)

**风险**：WinTab 轮询频率、Tauri IPC 开销、JS 事件循环延迟。

---

### 2. 渲染延迟 (Render Latency) ⭐⭐⭐

**定义**：从 PointerEvent handler 触发到像素实际绘制到 Canvas 的时间。

**⚠️ WebGPU 异步特性**：

在 WebGPU 中，`requestAnimationFrame` 结束只代表"命令已提交到队列"，**不代表 GPU 已经画完了**。必须区分：

- **CPU 编码时间**：JS 代码构建 GPU 命令的耗时
- **GPU 执行时间**：GPU 实际执行渲染的耗时

**测量方法**：

```typescript
// CPU 模式：直接测量
t_rendered = performance.now(); // rAF 回调末尾

// GPU 模式：必须等待真实完成
await device.queue.onSubmittedWorkDone();
t_gpuComplete = performance.now();
```

**关键代码路径**：

```
PointerEvent → BrushStamper → Canvas 2D / WebGPU → 像素写入
                              ↓
                         [GPU 模式需等待 onSubmittedWorkDone]
```

**理想值**：

- CPU 模式：< 4ms
- GPU 模式：< 6ms（CPU 编码 + GPU 执行总耗时）

**风险**：

- 插值点过多导致渲染阻塞
- GPU Pipeline stall
- `beginBrushStroke()` 异步初始化延迟
- ⚠️ `writeBuffer` 上传带宽瓶颈（点过多时）

---

### 3. 端到端延迟 (End-to-End Latency) ⭐⭐⭐

**定义**：从笔触物理接触画板到像素出现在显示器的总延迟。

**延迟分解 (v2.1 补充说明)**：

```
端到端延迟 = 输入延迟 + 渲染延迟 + 呈现延迟

其中：
- Render Latency = CPU Encode + GPU Execute
- Present Latency ≈ Render Latency + VSync（8~16ms）
```

> ⚠️ 注意：`onSubmittedWorkDone` 测量的是 GPU Execute 完成时间，不是屏幕呈现时间。
> 真实的屏幕呈现还需要等待 VSync，因此"20ms 渲染延迟"并不意味着用户体验差。

**测量方法**：

- **软件测量**：输入延迟 + 渲染延迟 + VSync 延迟（约 8-16ms）
- **硬件测量**：高速摄像机同时拍摄笔尖和屏幕（精确但复杂）

**理想值**：< 20ms（人眼可感知的"即时反馈"阈值约 50ms）

---

### 4. 帧率 (FPS) ⭐⭐

**定义**：在标准负载下的稳定帧率。

**测量场景**：

| 场景 | 画布尺寸  | 笔刷大小 | 笔触数量 | 目标 FPS |
| ---- | --------- | -------- | -------- | -------- |
| 轻量 | 1920x1080 | 20px     | 10 条    | ≥ 60     |
| 标准 | 4000x3000 | 50px     | 50 条    | ≥ 60     |
| 压力 | 4000x3000 | 200px    | 100 条   | ≥ 30     |
| 极限 | 8000x6000 | 400px    | 200 条   | ≥ 15     |

**测量方法**：

- 使用 `requestAnimationFrame` 回调测量帧间隔
- 统计 FPS 均值、最小值、1% Low

---

### 5. 帧时间一致性 (Frame Pacing) ⭐⭐⭐

**定义**：帧间隔的稳定性。即使平均 60 FPS，如果帧时间波动大，也会造成"卡顿感"。

**测量指标**：

- **帧时间标准差 (σ)**：越小越平滑
- **帧时间 99th 百分位**：检测偶发卡顿
- **连续掉帧次数**：连续 2 帧以上超过 33ms 的次数

**理想值**：

- σ < 2ms
- 99th 百分位 < 20ms
- 连续掉帧 = 0

---

### 6. 输入队列深度 ⭐⭐⭐

**定义**：积压的未处理输入点数量。

**重要性**：这是"跟手感"的直接指标。如果渲染跟不上输入，队列会积压，导致笔触"滞后"。

**测量方法**：

- 监控 `pendingPointsRef.current.length`（状态机 'starting' 阶段的缓冲）
- 监控 `strokeBufferRef.current` 的积压点数

**理想值**：

- 正常状态下队列深度 = 0
- 高负载下队列深度 < 10

---

### 7. 视觉滞后距离 (Lagometer) ⭐⭐⭐ 🆕

**定义**：在渲染每一帧时，"最新输入点位置" 与 "笔刷当前绘制位置" 之间的物理距离（像素）。

**重要性**：这是测量"跟手感"最直观的指标，直接量化用户感觉到的"笔触追着鼠标跑"现象。

**测量方法**：

```typescript
function measureVisualLag() {
  const inputX = latestPointerEvent.clientX;
  const inputY = latestPointerEvent.clientY;
  const brushX = brushEngine.currentX;
  const brushY = brushEngine.currentY;

  const lagDistance = Math.hypot(inputX - brushX, inputY - brushY);
  stats.maxLagDistance = Math.max(stats.maxLagDistance, lagDistance);
}
```

**⚠️ v2.1 增强建议：点 ID 对齐**

若输入点很密，`latestPointerEvent` 和 `brushEngine.currentX` 可能不是同一时刻的点，会夸大滞后。
建议在输入点入队时附带 `pointId`，渲染时用同一 ID 对齐比较。

**理想值**：

- 快速划线时滞后距离 ≤ `笔刷半径 + 10px`
- 正常绘制时滞后距离 < 5px

---

### 8. GC 压力 (Garbage Collection) ⭐⭐ 🆕

**定义**：JavaScript 垃圾回收造成的瞬间卡顿（Hiccups）。

**重要性**：绘图应用最怕 GC 造成的瞬间卡顿。如果 Heap 呈锯齿状剧烈波动，说明在大量创建临时对象。

**⚠️ v2.1 兼容性修正：降级策略**

`performance.memory` 是 Chrome 专有 API，在 Firefox / WebKit / CI 环境可能是 `undefined`。
必须添加降级处理，避免测试"永远跳过"。

**测量方法**：

```typescript
function checkMemoryPressure(): MemoryStats | { supported: false } {
  // 🆕 v2.1 降级策略
  if (!performance.memory) {
    return { supported: false };
  }

  const used = performance.memory.usedJSHeapSize;
  // 如果一帧内内存暴涨，记录警告
  // 检测 Heap 突降 = GC 事件
  return { supported: true, heapUsed: used };
}
```

**报告输出**：

```json
"memory": { "supported": false }  // CI 环境
"memory": { "supported": true, "heapUsed": 128, "gcEventCount": 0 }  // Chrome
```

**理想值**：

- GC 事件 < 1 次/分钟（持续绘制期间）
- Heap 增长率 < 1 MB/分钟

---

### 9. 长笔触尾端延迟 ⭐⭐⭐

**定义**：用户反馈的"长笔触后段不跟手"现象。

**测量方法**：

1. 使用**基于时间的真实模拟器**（模拟 120Hz 采样率）
2. 模拟一条 500+ 点的长笔触
3. 记录每个点从输入到渲染的延迟
4. 绘制延迟曲线，观察是否随笔触长度增加而上升

**分析**：

- 如果延迟随长度线性增加，说明存在 O(n) 复杂度的操作
- 如果延迟在某个阈值后突增，说明存在批处理或缓冲区溢出问题

---

## 基准测试工具设计

### 架构

```
┌─────────────────────────────────────────────────────┐
│                    Benchmark Suite                   │
├─────────────────────────────────────────────────────┤
│  LatencyProfiler         → 输入/渲染延迟测量        │
│  FPSCounter              → 帧率和帧时间统计         │
│  QueueDepthMonitor       → 输入队列深度监控         │
│  StrokeTrailAnalyzer     → 长笔触延迟曲线分析       │
│  MemoryProfiler          → 内存使用监控             │
├─────────────────────────────────────────────────────┤
│  BenchmarkRunner         → 自动化测试执行器         │
│  ReportGenerator         → 报告生成（JSON/HTML）    │
└─────────────────────────────────────────────────────┘
```

### 文件结构

```
src/benchmark/
├── LatencyProfiler.ts        # 延迟测量（含 CPU/GPU 分离）
├── FPSCounter.ts             # 帧率统计
├── QueueDepthMonitor.ts      # 队列深度监控
├── LagometerMonitor.ts       # 🆕 视觉滞后距离监控
├── StrokeTrailAnalyzer.ts    # 长笔触尾端延迟分析
├── MemoryProfiler.ts         # 内存/GC 监控
├── RealisticInputSimulator.ts # 🆕 基于时间的真实模拟器
├── BenchmarkRunner.ts        # 测试执行器
├── ReportGenerator.ts        # 报告生成
├── index.ts                  # Barrel export
└── types.ts                  # 类型定义
```

---

## 核心组件设计

### 1. LatencyProfiler（v2.1 优化版）

区分 **CPU 编码时间** 和 **GPU 执行时间**，解决 WebGPU 异步测量问题。

**⚠️ v2.1 关键修正：采样式 GPU 测量**

在每个点都调用 `await device.queue.onSubmittedWorkDone()` 会严重扰动测量结果：

- 每个点都阻塞主线程，变成"测试系统自己制造的延迟"
- 与真实绘制流程不一致（真实绘制是批量提交）

**正确做法**：只在每个 rAF 或每 N 个点时采样一次 GPU 完成时间。

```typescript
interface LatencyMeasurement {
  inputTimestamp: number; // PointerEvent.timeStamp（同源时钟）
  cpuEncodeStart: number; // CPU 编码开始时间
  cpuEncodeEnd: number; // CPU 编码结束时间
  gpuCompleteTimestamp?: number; // GPU 真实完成时间（仅采样点有值）
  pointIndex: number;
}

class LatencyProfiler {
  private measurements: LatencyMeasurement[] = [];
  private device?: GPUDevice;
  private sampleInterval: number = 50; // 🆕 每 50 个点采样一次 GPU

  // 在 PointerEvent handler 中调用
  markInputReceived(pointIndex: number, event: PointerEvent): void {
    this.currentMeasurement = {
      inputTimestamp: event.timeStamp, // 🆕 使用同源时钟
      cpuEncodeStart: 0,
      cpuEncodeEnd: 0,
      pointIndex,
    };
  }

  // 在渲染开始时调用
  markCpuEncodeStart(): void {
    this.currentMeasurement.cpuEncodeStart = performance.now();
  }

  // 在 GPU 命令提交后调用
  async markRenderSubmit(pointIndex: number): Promise<void> {
    const cpuEnd = performance.now();
    this.currentMeasurement.cpuEncodeEnd = cpuEnd;

    // 🔑 v2.1 修正：采样式测量，避免每个点都阻塞
    if (this.shouldSampleGpu(pointIndex)) {
      if (this.device) {
        await this.device.queue.onSubmittedWorkDone();
      }
      this.currentMeasurement.gpuCompleteTimestamp = performance.now();
    }

    this.measurements.push(this.currentMeasurement);
  }

  // 采样策略：每 N 个点或每帧结束时
  private shouldSampleGpu(pointIndex: number): boolean {
    return pointIndex % this.sampleInterval === 0;
  }

  // 获取统计结果
  getStats(): {
    avgInputLatency: number;
    avgCpuEncodeTime: number;
    avgGpuExecuteTime: number; // 仅基于采样点计算
    avgTotalRenderLatency: number;
    maxRenderLatency: number;
    p99RenderLatency: number;
  };
}
```

**价值**：如果 CPU 时间短、GPU 时间长，说明 Shader 太重；反之说明 JS 逻辑太重。

### 2. FPSCounter

```typescript
interface FrameStats {
  fps: number;
  avgFrameTime: number;
  minFrameTime: number;
  maxFrameTime: number;
  frameTimeStdDev: number;
  p99FrameTime: number;
  droppedFrames: number; // 帧时间 > 33ms 的帧数
  consecutiveDrops: number; // 最长连续掉帧
}

class FPSCounter {
  private frameTimes: number[] = [];

  // 在每帧开始时调用
  tick(): void;

  // 获取统计结果
  getStats(): FrameStats;

  // 重置统计
  reset(): void;
}
```

### 3. StrokeTrailAnalyzer

```typescript
interface TrailAnalysis {
  pointCount: number;
  latencies: number[]; // 每个点的延迟
  avgLatencyFirst10: number; // 前 10 个点的平均延迟
  avgLatencyLast10: number; // 后 10 个点的平均延迟
  latencyDrift: number; // 尾端延迟增量 (last10 - first10)
  hasTrailingLag: boolean; // 是否存在尾端延迟问题
}

class StrokeTrailAnalyzer {
  // 分析单条笔触的延迟曲线
  analyzeStroke(measurements: LatencyMeasurement[]): TrailAnalysis;

  // 判断是否存在"长笔触不跟手"问题
  // 阈值：尾端延迟增量 > 5ms
  detectTrailingLag(analysis: TrailAnalysis): boolean;
}
```

### 4. LagometerMonitor 🆕

```typescript
interface LagometerStats {
  avgLagDistance: number; // 平均滞后距离（像素）
  maxLagDistance: number; // 峰值滞后距离
  lagExceedCount: number; // 超过阈值的次数
  lagExceedThreshold: number; // 阈值（笔刷半径 + N 像素）
}

class LagometerMonitor {
  private lagDistances: number[] = [];
  private brushRadius: number = 20;

  // 在 render 循环中调用
  measure(inputPos: { x: number; y: number }, brushPos: { x: number; y: number }): void {
    const lagDistance = Math.hypot(inputPos.x - brushPos.x, inputPos.y - brushPos.y);
    this.lagDistances.push(lagDistance);
  }

  getStats(): LagometerStats;
  reset(): void;
}
```

### 5. RealisticInputSimulator（v2.1 优化版）

解决"模拟器过于理想化"问题，模拟真实采样率和抖动。

**⚠️ v2.1 关键修正：时间漂移校正 (Timer Drift Correction)**

简单的 `setTimeout` 会产生累积误差。JavaScript 的 `setTimeout(8)` 在主线程繁忙时可能变成 `12ms`。
累积 100 个点后，120Hz 模拟可能实际只有 90Hz，导致测试压力偏低。

**正确做法**：使用 **期望时间 (Expected Time)** 进行校正。

```typescript
interface SimulatorOptions {
  frequencyHz?: number; // 采样率，默认 120Hz
  jitter?: boolean; // 模拟真实抖动
  pressureNoise?: number; // 压感噪声幅度 (0-1)
}

class RealisticInputSimulator {
  constructor(private canvas: HTMLCanvasElement) {}

  // 真实的输入模拟（v2.1 优化版）
  async drawStroke(
    from: Point,
    to: Point,
    options: SimulatorOptions & { steps: number }
  ): Promise<void> {
    const interval = 1000 / (options.frequencyHz ?? 120); // 8.33ms @ 120Hz
    const points = this.interpolatePoints(from, to, options.steps);
    const startTime = performance.now(); // 🆕 记录起始时间

    for (let i = 0; i < points.length; i++) {
      // 1. 发送事件
      const pt = points[i];
      const finalPoint = options.jitter ? this.applyJitter(pt) : pt;
      this.dispatchPointerEvent(finalPoint);

      // 2. 🆕 计算下一个点的"理论"触发时间
      const nextExpectedTime = startTime + (i + 1) * interval;

      // 3. 🆕 计算当前还需要等待多久（自动补偿之前的延迟）
      const now = performance.now();
      const wait = Math.max(0, nextExpectedTime - now);

      // 4. 等待
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  private applyJitter(pt: Point): Point;
  private interpolatePoints(from: Point, to: Point, steps: number): Point[];
  private dispatchPointerEvent(pt: Point): void;
}
```

---

## 自动化测试场景

### 场景 1：延迟基准测试（优化版）

使用真实模拟器和 GPU 完成时间测量。

```typescript
test('Input-to-render latency should be under 8ms', async () => {
  const profiler = new LatencyProfiler(gpuDevice); // 传入 GPU 设备
  profiler.install();

  // 🔑 使用真实模拟器（120Hz 采样率）
  const simulator = new RealisticInputSimulator(canvas);
  await simulator.drawStroke(
    { x: 100, y: 100 },
    { x: 600, y: 100 },
    { steps: 100, frequencyHz: 120 }
  );

  const stats = profiler.getStats();
  expect(stats.avgTotalRenderLatency).toBeLessThan(8);
  expect(stats.p99RenderLatency).toBeLessThan(16);

  // 🆕 检查 CPU/GPU 耗时分布
  console.log(`CPU: ${stats.avgCpuEncodeTime}ms, GPU: ${stats.avgGpuExecuteTime}ms`);
});
```

### 场景 2：长笔触尾端延迟测试

```typescript
test('Long stroke should not have trailing lag > 5ms', async () => {
  const profiler = new LatencyProfiler(gpuDevice);
  const analyzer = new StrokeTrailAnalyzer();
  profiler.install();

  // 🔑 使用真实模拟器
  const simulator = new RealisticInputSimulator(canvas);
  await simulator.drawStroke(
    { x: 50, y: 50 },
    { x: 1000, y: 500 },
    { steps: 500, frequencyHz: 120 }
  );

  const analysis = analyzer.analyzeStroke(profiler.getMeasurements());
  expect(analysis.latencyDrift).toBeLessThan(5);
  expect(analysis.hasTrailingLag).toBe(false);
});
```

### 场景 3：视觉滞后测试 🆕

```typescript
test('Visual lag should not exceed brush radius + 10px', async () => {
  const lagometer = new LagometerMonitor();
  lagometer.setBrushRadius(20);
  lagometer.install();

  const simulator = new RealisticInputSimulator(canvas);
  await simulator.drawStroke(
    { x: 100, y: 100 },
    { x: 800, y: 400 },
    { steps: 200, frequencyHz: 120, jitter: true }
  );

  const stats = lagometer.getStats();
  expect(stats.maxLagDistance).toBeLessThan(30); // 20px 半径 + 10px
  expect(stats.lagExceedCount).toBe(0);
});
```

### 场景 4：帧率压力测试

```typescript
test('FPS should stay above 30 under heavy load', async () => {
  const fpsCounter = new FPSCounter();
  fpsCounter.start();

  const simulator = new RealisticInputSimulator(canvas);

  // 顺序绘制 20 条笔触（更真实的场景）
  for (let i = 0; i < 20; i++) {
    await simulator.drawStroke(
      { x: Math.random() * 4000, y: Math.random() * 3000 },
      { x: Math.random() * 4000, y: Math.random() * 3000 },
      { steps: 50, frequencyHz: 120 }
    );
  }

  fpsCounter.stop();
  const stats = fpsCounter.getStats();

  expect(stats.fps).toBeGreaterThan(30);
  expect(stats.consecutiveDrops).toBeLessThan(3);
});
```

### 场景 5：GC 压力测试 🆕

```typescript
test('GC events should be minimal during continuous drawing', async () => {
  const memoryProfiler = new MemoryProfiler();
  memoryProfiler.start();

  const simulator = new RealisticInputSimulator(canvas);

  // 持续绘制 60 秒
  const startTime = Date.now();
  while (Date.now() - startTime < 60000) {
    await simulator.drawStroke(
      { x: Math.random() * 4000, y: Math.random() * 3000 },
      { x: Math.random() * 4000, y: Math.random() * 3000 },
      { steps: 100, frequencyHz: 120 }
    );
  }

  memoryProfiler.stop();
  const stats = memoryProfiler.getStats();

  expect(stats.gcEventCount).toBeLessThan(1); // < 1次/分钟
  expect(stats.heapGrowthRate).toBeLessThan(1); // < 1MB/分钟
});
```

---

## 报告格式

### JSON 输出

```json
{
  "timestamp": "2026-01-15T16:30:00Z",
  "environment": {
    "resolution": "4000x3000",
    "renderMode": "GPU",
    "brushSize": 50,
    "hardness": 80
  },
  "latency": {
    "avgInputLatency": 3.2,
    "avgRenderLatency": 5.8,
    "p99RenderLatency": 12.4
  },
  "fps": {
    "avg": 58.3,
    "min": 42,
    "p1Low": 45,
    "stdDev": 2.1,
    "droppedFrames": 3
  },
  "strokeTrail": {
    "latencyDrift": 2.3,
    "hasTrailingLag": false
  },
  "memory": {
    "heapUsed": 128,
    "heapTotal": 256
  },
  "passed": true
}
```

### HTML 报告

生成可视化图表：

- 延迟时间序列曲线
- 帧时间分布直方图
- 长笔触延迟曲线（点序号 vs 延迟）

**🆕 v2.1 增强：指标关联分析 (Correlation)**

建议在 `ReportGenerator` 中生成**时间轴合并图表**，便于定位掉帧根因：

- X 轴：时间 (ms)
- Y1 轴：Latency (ms)
- Y2 轴：Heap Size (MB)
- 事件点：GC 发生时刻

**价值**：一眼看出"这次掉帧是因为 10ms 前发生了一次 5MB 的内存回收"。

---

## 集成方式

### 1. Debug 面板集成

在现有 Debug 面板 (`Shift+Ctrl+D`) 中添加 Benchmark 选项卡。

### 2. 命令行执行

```bash
# 运行基准测试
pnpm benchmark

# 运行特定场景
pnpm benchmark --scenario=latency
pnpm benchmark --scenario=fps
pnpm benchmark --scenario=trail
```

### 3. CI 集成

在 Pull Request 中自动运行基准测试，对比 Baseline，检测性能回归。

**⚠️ v2.1 CI 兼容性策略**

GitHub Actions 或大多 CI 容器通常没有 GPU 或不支持 WebGPU API（`navigator.gpu` 为 `undefined`）。

**降级策略**：

```typescript
// CI 运行策略
if (!navigator.gpu) {
  console.warn('WebGPU not available, skipping GPU benchmark');
  // 仅运行逻辑验证测试，跳过性能阈值断言
  return { skipped: true, reason: 'no-gpu' };
}
```

**可选方案**：

| 方案               | 描述                              | 适用场景     |
| ------------------ | --------------------------------- | ------------ |
| Mock               | 使用 Mock GPUDevice，仅测逻辑     | 快速 CI 验证 |
| Self-Hosted Runner | 带显卡的物理机 Runner             | 完整性能测试 |
| Skip               | 检测不到 GPU 时自动跳过 Benchmark | 通用 CI 兼容 |

---

## 实施计划

### Phase 1: 核心指标 (预计 2 小时)

- [ ] 创建 `src/benchmark/LatencyProfiler.ts`
- [ ] 创建 `src/benchmark/FPSCounter.ts`
- [ ] 集成到 Canvas 组件

### Phase 2: 长笔触分析 (预计 1 小时)

- [ ] 创建 `src/benchmark/StrokeTrailAnalyzer.ts`
- [ ] 添加延迟曲线可视化

### Phase 3: 自动化测试 (预计 1 小时)

- [ ] 创建 `e2e/benchmark.spec.ts`
- [ ] 添加到 CI Pipeline

### Phase 4: Debug 面板集成 (预计 1 小时)

- [ ] 在 Debug 面板添加 Benchmark 选项卡
- [ ] 实时显示延迟和帧率

---

## 通过标准

| 指标                   | 目标值            | 硬性要求  | 备注                     |
| ---------------------- | ----------------- | --------- | ------------------------ |
| 平均渲染延迟 (CPU+GPU) | < 8ms             | ✅        | 使用 onSubmittedWorkDone |
| P99 渲染延迟           | < 16ms            | ✅        |                          |
| 帧率 (4K 画布 50 笔触) | ≥ 60 FPS          | ❌ (软性) |                          |
| 帧率 (极限压力)        | ≥ 30 FPS          | ✅        |                          |
| 帧时间标准差           | < 2ms             | ✅        |                          |
| 长笔触尾端延迟增量     | < 5ms             | ✅        |                          |
| 连续掉帧               | < 3 帧            | ✅        |                          |
| 🆕 视觉滞后距离        | ≤ 笔刷半径 + 10px | ✅        | Lagometer 测量           |
| 🆕 GC 事件频率         | < 1 次/分钟       | ❌ (软性) | 持续绘制期间             |
| 🆕 Heap 增长率         | < 1 MB/分钟       | ❌ (软性) |                          |

---

## 参考

- [Input Latency in Web Applications](https://web.dev/optimize-long-tasks/)
- [Chrome DevTools Performance Panel](https://developer.chrome.com/docs/devtools/performance/)
- [High-performance Drawing with Canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)
