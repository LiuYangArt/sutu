作为一个资深的图形架构师和软件开发人员，我仔细审阅了这份《GPU-First 笔刷与渲染架构设计》草案。

### **总体评价：置信度高 (High Confidence)**

**评分：8.5/10**

这份设计文档非常扎实，**方向完全正确**。它敏锐地抓住了 Web 端高性能绘图的核心痛点——CPU/GPU 带宽瓶颈（Readback），并提出了标准的行业解决方案（Tile 化、虚拟纹理、全 GPU 流程）。针对 8K 这一极高目标，采用“稀疏存储 + LRU”是唯一可行的路径。

然而，从“设计草案”到“落地代码”，在 **显存管理细节**、**图块边缘伪影处理** 和 **色彩精度** 三个方面还存在潜在陷阱。

以下是具体的 Review 意见和优化建议：

---

### 一、 关键风险点与优化建议

#### 1. 色彩精度的陷阱：`rgba8unorm` 存线性空间 (Critical)

**文档现状**：3.1 节提到 _Layer 存储：`rgba8unorm`（线性空间）_。
**问题分析**：这是一个高风险决策。8-bit 只有 256 个色阶。如果存储的是 **线性（Linear）** 数据，暗部的精度会极度压缩，导致严重的色带（Banding）现象。sRGB（Gamma 2.2）曲线存在的意义就是利用人眼特性，把 8-bit 精度更多分配给暗部。
**优化建议**：

- **方案 A（推荐）**：Layer 存储使用 `rgba8unorm-srgb` 格式。WebGPU 硬件会自动在读取时解码为线性浮点（供混合计算），写入时编码回 sRGB。这样既保证了混合的数学正确性（在线性空间），又保证了存储的感知精度。
- **方案 B**：如果坚持 `rgba8unorm` 存线性，则 **必须** 在混合写入层时实施非常激进的 Dither（抖动），但这会引入噪点。
- **结论**：强烈建议改为 `rgba8unorm-srgb` 用于存储，计算保持 Linear。

#### 2. Tile 拼接处的“接缝”与采样伪影 (Filtering Artifacts)

**文档现状**：3.2 节提到 Tile 切分，但未提及 Padding 或 Sampling 策略。
**问题分析**：当笔刷跨越 Tile 边界，或者缩放画布进行 Bilinear 插值显示时，如果直接采样 Tile 边缘，纹理采样器会采样到 Tile 外部（通常是 Clamp to Edge 的颜色，或者是空的）。这会导致 Tile 之间出现可见的接缝或黑线。
**优化建议**：

- **方案 A（Padding）**：每个 Tile 物理纹理大小为 `(Size + 2 * Padding)`，例如 512x512 的内容存为 514x514 的纹理，边缘 1px 复制相邻像素。这会增加显存和更新开销。
- **方案 B（Shader控制）**：在 Shader 中手动实现双线性插值（fetch 4个点），并严格限制坐标不越界。
- **方案 C（仅显示缩放时）**：如果画布是 1:1 显示，使用 `nearest` 采样；只有在 Zoom out 时使用 Mipmap 或 Padding。
- **补充**：对于笔刷合成（Composite），通常是 1:1 像素对齐的，可以用 `LoadOp` 或整数坐标 `textureLoad` 避免插值问题，这点需要在开发阶段特别注意。

#### 3. 浏览器显存上限 vs 物理显存 (Browser Limits)

**文档现状**：目标是 32GB 显卡跑 8K。
**问题分析**：虽然显卡有 32GB，但 Chrome/Edge 对单个 Tab 或 WebGPU Context 通常有 **配额限制**（例如 2GB - 8GB 不等，取决于 OS 实现）。即便物理显存够，浏览器也可能 Crash。
**优化建议**：

- **被动防御**：在 3.6 设备探测中，不要只信赖 `navigator.deviceMemory` 或 Adapter Info，需要通过分配测试（Allocation Probe）来探测实际可用显存上限。
- **Tile 压缩**：对于非 Active Layer，如果不进行频繁编辑，可以考虑是否引入压缩纹理（如 BC7/ASTC，虽然 WebGPU 运行时生成压缩纹理很慢，但可以作为“长期不活动层”的归档手段，但这可能过于复杂，暂且作为备选）。
- **显存预算**：LRU 的预算不能是物理显存的 100%，建议设定为浏览器配额的 60%-70%。

---

### 二、 架构设计的微调

#### 1. 提交笔触 (Commit Stroke) 的优化

**文档现状**：`activeScratch + activeLayer -> activeLayerTmp`，然后 Swap。
**优化建议**：

- **局部更新 (Dirty Rect)**：8K 画布非常大，如果画一笔只改动了左上角一个 Tile，绝对不要全屏合成。
- **Tile 级 Ping-Pong**：只需要对 **受影响的 Tile** 进行 Ping-Pong 和 Swap。未被笔触覆盖的 Tile 句柄直接从旧 Layer 复制到新 Layer（或者仅修改指针引用，如果 Layer 只是 Tile 的集合）。
- **Sparse Allocation**：如果笔触画到了一个原本是“空”的区域，此时才动态分配该位置的 Tile。

#### 2. 合成缓存 (Composite Cache) 的颗粒度

**文档现状**：`belowComposite` 和 `aboveComposite` 缓存。
**优化建议**：

- 这些缓存也应该是 **Tile 化** 的。
- 场景：我在 Layer 5 画画。
  - Layer 1-4 的对应 Tile 合成 -> 写入 `BelowCompositeTile[x,y]`。
  - 如果 Layer 2 的 Opacity 变了，标记 Layer 2 所有的 Tile 为 Dirty，下一帧只需重绘 `BelowComposite` 涉及的 Tile。
  - **关键点**：不要维护一张巨大的 8K 离屏纹理作为 `belowComposite`，它也应该是由 Tile 组成的虚拟纹理，或者直接是 Screen Size 的纹理（视口大小，非画布大小）。**强烈建议 `below/above` composite 缓存仅针对当前 Viewport 大小，而不是全画布 8K 大小，以节省显存。** (这一点非常重要，能极大降低显存压力)

---

### 三、 具体的阶段任务补充 (Actionable Items)

建议在您的 M0-M5 计划中补充以下技术验证点：

#### Phase 0 (基线)

- **[新增]**：验证 `rgba8unorm-srgb` vs `rgba8unorm` 在混合叠加多次后的色彩差异。
- **[新增]**：WebGPU 显存OOM（Out of Memory）恢复机制原型。如果 LRU 满了或者浏览器报错，如何优雅地从 System Memory 恢复 Tile。

#### Phase 1 (Tile)

- **[新增]**：实现“稀疏索引纹理”（Sparse Index Buffer/Map），即一个 JS `Map<TileKey, TextureView>`，确保空区域不占用 VRAM。

#### Phase 2 (笔刷)

- **[改进]**：实现基于 AABB（包围盒）的 Scissor Test，确保 Shader 只在笔刷影响的像素范围内运行。

#### Phase 4 (导出)

- **[特别注意]**：导出 8K 图片时，浏览器可能会杀掉 GPU 进程（TDR）。
- **策略**：导出必须分块进行（Readback chunk by chunk），比如每次读 2048x2048，在 CPU 拼好，防止 GPU 超时。

---

### 四、 总结代码示例 (伪代码)

为了帮助你理解 Tile 管理和 Ping-Pong 的核心逻辑，这里给出一个 TS 伪代码结构：

```typescript
// Tile 的唯一标识
type TileKey = string; // e.g., "x_y"

class Layer {
  // 稀疏存储：只存储有内容的 Tile
  tiles: Map<TileKey, GPUTexture>;

  // 获取某个位置的 Tile，如果没有则返回空或创建
  getTile(x: number, y: number): GPUTexture | null { ... }
}

class StrokeCommitter {
  // 优化：仅针对受影响的 Tile 进行 Commit
  commit(
    activeLayer: Layer,
    scratchTexture: GPUTexture, // 包含了当前笔触的临时纹理
    affectedRegion: Rect // 笔触包围盒
  ) {
    const tileKeys = getTilesInRect(affectedRegion);

    for (const key of tileKeys) {
      const originalTile = activeLayer.tiles.get(key);
      // 从池中获取一个新 Tile
      const newTile = TileMemoryManager.allocate();

      // 执行 Shader: Blend(originalTile, scratch) -> newTile
      this.runComputeShader(originalTile, scratchTexture, newTile);

      // 更新 Layer 引用
      activeLayer.tiles.set(key, newTile);

      // 回收旧 Tile (延迟回收以防还在被 Display 使用)
      TileMemoryManager.release(originalTile);
    }
  }
}
```

### 最终结论

这份文档是高质量的，方案可行。
**最需要改进的唯一也是最大的一点是：3.1 节关于 `rgba8unorm` (Linear) 的存储格式决策，建议复核并改为 `srgb` 格式存储或增加高强度 Dither 策略。** 此外，务必明确“合成缓存”是基于 Viewport 的还是全画布的（建议基于 Viewport 或稀疏 Tile）。
