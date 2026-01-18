这份 **Revised v3** 文档写得非常出色。它不仅纠正了架构方向，更重要的是它**如实地记录了“为什么这样做”**（Why），而不仅仅是“怎么做”（How）。这对于后续维护和接手 Texture Brush 开发至关重要。

现在的设计方案在逻辑上已经**闭环**，且经过了实战验证。我只有 **3 个微小的建议**，主要是针对“阶段二（Texture Brush）”的规划和文档细节的完善，你可以根据情况选择性采纳。

---

### 1. 关于 Texture Brush 的采样方式 (技术修正)

在文档的“挑战”部分，你提到：

> _Compute Shader 不支持 `textureSample()` -> 使用 `textureLoad()` + 手动双线性插值_

**这一点其实可以更乐观一些：**
WebGPU 的 Compute Shader **是支持** `textureSampleLevel` (显式 LOD 采样) 的，通常也支持 `textureSample` (自动 LOD，虽然在 Compute 中通常等同于 LOD 0)。

- **现状**：你的 `brush_texture` (笔刷笔头纹理) 通常是只读的、标准的 `rgba8unorm` 或 `rgba16float`。只要在创建 Texture 和 Sampler 时标记了 `TextureUsage.TEXTURE_BINDING` 和 `SamplerBindingType.Filtering`，你是可以直接在 Compute Shader 里用硬件采样器的。
- **建议**：在阶段二实施时，先尝试直接用 `textureSampleLevel(brush_texture, brush_sampler, uv, 0.0)`。
- **好处**：硬件插值比手写双线性插值快得多，且代码更少。只有当笔头纹理必须是 `float32` (unfilterable) 时，才需要手写插值。

### 2. 关于 Workgroup Size 与 Shared Memory 的对应关系 (文档注释)

在 WGSL 代码段中：

```wgsl
const MAX_SHARED_DABS: u32 = 64u;
// ...
@compute @workgroup_size(8, 8) // 8x8 = 64 threads
```

**建议**：在文档或代码注释中明确指出这两个数字的**强关联性**。

- **逻辑**：正是因为 Workgroup 有 64 个线程，所以我们把 Shared Memory 设为 64，这样刚好可以**让每个线程负责加载 1 个 Dab 数据**到共享内存（Coalesced Access），这是非常高效的并行加载模式。明确这一点能防止未来有人随意修改 Workgroup Size 而忘记调整加载逻辑。

### 3. BindGroup Key 的安全性 (防御性编程)

在 TypeScript 代码段中：

```typescript
const key = `${inputTexture.label}_${outputTexture.label}`;
```

**建议**：这在当前是完美的。但为了防止未来某天创建 Texture 时忘记加 Label 或者 Label 重复（例如都叫 "temp"），可以在 `PingPongBuffer` 类中给两个纹理分配唯一的 `readonly id: number`，用 ID 做 Key 会更稳健。

- _当前文档不需要改，只是实施时的代码细节。_

---

### 结论

**这份文档不需要再做大的调整了。** 它已经是一个**Production-Ready** 的架构文档。

它完美地体现了：

1.  **Problem**: JS 侧循环导致的竞争和开销。
2.  **Solution**: Compute Shader 内循环 + 寄存器累积。
3.  **Proof**: 调试过程的教训（Local Accumulation）。

你可以放心地将此文档归档，并按照此蓝图推进后续的 Texture Brush 开发。祝贺你攻克了这个复杂的 GPU 并行渲染难题！

---

整体上 **v3 文档已经非常成熟**，结构清晰、原则正确，而且把 Phase 10 的关键教训写进去了。
如果只看“是否需要再改设计方案”，我的判断是：

✅ **核心架构无需调整（已正确）**
✅ **但仍有 5 个细节建议补强，否则未来容易踩坑**

下面给你“仅需微调”的建议（不会动核心方案），按重要性排序：

---

# ✅ 建议 1：明确 “RenderScale 坐标系契约”

你已经在 `flushBatch` 写了 dirtyRect scale，但文档里“坐标契约”没有明确约束，容易被未来改动破坏。

**建议新增小节：**

> **坐标契约（必须写清楚）**
>
> - 所有 dab 数据进入 GPU 前必须是 **纹理坐标空间**（即乘以 renderScale）。
> - dirtyRect 在逻辑空间计算，但在任何 GPU copy / scissor 操作前必须缩放。
> - 任何使用 `PingPongBuffer.copyRect` 的调用都必须使用纹理坐标。

✅ 防止后续加新渲染路径时又踩 “dirtyRect mismatch”。

---

# ✅ 建议 2：ComputeShader dispatch 必须复用 encoder

你现在的 `dispatch()` 版本（文档）是“内部创建 encoder + submit”，
但你目前真实实现里是 **外部传 encoder**。

**这件事必须在文档写清楚：**

> **重要约束：Compute dispatch 必须复用调用方 encoder**
>
> - copyRect 和 dispatch 必须在同一 encoder 录制
> - 否则无法保证执行顺序
> - 不能在 dispatch 内部新建 encoder + submit

否则以后有人“优化” dispatch 写法会复现 Phase 10 问题。

---

# ✅ 建议 3：明确 “dab_count 上限与 shared memory 对齐”

你在 WGSL 中 `MAX_SHARED_DABS = 64`，但 TS 里 `MAX_DABS_PER_BATCH = 128`。
如果你继续这样写，实际是 **128 传入 → shader 只加载 64**，导致逻辑错误。

✅ 必须在文档中写清楚：
“如果 batch 大于 shared 上限，必须分批 dispatch”，并强制一致：

```ts
const MAX_SHARED_DABS = 64;
const MAX_DABS_PER_BATCH = MAX_SHARED_DABS; // 必须一致
```

---

# ✅ 建议 4：BindGroup 缓存 Key 不应依赖 label

你文档里写的是：

```ts
const key = `${inputTexture.label}_${outputTexture.label}`;
```

**这是脆弱设计**：
label 不是强约束，未来改 label 会导致 cache miss 或 collision。

✅ 建议改为内部 ID：

```ts
const key = `${inputTexture.__id}_${outputTexture.__id}`;
```

如果不能给 texture 挂 id，就在 `PingPongBuffer` 创建时维护 `sourceId/destId`。

---

# ✅ 建议 5：Texture Brush Compute 的“采样策略”需要在文档更清晰

你现在只写 “textureLoad + 手动双线性”，但：

- textureLoad 只能整数坐标
- 需要 **明确 UV → texel 坐标映射**
- roundness + angle 的变换顺序容易出错

建议补一句：

> **采样顺序建议**：`(pixel -> dab local) -> rotate -> roundness -> aspect -> uv -> texel`

否则未来实现时很容易和 Render Pipeline 不一致。

---

# ✅ 最终结论

你的 v3 文档 **已经可以作为正式方案**，只需要加上这 5 条“边界约束”。
