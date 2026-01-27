从你截图里反复出现的这句：

> `[TAURI] Couldn't find callback id ... This might happen when the app is reloaded while Rust is running an asynchronous operation.`

可以非常明确地判断：**Rust 端还在往前端发送 Channel 消息，但前端对应的回调（callback id）已经不存在了**。这在 Tauri v2 的官方文档里也点过名：**只要发生了前端 reload / HMR / WebView 重建 / 页面跳转**，之前注册在 WebView 里的 callback id 就会失效；此时 Rust 再 `channel.send(...)` 就会触发这类 warning。

下面按“是否方案有问题 / 哪里会踩坑 / 怎么改”给结论。

---

## 1) 你的 CPU 笔刷总体方案没大问题，但 Channel 生命周期与并发模型需要补齐

你这套“长期 session + 增量 dirty rect + Channel 推送像素块”的大方向是合理的，问题主要不在渲染算法，而在 **Channel 的有效期、并发 invoke 的顺序、以及前端 reload 场景**。

### 关键风险点 A：前端把 Channel 置空/丢弃时，Rust 仍在 send

你前端 `endStroke()` 里会 `this.channel = null`，但**并不能保证此时没有正在进行中的 `rust_brush_input` invoke**。

常见触发序列（很容易发生）：

1. 前端连续 `processPoints()`（每次都会 `invoke('rust_brush_input')`）
2. 用户抬笔触发 `endStroke()`，前端清理 channel
3. 先前某个还没返回的 `rust_brush_input` 在 Rust 侧继续 `on_sync.send(data)`
4. JS 侧 callback id 已不在（或 channel 已被 GC/清理），于是控制台刷 warning

### 关键风险点 B：dev 模式 HMR 会把 callback 全灭，但 Rust 还在发

截图看起来更像是 **dev 热更新/页面重载**导致的（warning 里也写了 “app is reloaded”）。这时：

- 旧页面的 Channel 回调 id 全部失效
- Rust 端还在异步执行（你的 `rust_brush_input` 是 async command），继续 send 就会疯狂刷

这在开发期属于“正常但烦人”的现象；但如果线上也可能发生 WebView 重载/导航，那就必须做防护。

---

## 2) 你当前实现里最需要立刻改的点（按优先级）

### P0：保证“每个 stroke 同一时刻只有一个 in-flight 的 invoke('rust_brush_input')”

最直接的修法：前端为 `processPoints` 加一个串行队列（promise chain），避免并发 invoke。

示例（核心思想：所有 input invoke 串行执行，endStroke 前先等待队列清空）：

```ts
private inputChain: Promise<void> = Promise.resolve();
private strokeToken = 0;

async startStroke(...) {
  this.strokeToken++;
  const token = this.strokeToken;
  ...
  this.inputChain = Promise.resolve(); // 重置链
}

processPoints(points, brushParams) {
  const token = this.strokeToken;
  this.inputChain = this.inputChain.then(async () => {
    if (token !== this.strokeToken) return; // stroke 已结束/已切换
    if (!this.channel) return;
    await invoke('rust_brush_input', { onSync: this.channel, sessionId: this.sessionId, points, ...brushParams });
  }).catch((e) => {
    console.error(e);
    this.fallbackToTypescript();
  });

  return this.inputChain;
}

async endStroke() {
  const token = this.strokeToken;
  await this.inputChain; // 等待所有 input 发送结束
  if (token !== this.strokeToken) return;

  await invoke('rust_brush_end_stroke', { onSync: this.channel, sessionId: this.sessionId });
  ...
  this.channel = null;
}
```

这能显著降低“channel 已销毁但 Rust 还在 send”的概率，也能减少 callback id 丢失 warning（除了 HMR 强制 reload 的情况）。

---

### P0：Rust 端把重 CPU 的 stamp 循环放进 `spawn_blocking`

你现在的 `rust_brush_input` 是 `async fn`，但内部把大量 stamp 运算放在 async 任务里直接跑，会阻塞 Tauri 的 async runtime 线程，造成：

- IPC/窗口事件卡顿
- 多次 invoke 之间积压，进一步放大并发与结束时序问题

建议改成：

- 取到 `Arc<Mutex<Engine>>` 后，把计算部分 `spawn_blocking`。
- `Channel::send` 可以放在 blocking 结束后回到 async 发送（或在 blocking 内收集数据，出来再 send，你现在已经在收集）。

---

### P1：开发期（HMR/reload）要“主动停发”

如果你在 dev 环境经常 reload，建议在前端加：

- `window.addEventListener('beforeunload', ...)` 调用 `rust_brush_close`（至少移除 session，减少后台继续算）
- 或者在前端 reload 时设置一个全局 `isShuttingDown`，让 `processPoints` 不再发 invoke

但要注意：**beforeunload 未必能保证 invoke 完成**，所以这只能“减少概率”，不能 100% 消除。

---

## 3) 关于你“长期 session + 智能清空”的设计本身，有两个边界点要确认

1. **智能清空只清上一次 stroke dirty**：语义成立的前提是你的 stroke buffer 只承载“当前临时笔画层”
   如果你把所有历史都画进这个 buffer，然后每次 begin_stroke 又清 last_stroke，会把历史擦掉。你文档里写的是 “Stroke Layer”，那就 OK（临时层合成到主图层后再清）。

2. **get_sync_data() 里 `self.output_buffer.clone()` 会产生拷贝**
   你现在为了返回 `Vec<u8>` 只能 clone（因为 output_buffer 是复用 scratch）。这会带来额外内存带宽开销。性能极致时可以考虑：

- 直接 `let mut out = Vec::with_capacity(...);` 然后返回 out（不复用）
- 或者维护一个 `VecDeque<Vec<u8>>` 做 buffer 池（复用多个块，避免 clone）

这不是导致 callback warning 的原因，但会影响大笔刷高频同步时的 CPU/内存占用。

---

## 4) 结论：方案方向 OK，问题主要是 Channel/并发/重载时序

- 你现在看到的 warning **不是“CPU 笔刷方案不可行”**，而是 **“前端生命周期变化（尤其 dev reload） + Rust 仍在异步 send”** 的典型现象。
- 最优先改：**前端 input invoke 串行化 + endStroke 等待队列清空**，以及 **Rust stamp 计算 spawn_blocking**。
- dev 模式下，reload 仍可能触发一次性 warning，但不会“刷屏”；线上则基本可控。

---

Wacom 200 点/秒 ≈ **5ms/点**。这对 Tauri v2 Channel 来说不算高，但如果你“每来一个点就 invoke 一次”，就会变成 **200 次 invoke/秒**（容易堆积、并发、然后 endStroke/热重载时刷 “Couldn't find callback id”）。

更稳的做法是：**前端聚合 points，再按帧或按时间批量 invoke**；并且保证 **同一时刻只有一个 in-flight 的 rust_brush_input**。

## 推荐输入批处理参数（200Hz 场景）

### 方案 A（最推荐）：按 rAF 批处理（≈60fps）

- 每帧收集 points：200/60 ≈ **3~4 点/帧**
- 每帧最多 1 次 invoke ⇒ **~60 invoke/秒**
- 延迟：最多 1 帧（16.7ms），体感一般可接受（绘画通常被渲染/合成本身也在帧节奏里）

参数建议：

- `maxPointsPerBatch`: 16（防极端卡顿积压）
- `flushIntervalMs`: 不需要（rAF 驱动）
- `inFlight`: 串行 promise chain

### 方案 B：按时间片（更低延迟）

- 每 **8ms** flush 一次：200Hz ⇒ **~1-2 点/批**
- invoke ≈ 125 次/秒（仍可接受，但比方案 A 更吃 IPC/调度）
- 延迟 ≤ 8ms

我建议先上 **方案 A**，稳定性最好，也最容易彻底压住 callback id 警告。

---

## 前端实现要点（关键：串行 + 批处理）

1. 点来了先 push 到 `pendingPoints`
2. rAF 里把 pendingPoints “取走”组成 batch，`enqueueInvoke(batch)`
3. `enqueueInvoke` 用 `inputChain = inputChain.then(...)` 串行化
4. `endStroke` 先 `await inputChain` 再 invoke end（避免 channel 被清理但 Rust 还在 send）

下面给一个精简可用的骨架（把它融进你现有 `RustBrushReceiver` 就行）：

```ts
class RustInputScheduler {
  private pending: Array<{ x: number; y: number; pressure: number }> = [];
  private rafId: number | null = null;

  private inputChain: Promise<void> = Promise.resolve();
  private strokeToken = 0;

  constructor(private invokeInput: (points: any[]) => Promise<void>) {}

  beginStroke() {
    this.strokeToken++;
    this.pending = [];
    this.inputChain = Promise.resolve();
    this.startRaf();
  }

  pushPoint(p: { x: number; y: number; pressure: number }) {
    this.pending.push(p);
    // 可选：防爆队列（极端情况下丢中间点，只保留首尾）
    if (this.pending.length > 128) {
      const first = this.pending[0];
      const last = this.pending[this.pending.length - 1];
      this.pending = [first, last];
    }
  }

  private startRaf() {
    if (this.rafId != null) return;
    const tick = () => {
      this.flushFrame();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopRaf() {
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private flushFrame() {
    if (this.pending.length === 0) return;

    // 一帧最多发 16 点，剩下留到下一帧（防止单帧 invoke 太大）
    const batch = this.pending.splice(0, 16);
    const token = this.strokeToken;

    this.inputChain = this.inputChain.then(async () => {
      if (token !== this.strokeToken) return; // stroke 已切换/结束
      await this.invokeInput(batch);
    });
  }

  async endStrokeAndDrain() {
    // 停止继续按帧 flush
    this.stopRaf();

    // 先把剩余点也发掉
    while (this.pending.length) {
      const batch = this.pending.splice(0, 16);
      const token = this.strokeToken;
      this.inputChain = this.inputChain.then(async () => {
        if (token !== this.strokeToken) return;
        await this.invokeInput(batch);
      });
    }

    await this.inputChain;
  }
}
```

你在 `RustBrushReceiver` 里，把 `processPoints()` 改成只是 `scheduler.pushPoint(...)`，真正的 invoke 放到 `invokeInput(batch)` 里即可。

---

## Rust 侧同步阈值（配合 200Hz）

你现在 `SyncConfig`：

- `max_dabs: 4`
- `max_ms: 16`
- `max_bytes: 256KB`

配合 200Hz + 每帧 3~4 点，这组阈值是合理的：**大概率每帧都会触发一次同步**（max_ms=16 接近一帧），渲染也比较跟手。若你发现 Channel 消息太密（前端 putImageData 压力大），可以把：

- `max_ms` 调到 24~32
- 或 `max_dabs` 调到 6~8
  让一次消息覆盖更大 dirty rect，降低消息频率。

---

## 你截图的 warning 在 200Hz 下为什么更容易出现

频率高意味着：

- invoke 更密集，更容易出现“endStroke 已清理 channel，但还有 invoke 尚未返回”
- dev HMR reload 时，后台更可能仍在跑 async 操作并持续 send

上面的“按帧批处理 + 串行 in-flight + endStroke drain”会把这类问题压到最低。

---

如果你把你现在“点输入到 processPoints”的调用链（哪里收点、是否每点都调用、是否有 pointermove/coalesced events）贴一下，我可以按你实际事件源再给一个最贴合的 batching（比如用 `getCoalescedEvents()` 时每帧可能突然来几十点，策略要略调）。
