# GPU Dab Buffer 优化方案

## 背景

在实现 GPU roundness 支持时，发现了几个可以优化的性能点。这些优化涉及较大范围的架构重构，建议单独 issue 实施。

> **更新 (2026-01-23)**: 本文档提出的 "P1: 冗余数据打包" 优化已确认为修复 `docs/postmortem/2026-01-23-gpu-roundness-missing-fields.md` 中描述的系统性缺陷的关键方案。此外，新增了 Eraser (橡皮擦) 支持方案。

## 当前架构问题

### 1. 冗余数据打包（影响：中等）

**现状**：数据流存在两次转换

```
InstanceBuffer.push() → Float32Array
     ↓
getDabsData() → DabInstanceData[] 对象数组
     ↓
ComputeBrushPipeline.packDabData() → Float32Array
     ↓
writeBuffer() → GPU
```

**问题**：

- 每批次创建 N 个 `DabInstanceData` 对象 → GC 压力
- 两次遍历数组（getDabsData + packDabData）
- 内存拷贝开销
- **维护成本高**：每次`DabInstanceData`结构变更（如新增字段）都需要修改 Interface, push(), packDabData() 等多处，极易遗漏（见 `2026-01-23-gpu-roundness-missing-fields.md`）。

**优化方案**：直接复用 `InstanceBuffer` 的 `Float32Array`，并引入**类型安全索引**。

```typescript
// 新增方法：直接返回原始数据
getRawData(): { data: Float32Array; count: number } {
  return {
    data: this.cpuData.subarray(0, this.pendingCount * DAB_FLOATS_PER_INSTANCE),
    count: this.pendingCount
  };
}
```

**预估收益**：减少 ~30% 的 CPU 开销（对象创建 + 数组遍历）

---

### 2. 重复 GPU Buffer 上传（影响：中等）

**现状**：

- `InstanceBuffer` 维护一个 `GPUBuffer`（用于 Vertex Pipeline）
- `ComputeBrushPipeline` 维护另一个 `dabBuffer`（用于 Compute Pipeline）
- 每次 flush 时，同样的数据被 `writeBuffer` 两次

**优化方案**：统一 Buffer，同时支持 VERTEX 和 STORAGE

```typescript
// InstanceBuffer 构造函数修改
this.buffer = device.createBuffer({
  size: capacity * DAB_INSTANCE_SIZE,
  usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});
```

**细节完善**：
由于 Compute Shader 单次 dispatch 限制了 `MAX_SHARED_DABS` (128)，我们不能简单地一次性处理整个 buffer。

- **方案 A (简单)**：循环创建 BindGroup，每次偏移 128 \* 48 bytes。
- **方案 B (高效)**：使用 **Dynamic Offsets**。在 `setBindGroup` 时传入偏移量，复用同一个 BindGroup。

`InstanceBuffer` 需要提供方法来获取底层的 `GPUBuffer` 和当前有效数据的字节大小。

**预估收益**：减少 50% 的 GPU 上行带宽

---

### 3. Bounding Box 重复计算（影响：低）

**现状**：

- `InstanceBuffer.push()` 已维护 `minX/minY/maxX/maxY`
- `ComputeBrushPipeline.dispatch()` 又调用 `computePreciseBoundingBox()` 重新遍历

**优化方案**：直接使用 `InstanceBuffer.getBoundingBox()` 结果

```typescript
// GPUStrokeAccumulator.flushBatch()
const bbox = this.instanceBuffer.getBoundingBox();
// 直接传给 computePipeline，无需重新计算
```

**预估收益**：减少一次 O(N) 遍历

---

### 4. GPU 端优化（影响：低）

**现状**：

- `compute_ellipse_distance()` 使用 `sqrt()` 计算距离
- Early culling 可以用距离平方避免开方

**优化方案**：

```wgsl
// 早期剔除用距离平方
let quick_dist_sq = dot(delta, delta);
if (quick_dist_sq > effective_radius * effective_radius) {
  continue;
}
```

**预估收益**：减少 ~5% GPU 计算量

---

### 5. CPU 预计算 1/roundness（影响：低）

**现状**：GPU 端每像素执行 `rotated_y / dab.roundness`

**优化方案**：CPU 端预计算倒数

```typescript
// GPUStrokeAccumulator
const invRoundness = 1.0 / roundness;
// 传给 GPU
```

```wgsl
// WGSL
let scaled_y = rotated_y * dab.inv_roundness; // 乘法比除法快
```

**预估收益**：减少 ~2% GPU 计算量

**预估收益**：减少 ~2% GPU 计算量

---

### 6. Eraser (橡皮擦) 支持 (新增，Bug Fix)

**现状**：
目前 GPU 后端完全不支持橡皮擦模式。`GPUStrokeAccumulator` 接收的 `color` 参数即使是白色也只是叠加颜色，且 Shader 中没有处理 Erase 混合模式。

**设计方案**：利用 `dabOpacity` 字段的符号位传递 Eraser 状态，避免修改 Buffer 结构。

1.  **前端 (`GPUStrokeAccumulator.ts`)**:
    - `stampDab` 接收 `blendMode` 参数。
    - 如果是 Eraser 模式，将 `dabOpacity` 设为负值（例如 `-params.dabOpacity`）。
    - 确保 `params.dabOpacity` 始终非负。

2.  **Shader (`computeBrush.wgsl`)**:

    ```wgsl
    // 解码
    let is_eraser = dab.dab_opacity < 0.0;
    let opacity = abs(dab.dab_opacity);

    if (is_eraser) {
       // Eraser Logic: DST_OUT
       // strength = flow * opacity * mask
       let strength = dab.flow * opacity * mask;
       color.a = color.a * (1.0 - strength);
       // RGB 保持不变 (或者乘以 alpha，取决于是否预乘)
    } else {
       // Existing Alpha Darken Logic
    }
    ```

**优势**：

- **Zero Overhead**: 不需要增加 Buffer 大小（保持 48 bytes 对齐）。
- **兼容性好**: 浮点数符号位检测非常快。

## 优先级建议

| 优化项             | 影响 | 复杂度 | 优先级 |
| ------------------ | ---- | ------ | ------ |
| 冗余数据打包       | 中   | 中     | P1     |
| 重复 Buffer 上传   | 中   | 高     | P2     |
| BBox 重复计算      | 低   | 低     | P3     |
| GPU sqrt 优化      | 低   | 低     | P3     |
| 预计算 1/roundness | 低   | 低     | P4     |

## 实施建议

1. **P1 优化可独立实施**：只需修改 `InstanceBuffer` 和 `ComputeBrushPipeline` 的接口
2. **P2 优化需要更大重构**：涉及 Pipeline 绑定逻辑，建议与其他 GPU 架构改进一起做
3. **P3/P4 优化收益有限**：可以在其他重构时顺便做

## 相关文件

- `src/gpu/resources/InstanceBuffer.ts`
- `src/gpu/pipeline/ComputeBrushPipeline.ts`
- `src/gpu/GPUStrokeAccumulator.ts`
- `src/gpu/shaders/computeBrush.wgsl`
