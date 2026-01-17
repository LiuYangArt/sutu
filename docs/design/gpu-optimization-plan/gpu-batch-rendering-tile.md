# GPU 批量渲染优化方案 B: Tile-Based 批量渲染

## 概述

保留现有 Render Pipeline 架构，通过将画布分成 tile 来减少 render pass 数量。每个 tile 内的 dab 在一个 render pass 中批量渲染。

## 当前问题

```
当前流程 (per-dab loop):
64 dabs → 64 render passes → 64 次 ping-pong swap
```

## Tile-Based 方案

### 核心思路

将画布分成固定大小的 tile (如 256x256 像素)，将 dab 按其覆盖的 tile 分组。每个 tile 只需一个 render pass，在该 pass 中使用 GPU Instancing 批量绘制所有影响该 tile 的 dab。

```
优化后流程:
64 dabs → ~4-8 tiles → 4-8 render passes
(假设 dab 分布在 4-8 个 tile 内)
```

### 架构设计

```
┌─────────────────────────────────────────────────┐
│                  CPU 端                          │
├─────────────────────────────────────────────────┤
│  1. 收集 batch 内所有 dab 数据                   │
│  2. 计算每个 dab 覆盖的 tile 列表                │
│  3. 按 tile 分组 dab                             │
│  4. 对每个非空 tile:                             │
│     a. 设置 scissor rect 为 tile 区域           │
│     b. 一次 draw call 渲染该 tile 的所有 dab    │
│     c. ping-pong swap (每 tile 一次)            │
└─────────────────────────────────────────────────┘
```

### 关键改进

| 对比项 | 当前 per-dab | Tile-Based |
|--------|-------------|------------|
| Render Pass 数量 | N (dab 数量) | M (活跃 tile 数量) |
| Ping-Pong Swap | N 次 | M 次 |
| Draw Call | N 次 | M 次 (每次多实例) |
| CopyRect | N 次 | M 次 |

对于典型绘画场景 (连续笔触)，dab 通常集中在 2-4 个 tile 内，减少 90%+ 的开销。

### TypeScript 实现

```typescript
// src/gpu/TiledBrushRenderer.ts

const TILE_SIZE = 256; // pixels

interface TileKey {
  tx: number;
  ty: number;
}

interface TileDabs {
  key: TileKey;
  dabs: DabInstanceData[];
  dabIndices: number[]; // 在原 buffer 中的索引
}

export class TiledBrushRenderer {
  private device: GPUDevice;
  private pingPongBuffer: PingPongBuffer;
  private brushPipeline: BrushPipeline;
  private instanceBuffer: InstanceBuffer;

  /**
   * 将 dab 按 tile 分组
   */
  private groupDabsByTile(dabs: DabInstanceData[]): Map<string, TileDabs> {
    const tileMap = new Map<string, TileDabs>();

    for (let i = 0; i < dabs.length; i++) {
      const dab = dabs[i];
      const radius = dab.size * 1.5; // 考虑软边缘

      // 计算 dab 覆盖的 tile 范围
      const minTileX = Math.floor((dab.x - radius) / TILE_SIZE);
      const maxTileX = Math.floor((dab.x + radius) / TILE_SIZE);
      const minTileY = Math.floor((dab.y - radius) / TILE_SIZE);
      const maxTileY = Math.floor((dab.y + radius) / TILE_SIZE);

      // 将 dab 添加到所有覆盖的 tile
      for (let ty = minTileY; ty <= maxTileY; ty++) {
        for (let tx = minTileX; tx <= maxTileX; tx++) {
          const key = `${tx},${ty}`;
          if (!tileMap.has(key)) {
            tileMap.set(key, {
              key: { tx, ty },
              dabs: [],
              dabIndices: [],
            });
          }
          const tile = tileMap.get(key)!;
          tile.dabs.push(dab);
          tile.dabIndices.push(i);
        }
      }
    }

    return tileMap;
  }

  /**
   * 批量渲染 (Tile-Based)
   */
  flushBatchTiled(dabs: DabInstanceData[]): void {
    if (dabs.length === 0) return;

    // 1. 按 tile 分组
    const tileMap = this.groupDabsByTile(dabs);

    // 2. 按 tile 顺序排序 (保证渲染顺序一致)
    const sortedTiles = Array.from(tileMap.values()).sort((a, b) => {
      if (a.key.ty !== b.key.ty) return a.key.ty - b.key.ty;
      return a.key.tx - b.key.tx;
    });

    const encoder = this.device.createCommandEncoder();

    // 3. 对每个 tile 执行渲染
    for (const tile of sortedTiles) {
      this.renderTile(encoder, tile);
    }

    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * 渲染单个 tile
   */
  private renderTile(encoder: GPUCommandEncoder, tile: TileDabs): void {
    const { tx, ty } = tile.key;

    // 计算 tile 的 scissor rect
    const scissorX = Math.max(0, tx * TILE_SIZE);
    const scissorY = Math.max(0, ty * TILE_SIZE);
    const scissorW = Math.min(TILE_SIZE, this.pingPongBuffer.width - scissorX);
    const scissorH = Math.min(TILE_SIZE, this.pingPongBuffer.height - scissorY);

    if (scissorW <= 0 || scissorH <= 0) return;

    // 上传该 tile 的 dab 数据到 instance buffer
    const dabData = this.packDabData(tile.dabs);
    this.device.queue.writeBuffer(this.instanceBuffer.gpuBuffer, 0, dabData);

    // 复制 source 到 dest (只复制 tile 区域)
    this.pingPongBuffer.copyRect(encoder, scissorX, scissorY, scissorW, scissorH);

    // 创建 render pass
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.pingPongBuffer.dest.createView(),
        loadOp: 'load',
        storeOp: 'store',
      }],
    });

    pass.setScissorRect(scissorX, scissorY, scissorW, scissorH);
    pass.setPipeline(this.brushPipeline.renderPipeline);
    pass.setBindGroup(0, this.brushPipeline.createBindGroup(this.pingPongBuffer.source));
    pass.setVertexBuffer(0, this.instanceBuffer.gpuBuffer);

    // 一次 draw call 绘制所有 dab
    pass.draw(6, tile.dabs.length);
    pass.end();

    // Swap ping-pong
    this.pingPongBuffer.swap();
  }

  private packDabData(dabs: DabInstanceData[]): Float32Array {
    const data = new Float32Array(dabs.length * 9); // 36 bytes = 9 floats

    for (let i = 0; i < dabs.length; i++) {
      const dab = dabs[i];
      const offset = i * 9;
      data[offset + 0] = dab.x;
      data[offset + 1] = dab.y;
      data[offset + 2] = dab.size;
      data[offset + 3] = dab.hardness;
      data[offset + 4] = dab.r;
      data[offset + 5] = dab.g;
      data[offset + 6] = dab.b;
      data[offset + 7] = dab.dabOpacity;
      data[offset + 8] = dab.flow;
    }

    return data;
  }
}
```

### Shader 变化

**无需修改现有 shader**。Tile-Based 方案完全复用现有的 `brush.wgsl`，只是改变了 CPU 端的批处理逻辑。

### 处理跨 Tile 边界的 Dab

当一个 dab 跨越多个 tile 时，它会被添加到所有覆盖的 tile。这意味着：

1. **同一个 dab 可能被渲染多次** (每个 tile 一次)
2. **需要保证 Alpha Darken 的正确性**

解决方案：

```typescript
// 每个 dab 只在第一次出现时完整渲染
// 后续 tile 中的相同 dab 使用 clip 限制到 tile 边界

// 或者：使用 stencil buffer 标记已渲染区域
// (更复杂，但更精确)
```

**简化方案**：由于 Alpha Darken 是幂等的 (重复应用不会改变结果，只要 alpha 已达上限)，可以允许边界 dab 在多个 tile 中渲染。

## 优势

| 优势 | 说明 |
|------|------|
| **复用现有架构** | 无需重写 shader，只修改 CPU 调度 |
| **渐进式改进** | 可以逐步优化，不影响现有功能 |
| **保守的兼容性** | 不依赖新 WebGPU 特性 (如 read-write storage texture) |
| **可预测的性能** | 开销与活跃 tile 数量成正比 |

## 劣势

| 劣势 | 说明 |
|------|------|
| **仍需 ping-pong** | 每个 tile 仍需 swap，只是次数减少 |
| **边界 dab 冗余** | 跨 tile 的 dab 可能被多次渲染 |
| **tile 数量依赖笔触分布** | 如果笔触很分散，可能没有明显收益 |

## 性能预估

| 场景 | 当前 (per-dab) | Tile-Based | 加速比 |
|------|---------------|------------|--------|
| 64 dabs, 连续笔触 | ~68ms P99 | ~15-20ms | 3-4x |
| 64 dabs, 分散 | ~68ms P99 | ~40-50ms | 1.5-2x |
| 256 dabs, 连续笔触 | ~200ms+ | ~25-35ms | 6-8x |

## 与 Compute Shader 方案对比

| 对比项 | Compute Shader | Tile-Based |
|--------|---------------|------------|
| 实现复杂度 | 高 | 中 |
| 兼容性 | 需要 read-write storage | 更广泛 |
| 性能上限 | 更高 | 中等 |
| 风险 | 中 | 低 |
| 代码改动 | 大 (新 pipeline) | 中 (修改现有) |

## 实施建议

1. **先实施 Tile-Based** - 风险低，收益确定
2. **如果不满足需求** - 再考虑 Compute Shader
3. **可以两者结合** - Tile-Based 分组 + Compute Shader 渲染

## Tile 大小选择

| Tile Size | 优势 | 劣势 |
|-----------|------|------|
| 128x128 | 更精细的裁剪 | 更多 render pass |
| 256x256 | 平衡 | 推荐默认值 |
| 512x512 | 更少 render pass | 裁剪效果差 |

推荐使用 **256x256**，这是大多数 GPU tile-based renderer 的常见选择。

## 参考资料

- [Tile-Based Deferred Rendering](https://www.khronos.org/opengl/wiki/Tile-Based_Rendering)
- [WebGPU Scissor Test](https://www.w3.org/TR/webgpu/#dom-gpurenderpassencoder-setscissorrect)
