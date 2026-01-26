整体上 v1.5 比 v1.4 成熟很多：**双矩形语义 + Arc 分离锁 + bitmap 串行链**把之前最危险的 correctness/perf 风险都补上了。以 Windows/WebView2 为目标也让不确定性明显降低。

我会把这版的**总体置信度从文档的 80% 调到 88%**（主要是还剩几个“会导致编译失败/行为不符合预期”的点需要再收一下口）。

---

## 1) P0：当前文档代码在 Rust 侧会“编译不过”

### 1.1 `last_activity` 字段可见性问题（必修）

`StreamingBrushEngine` 里：

```rust
last_activity: Instant,
```

在 `commands.rs` 的 `rust_brush_cleanup()` 里直接访问：

```rust
now.duration_since(engine.last_activity)
```

如果 `commands.rs` 和 `streaming.rs` 不在同一个模块（大概率不是），这会因为字段私有导致**无法编译**。

**修正方案（任选其一）：**

- 方案 A（推荐，最小改动）：把字段改成 `pub(crate) last_activity: Instant`
- 方案 B：提供 getter：
  ```rust
  impl StreamingBrushEngine {
      pub fn last_activity(&self) -> Instant { self.last_activity }
  }
  ```
  cleanup 里用 `engine.last_activity()`。

---

## 2) P0：begin/end 的语义与“end 会移除 session”存在冲突

文档 3.1 写：

- `end_stroke()` **移除 session**（释放内存）

但代码里实际是：

- Rust 有 `engine.end_stroke()`（保存 last_stroke_dirty）
- 然后 `manager.remove_session()`（真正释放内存）

这两者**同时存在会导致一个问题**：
如果 session 在 stroke 结束就移除，那么 `last_stroke_dirty` 的“智能清空价值”只在“同一 session 下连续 begin_stroke”才成立；但你这里每次 stroke end 都 remove session，下一次 stroke 会创建新 engine，新 buffer，`last_stroke_dirty` 根本用不上。

**结论：要二选一并写死语义：**

- **路线 A（更简单/更符合你现在的代码）：每个 stroke 一个 session**
  - 那就不需要 `last_stroke_dirty` / `begin_stroke` 智能清空，直接在 `new()` 初始化透明即可；或者把“智能清空”下沉到“同一 stroke 内多次 begin”（但通常没有）。
- **路线 B（更高性能/更符合“智能清空”设计初衷）：一个画布一个长期 session**
  - `end_stroke()` 不 remove session，只是结束当前 stroke；画布关闭/切引擎时才 remove session。
  - 这样 `last_stroke_dirty` 才真正减少下一次 stroke 的清空成本，并减少频繁分配 64MB buffer。

你当前设计（既有智能清空又每次 end remove）逻辑上有点“打架”。建议在文档里明确选哪条路线，否则实现时很容易出现“看似优化，实际无效”。

---

## 3) P1：mask cache 的量化桶 key 与实际参数可能不一致

你缓存 key 用了量化后的 `(radius*50).round()`，但生成 `GaussParams::new(hardness, radius, roundness)` 用的是**原始 radius**。

这意味着：两个半径落在同一个桶里会复用同一个 `GaussParams`，但实际 `radius` 不同，**渲染可能出现轻微尺寸误差**（尤其是 2% 桶在大笔刷时误差会被放大到几个像素边缘差异）。

**建议**（二选一）：

- 要“结果严格正确”：key 不做 radius 桶（或桶更细），用真实 radius 缓存（命中率下降）。
- 要“容差换命中率”：缓存命中时也要用“桶中心半径”生成 params，例如：
  - `quant_radius = key0 as f32 / 50.0`
  - `GaussParams::new(hardness, quant_radius, roundness)`

这样“桶缓存”的语义自洽。

---

## 4) P1：前端 `createImageBitmap` 路径的 GC/分配压力偏大

当前 bitmap 路径每条消息都会：

- new `Uint8ClampedArray(...)`
- new `ImageData(...)`
- await `createImageBitmap(imageData, ...)`

在 Windows/Chromium 上这通常能跑，但在高频同步（例如 60fps、每帧多条 dirty rect）时，**JS 分配与 GC 可能成为隐形抖动来源**。

**可做的优化（不影响架构，Phase 0.5/1 再做都行）：**

- bitmap 路径也做 `ImageData` 复用（像 putImageData 那样按 w/h 复用一个或少量缓存），至少减少 `new ImageData`。
- 或者把同步策略调粗一点：降低消息数（提高 `max_dabs` 或 `max_bytes`），让每帧最多 1 条渲染消息。

---

## 5) P2：几个小的实现细节（不改也能跑，但建议收口）

- `clear_rect(&self.last_stroke_dirty.clone())` 这类 clone 没必要，直接传引用即可（除非 `clear_rect` 需要拥有）。
- `get_sync_data()` 里 `reserve(total_size - capacity)` 没问题，但建议用 `len()` 来估算更准确（否则 capacity 已足够但 len 未清，逻辑依赖 clear 之后 len=0，你现在是 clear 了，OK）。
- `bitmapChain` 会无限增长链长度（虽然每次 resolve 释放上一个闭包），一般 OK；如果担心极端情况，可定期“截断”：`if (this.bitmapChainSettled) this.bitmapChain = Promise.resolve()` 之类。

---

## 建议你在文档 v1.6 里明确的“决策点”（非常关键）

1. **session 生命周期**：每 stroke 结束就 remove，还是每画布长期持有？（这决定智能清空是否有意义）
2. **mask cache 容差策略**：是否允许 2% 半径误差？允许的话，用桶中心半径生成 params，保证一致性。
3. **前端默认渲染策略**：Windows 下可以把默认切到 `createImageBitmap` 还是坚持 putImageData？建议 Phase 0.5 实测后定。

如果你告诉我你倾向路线 A 还是 B（session 生命周期），我可以把 Rust 侧的 API（start/begin/input/end/cleanup）按最终语义再帮你收敛一版，避免实现和文档继续“交叉拧巴”。
