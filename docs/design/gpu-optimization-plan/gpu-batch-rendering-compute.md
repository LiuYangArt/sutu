# GPU 批量渲染优化方案：Compute Shader (Revised v3)

> 基于调试经验 (Phase 10) 和外部 Review 修订，置信度：极高 (0.9)

## 背景

根据 [gpu-batch-review.md](../gpu-optimization-plan/gpu-batch-review.md) 的分析：

- **Tile-Based Instancing (方案 B) 有致命缺陷**：同一 DrawCall 中的 dab 无法看到彼此的混合结果
- **Compute Shader (方案 A) 是正确方向**：可以精确控制 per-pixel 的混合顺序

## 核心问题回顾

当前 per-dab 循环的问题：

```
64 dabs → 64 render passes → 64 次 ping-pong swap
P99 Frame: 68ms (目标 <25ms)
```

---

## 改进后的 Compute Shader 方案

### 阶段一：MVP (最小可行性) ✅ 已完成

**核心策略**：

1. **只 dispatch Bounding Box 区域**（不是全屏）
2. **Shader 内暴力循环所有 dab**（64 个对现代 GPU 是小菜）
3. **使用 Ping-Pong Buffer 保证兼容性**（Input Texture + Output Texture）

```
优化后流程:
64 dabs → 计算 bbox → 1 compute dispatch (只处理 bbox 区域)
```

> [!IMPORTANT]
> **核心原理：本地寄存器累积 (In-Register Accumulation)**
>
> 即使 GPU 是并行执行的，但对于**同一个像素**来说，它是在一个独立的线程中运行的。
>
> - **错误做法**：在 JS 端循环 dispatch。这会导致频繁的显存读写依赖，引发同步问题（调试经验 Phase 5-9）。
> - **正确做法**：在 Shader 内部循环。线程读取一次 `input_tex`，在本地变量（寄存器）中循环应用所有 Dab 的混合算法，最后只写入一次 `output_tex`。这保证了混合顺序的绝对正确，且无需担心线程间竞争。
>
> **关于混合顺序**：由于采用单次 Dispatch + Shader 内循环，像素内的混合顺序完全由 `dabs` 数组的顺序决定，这与 CPU 逻辑完全一致。无需复杂的 Barrier 或原子操作。

### 架构设计

```
┌─────────────────────────────────────────────────┐
│                  CPU 端                          │
├─────────────────────────────────────────────────┤
│  1. 收集 batch 内所有 dab 数据                   │
│  2. 计算 batch 的精确 bounding box               │
│  3. 检查 bbox 像素上限 (防止失控)                │
│  4. 上传 dab 数组到 Storage Buffer               │
│  5. dispatch compute shader (仅 bbox 区域)       │
│  6. Swap ping-pong buffers                       │
└─────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────┐
│              Compute Shader                      │
├─────────────────────────────────────────────────┤
│  每个 invocation (对应 bbox 内一个像素):          │
│  1. 全局边界保护检查                             │
│  2. 从 INPUT texture 读取当前像素颜色            │
│  3. 从 shared memory 加载 dab 数据 (优化)        │
│  4. for each dab in batch:                       │
│     - 快速距离检测 (早期剔除)                    │
│     - 如果在范围内，执行 Alpha Darken 混合       │
│  5. 写入 OUTPUT texture                          │
└─────────────────────────────────────────────────┘
```

---

## 关键约束

> [!WARNING]
> **坐标系契约 (RenderScale)**
>
> - 所有 dab 数据进入 GPU 前必须是 **纹理坐标空间**（即乘以 renderScale）
> - dirtyRect 在逻辑空间计算，但在任何 GPU copy / scissor 操作前必须缩放
> - 任何使用 `PingPongBuffer.copyRect` 的调用都必须使用纹理坐标

> [!WARNING]
> **Compute Dispatch 必须复用 encoder**
>
> - copyRect 和 dispatch 必须在同一 encoder 录制
> - 否则无法保证执行顺序
> - 不能在 dispatch 内部新建 encoder + submit

---

## WGSL Shader (当前实现)

```wgsl
// computeBrush.wgsl (简化版，完整实现见源码)

struct DabData {
  center_x: f32,          // offset 0
  center_y: f32,          // offset 4
  radius: f32,            // offset 8
  hardness: f32,          // offset 12
  color_r: f32,           // offset 16
  color_g: f32,           // offset 20
  color_b: f32,           // offset 24
  dab_opacity: f32,       // offset 28
  flow: f32,              // offset 32
  _padding0: f32,         // offset 36
  _padding1: f32,         // offset 40
  _padding2: f32,         // offset 44
};  // Total: 48 bytes (aligned)

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> dabs: array<DabData>;
@group(0) @binding(2) var input_tex: texture_2d<f32>;
@group(0) @binding(3) var output_tex: texture_storage_2d<rgba16float, write>;

// Shared Memory: 缓存 Dab 数据到 Workgroup 共享内存
// 重要：MAX_SHARED_DABS 必须等于 workgroup_size (8x8 = 64)
// 这样每个线程加载 1 个 Dab（Coalesced Access）
const MAX_SHARED_DABS: u32 = 64u;  // == workgroup_size(8,8)
var<workgroup> shared_dabs: array<DabData, MAX_SHARED_DABS>;

@compute @workgroup_size(8, 8)  // 8x8 = 64 threads, must match MAX_SHARED_DABS
fn main(@builtin(global_invocation_id) gid: vec3<u32>, ...) {
  // 1. 协作加载 Dab 数据到 Shared Memory
  if (local_idx < dabs_to_load) {
    shared_dabs[local_idx] = dabs[local_idx];
  }
  workgroupBarrier();

  // 2. 边界检查
  if (pixel out of bounds) return;

  // 3. 从 INPUT texture 读取 (一次)
  var color = textureLoad(input_tex, pixel_coord, 0);

  // 4. 遍历所有 dab，在寄存器中累积混合结果
  for (var i = 0u; i < shared_dab_count; i++) {
    let dab = shared_dabs[i];
    // 快速距离检测 + mask 计算
    let mask = compute_mask(dist, dab.radius, dab.hardness);
    // Alpha Darken 混合
    color = alpha_darken_blend(color, dab.color, mask * dab.flow, dab.dab_opacity);
  }

  // 5. 写入 OUTPUT texture (一次)
  textureStore(output_tex, pixel_coord, color);
}
```

> [!NOTE]
> **Struct 对齐教训**：WGSL 中 `vec3<f32>` 会导致 16-byte 对齐，使用独立 f32 字段避免 TS/WGSL 数据不匹配。

---

## TypeScript 集成

### flushBatch 核心逻辑

```typescript
// GPUStrokeAccumulator.ts flushBatch()

private flushBatch(): void {
  if (this.instanceBuffer.count === 0) return;

  // 1. 获取所有数据
  const dabs = this.instanceBuffer.getDabsData();
  const { buffer: gpuBatchBuffer } = this.instanceBuffer.flush();

  const encoder = this.device.createCommandEncoder();

  // 2. 计算缩放后的 dirtyRect (坐标系一致)
  const dr = this.dirtyRect;
  const scale = this.currentRenderScale;
  const copyX = Math.floor(dr.left * scale);
  const copyY = Math.floor(dr.top * scale);
  const copyW = Math.ceil((dr.right - dr.left) * scale);
  const copyH = Math.ceil((dr.bottom - dr.top) * scale);

  // 3. 复制前一帧结果到 dest (为 compute shader 准备)
  if (copyW > 0 && copyH > 0) {
    this.pingPongBuffer.copyRect(encoder, copyX, copyY, copyW, copyH);
  }

  // 4. Compute Shader 路径 (Primary)
  if (this.useComputeShader && this.computeBrushPipeline) {
    // 关键：必须一次性 dispatch 所有 dabs，绝对不要在 JS 层循环 dispatch
    const success = this.computeBrushPipeline.dispatch(
      encoder,
      this.pingPongBuffer.source,
      this.pingPongBuffer.dest,
      dabs // 传入整个数组
    );

    if (success) {
      this.pingPongBuffer.swap();
      this.device.queue.submit([encoder.finish()]);
      this.triggerPreviewUpdate();
      return;
    }
  }

  // 5. Fallback 路径 (Render Pipeline)
  this.flushBatchLegacy(encoder, dabs, gpuBatchBuffer);
  this.device.queue.submit([encoder.finish()]);
}
```

> [!CAUTION]
> **不要在 JS 层循环 dispatch**：
>
> - `dispatch()` 只是录制命令到 encoder，尚未执行
> - `swap()` 是 JS 同步操作，立即交换 texture 引用
> - 逐个 dispatch 会导致命令录制 vs 执行时机不匹配

### BindGroup 缓存策略

```typescript
private getOrCreateBindGroup(
  inputTexture: GPUTexture,
  outputTexture: GPUTexture
): GPUBindGroup {
  // 使用稳定的 Key (texture label 如 "A"/"B")
  // Ping-Pong 只有两种状态，确保只创建 2 个 BindGroup
  const key = `${inputTexture.label}_${outputTexture.label}`;

  let bindGroup = this.cachedBindGroups.get(key);
  if (!bindGroup) {
    bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.dabBuffer } },
        { binding: 2, resource: inputTexture.createView() },
        { binding: 3, resource: outputTexture.createView() },
      ],
    });
    this.cachedBindGroups.set(key, bindGroup);
  }
  return bindGroup;
}
```

> [!TIP]
> 由于 Ping-Pong Buffer 只有两种状态 (A→B 和 B→A)，Key 使用 texture label 可确保在整个笔触过程中只创建 2 个 BindGroup，避免每帧创建导致性能抖动。
>
> **实施建议**：如果未来需要更健壮的 Key，可在 `PingPongBuffer` 创建时维护 `sourceId/destId` 来替代 label。

---

## 阶段二：ABR Texture Brush Compute Shader (规划中)

### 背景

当前 ABR Texture Brush 使用 **Render Pipeline** ([TextureBrushPipeline.ts](file:///f:/CodeProjects/PaintBoard/src/gpu/pipeline/TextureBrushPipeline.ts))，尚未迁移到 Compute Shader。

### 设计思路

与 Parametric Brush 类似，但需要额外处理：

1. **纹理采样**：读取 brush tip texture (`brush_texture`)
2. **变换参数**：rotation (`angle`)、roundness、texture aspect ratio
3. **Mask 计算**：从 texture R channel 读取（而非参数化 Gaussian）

```wgsl
// 伪代码 - computeTextureBrush.wgsl

struct TextureDabData {
  center_x: f32,
  center_y: f32,
  size: f32,
  roundness: f32,
  angle: f32,             // 旋转角度
  color_r: f32,
  color_g: f32,
  color_b: f32,
  dab_opacity: f32,
  flow: f32,
  tex_width: f32,
  tex_height: f32,
};

@group(0) @binding(4) var brush_texture: texture_2d<f32>;
@group(0) @binding(5) var brush_sampler: sampler;

fn compute_texture_mask(pixel: vec2<f32>, dab: TextureDabData) -> f32 {
  // 1. 像素相对于 dab 中心的偏移
  let offset = pixel - vec2(dab.center_x, dab.center_y);

  // 2. 逆旋转
  let cos_a = cos(-dab.angle);
  let sin_a = sin(-dab.angle);
  let rotated = vec2(
    offset.x * cos_a - offset.y * sin_a,
    offset.x * sin_a + offset.y * cos_a
  );

  // 3. 归一化到 UV 空间 (考虑 roundness 和 aspect ratio)
  let half_size = dab.size / 2.0;
  let uv = (rotated / half_size + 1.0) / 2.0;
  // ... apply roundness transform

  // 4. 采样纹理
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 0.0;
  }
  return textureSample(brush_texture, brush_sampler, uv).r;
}
```

### 挑战与解决方向

| 挑战                                    | 解决方向                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Compute Shader 不支持 `textureSample()` | 先尝试 `textureSampleLevel(..., 0.0)`，只有 unfilterable 格式才需手动插值 |
| 多种 brush texture                      | 使用 Texture Array 或多次 dispatch                                        |
| 变换矩阵计算开销                        | 预计算并传入 Uniform                                                      |

> [!NOTE]
> **采样顺序建议**：`pixel -> dab local -> rotate -> roundness -> aspect -> uv -> texel`
>
> 这个顺序必须与 Render Pipeline 保持一致，否则会出现视觉差异。

### 实施优先级

目前 Texture Brush 的使用频率较低，且 Render Pipeline 已工作正常。Compute Shader 迁移作为**性能优化项**，优先级排在：

1. ✅ Parametric Brush Compute Shader（已完成）
2. 🔲 Texture Brush Compute Shader（待实施）
3. 🔲 Tile Culling 优化（dab_count >= 256 时）

---

## 阶段三优化 (未来)

### Tile Culling (当 dab_count >= 256)

```typescript
// 将画布分成 32x32 tiles
// Compute Pass 1: 生成每个 tile 的 dabList
// Compute Pass 2: 每个像素只遍历所在 tile 的 dab

if (dabs.length >= 256 || bboxPixels > 4_000_000) {
  this.dispatchWithTileCulling(dabs);
}
```

### Dab 子批次拆分

当 `dab_count > MAX_SHARED_DABS (64)` 时，自动拆分为多次 compute（见 `dispatchInBatches`）。

> [!IMPORTANT]
> **TS 和 WGSL 常量必须一致**
>
> ```typescript
> const MAX_SHARED_DABS = 64; // WGSL shared memory size
> const MAX_DABS_PER_BATCH = MAX_SHARED_DABS; // 必须一致
> ```
>
> 如果 batch 大于 shared 上限，必须分批 dispatch。

---

## 风险点与解决方案

### 1. `texture_2d<f32>` + `unfilterable-float` 格式一致性

**风险**：并非所有平台都支持 `rgba16float` 作为 `unfilterable-float` 读取。

**解决方案**：

```typescript
// 创建 texture 时确保 usage 正确
format: 'rgba16float',
usage: GPUTextureUsage.TEXTURE_BINDING |
       GPUTextureUsage.STORAGE_BINDING |
       GPUTextureUsage.COPY_SRC |
       GPUTextureUsage.COPY_DST
```

### 2. sRGB / 线性空间混合

**约束**：全程使用 **线性空间**。

- `rgba16float` 默认是线性空间
- 笔刷颜色在 CPU 端转换为线性空间后再传给 GPU
- 最终上屏时由 Canvas Context 处理 sRGB 转换

### 3. rgba16float 精度

**风险**：低 flow/低 alpha 的软笔刷可能出现精度累积误差。

**验证方法**：对比 CPU 与 GPU 的像素差异，应 < 2 (接近 1/255)。

### 4. BBox 过大 (对角线问题)

**风险**：用户从左上角划到右下角，bbox 接近全屏。

**解决方案** (已实现)：

```typescript
const MAX_PIXELS_PER_BATCH = 2_000_000;
if (bboxPixels > MAX_PIXELS_PER_BATCH) {
  this.dispatchInBatches(inputTexture, outputTexture, dabs);
}
```

---

## 性能预估

| 场景              | 当前 (per-dab) | Compute (MVP) | 预期加速 |
| ----------------- | -------------- | ------------- | -------- |
| 64 dabs, 连续笔触 | ~68ms P99      | ~8-12ms       | 5-8x     |
| 256 dabs, 大笔刷  | ~200ms+        | ~20-30ms      | 7-10x    |

---

## 实施检查清单

### Parametric Brush (圆头笔刷) ✅

- [x] 创建 `ComputeBrushPipeline` 类
- [x] 创建 `computeBrush.wgsl` shader
- [x] 修改 `GPUStrokeAccumulator.flushBatch()` 使用 compute pipeline
- [x] 添加 BindGroup 缓存 (减少 GC)
- [x] 添加 Shared Memory 优化
- [x] 添加 bbox 像素上限保护
- [x] 添加 dab 子批次拆分
- [x] 添加全局边界保护
- [x] 添加 fallback 到现有 Render Pipeline
- [x] 添加 sRGB/Linear 颜色转换
- [x] WGSL struct 对齐修复
- [x] dirtyRect 坐标缩放修复

### Texture Brush (ABR 纹理笔刷) 🔲

- [ ] 创建 `ComputeTextureBrushPipeline` 类
- [ ] 创建 `computeTextureBrush.wgsl` shader
- [ ] 实现 `textureLoad()` + 手动双线性插值
- [ ] 支持 rotation/roundness 变换
- [ ] 集成 Texture Array 或多纹理切换
- [ ] 与 `GPUStrokeAccumulator` 集成

### 验证 🔲

- [ ] 运行 Benchmark 验证 P99 Frame Time (目标 <25ms)
- [ ] 验证 Alpha Darken 混合正确性 (与 CPU 版本对比)
- [ ] 精度回归测试 (误差 < 2/255)
- [ ] 添加 WebGPU 特性检测

---

## 相关文档

- [调试记录 (gpu-compute-shader-spacing-issue.md)](file:///f:/CodeProjects/PaintBoard/docs/postmortem/gpu-compute-shader-spacing-issue.md)
- [Review 反馈 (debug_review.md)](file:///f:/CodeProjects/PaintBoard/docs/design/gpu-optimization-plan/debug_review.md)
- [TextureBrushPipeline (当前实现)](file:///f:/CodeProjects/PaintBoard/src/gpu/pipeline/TextureBrushPipeline.ts)
- [ComputeBrushPipeline (源码)](file:///f:/CodeProjects/PaintBoard/src/gpu/pipeline/ComputeBrushPipeline.ts)

---

## 评估总结

| 维度   | 评分 | 说明                                    |
| ------ | ---- | --------------------------------------- |
| 正确性 | 9/10 | 本地寄存器累积保证混合顺序              |
| 兼容性 | 8/10 | Ping-Pong 模式兼容性好，需注意 float16  |
| 性能   | 9/10 | BBox + Compute + Shared Memory 已是最优 |
| 扩展性 | 9/10 | 可逐步加 Tile Culling 和 Texture Brush  |

**总体置信度：极高 (0.9)**
