# GPU 批量渲染优化方案 A: Compute Shader

## 概述

使用 Compute Shader 替代当前的 per-dab Render Pipeline，在一次 dispatch 中处理整个 batch 的所有 dab。

## 当前问题

```
当前流程 (per-dab loop):
64 dabs → 64 render passes → 64 次 ping-pong swap
每个 pass: copyRect + beginRenderPass + draw + endRenderPass + swap
```

**开销分析**:
- GPU 命令编码开销 (setScissorRect, setPipeline, setBindGroup)
- Ping-Pong buffer 频繁交换
- `createBindGroup()` 每个 dab 调用一次

## Compute Shader 方案

### 核心思路

将画布作为 Storage Texture/Buffer，每个像素由一个 compute invocation 处理。该 invocation 遍历所有 dab，按顺序执行 Alpha Darken 混合。

```
优化后流程:
64 dabs → 1 compute dispatch → 无 ping-pong
```

### 架构设计

```
┌─────────────────────────────────────────────────┐
│                  CPU 端                          │
├─────────────────────────────────────────────────┤
│  1. 收集 batch 内所有 dab 数据                   │
│  2. 计算 batch 的 bounding box                   │
│  3. 上传 dab 数组到 Storage Buffer               │
│  4. dispatch compute shader                      │
└─────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────┐
│              Compute Shader                      │
├─────────────────────────────────────────────────┤
│  每个 invocation (对应一个像素):                  │
│  1. 读取当前像素颜色                             │
│  2. for each dab in batch:                       │
│     - 计算到 dab 中心距离                        │
│     - 如果在范围内，执行 Alpha Darken 混合       │
│  3. 写回像素颜色                                 │
└─────────────────────────────────────────────────┘
```

### WGSL Shader 设计

```wgsl
// gpu-batch-brush.wgsl

struct DabData {
  center: vec2<f32>,      // Dab 中心位置
  radius: f32,            // Dab 半径
  hardness: f32,          // 硬度 0-1
  color: vec3<f32>,       // RGB 颜色 (0-1)
  dab_opacity: f32,       // Alpha Darken 上限
  flow: f32,              // 流量
  _padding: vec3<f32>,    // 对齐到 48 bytes
};

struct Uniforms {
  canvas_size: vec2<u32>,
  dab_count: u32,
  color_blend_mode: u32,  // 0 = linear, 1 = gamma
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> dabs: array<DabData>;
@group(0) @binding(2) var canvas: texture_storage_2d<rgba32float, read_write>;

// Gaussian LUT for soft brush (可选)
@group(0) @binding(3) var<storage, read> gaussian_lut: array<f32>;

// Alpha Darken 混合函数
fn alpha_darken_blend(dst: vec4<f32>, src_color: vec3<f32>, src_alpha: f32, ceiling: f32) -> vec4<f32> {
  // 如果已达上限，不再增加 alpha
  if (dst.a >= ceiling - 0.001) {
    return dst;
  }

  let new_alpha = dst.a + (ceiling - dst.a) * src_alpha;

  var new_rgb: vec3<f32>;
  if (dst.a > 0.001) {
    new_rgb = dst.rgb + (src_color - dst.rgb) * src_alpha;
  } else {
    new_rgb = src_color;
  }

  return vec4<f32>(new_rgb, new_alpha);
}

// 计算软边缘 mask
fn compute_mask(dist: f32, radius: f32, hardness: f32) -> f32 {
  if (dist > radius) {
    return 0.0;
  }

  let normalized_dist = dist / radius;

  if (hardness >= 0.99) {
    return 1.0;
  }

  // Gaussian falloff
  let t = (normalized_dist - hardness) / (1.0 - hardness);
  if (t <= 0.0) {
    return 1.0;
  }
  return exp(-2.5 * t * t);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pixel = vec2<u32>(gid.xy);

  // 边界检查
  if (pixel.x >= uniforms.canvas_size.x || pixel.y >= uniforms.canvas_size.y) {
    return;
  }

  // 读取当前像素
  var color = textureLoad(canvas, vec2<i32>(pixel));

  // 遍历所有 dab，按顺序混合
  for (var i = 0u; i < uniforms.dab_count; i++) {
    let dab = dabs[i];
    let dist = distance(vec2<f32>(pixel), dab.center);

    // 快速剔除：距离超过半径
    if (dist > dab.radius) {
      continue;
    }

    // 计算 mask
    let mask = compute_mask(dist, dab.radius, dab.hardness);
    let src_alpha = mask * dab.flow;

    // Alpha Darken 混合
    color = alpha_darken_blend(color, dab.color, src_alpha, dab.dab_opacity);
  }

  // 写回像素
  textureStore(canvas, vec2<i32>(pixel), color);
}
```

### TypeScript 实现

```typescript
// src/gpu/ComputeBrushPipeline.ts

export class ComputeBrushPipeline {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline;
  private bindGroupLayout: GPUBindGroupLayout;
  private uniformBuffer: GPUBuffer;
  private dabBuffer: GPUBuffer;

  private maxDabs = 256; // 最大 batch 大小

  constructor(device: GPUDevice) {
    this.device = device;
    this.initPipeline();
  }

  private initPipeline() {
    // 创建 uniform buffer
    this.uniformBuffer = this.device.createBuffer({
      size: 16, // canvas_size(8) + dab_count(4) + blend_mode(4)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 创建 dab storage buffer (48 bytes per dab)
    this.dabBuffer = this.device.createBuffer({
      size: this.maxDabs * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // 创建 bind group layout
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: {
          access: 'read-write',
          format: 'rgba32float'
        }},
      ],
    });

    // 创建 compute pipeline
    this.pipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      compute: {
        module: this.device.createShaderModule({
          code: computeShaderCode, // 上面的 WGSL
        }),
        entryPoint: 'main',
      },
    });
  }

  /**
   * 执行批量渲染
   */
  dispatch(
    canvasTexture: GPUTexture,
    dabs: DabInstanceData[],
    canvasWidth: number,
    canvasHeight: number
  ): void {
    if (dabs.length === 0) return;

    // 1. 计算 bounding box
    const bbox = this.computeBoundingBox(dabs);

    // 2. 上传 uniforms
    const uniformData = new Uint32Array([
      canvasWidth, canvasHeight,
      dabs.length,
      0, // color blend mode
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    // 3. 上传 dab 数据
    const dabData = this.packDabData(dabs);
    this.device.queue.writeBuffer(this.dabBuffer, 0, dabData);

    // 4. 创建 bind group
    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.dabBuffer } },
        { binding: 2, resource: canvasTexture.createView() },
      ],
    });

    // 5. Dispatch compute shader
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);

    // 只处理 bounding box 区域 (8x8 workgroup)
    const workgroupsX = Math.ceil(bbox.width / 8);
    const workgroupsY = Math.ceil(bbox.height / 8);
    pass.dispatchWorkgroups(workgroupsX, workgroupsY);

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private computeBoundingBox(dabs: DabInstanceData[]): BoundingBox {
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const dab of dabs) {
      const r = dab.size * 1.5; // 考虑软边缘扩展
      minX = Math.min(minX, dab.x - r);
      minY = Math.min(minY, dab.y - r);
      maxX = Math.max(maxX, dab.x + r);
      maxY = Math.max(maxY, dab.y + r);
    }

    return {
      x: Math.floor(minX),
      y: Math.floor(minY),
      width: Math.ceil(maxX - minX),
      height: Math.ceil(maxY - minY),
    };
  }

  private packDabData(dabs: DabInstanceData[]): Float32Array {
    const data = new Float32Array(dabs.length * 12); // 48 bytes = 12 floats

    for (let i = 0; i < dabs.length; i++) {
      const dab = dabs[i];
      const offset = i * 12;
      data[offset + 0] = dab.x;
      data[offset + 1] = dab.y;
      data[offset + 2] = dab.size;
      data[offset + 3] = dab.hardness;
      data[offset + 4] = dab.r;
      data[offset + 5] = dab.g;
      data[offset + 6] = dab.b;
      data[offset + 7] = dab.dabOpacity;
      data[offset + 8] = dab.flow;
      // padding [9-11]
    }

    return data;
  }
}
```

## 优势

| 优势 | 说明 |
|------|------|
| **无 ping-pong** | Storage Texture 支持 read-write，无需双缓冲 |
| **一次 dispatch** | 64 个 dab → 1 次 GPU 命令提交 |
| **自动顺序处理** | 每个像素按 dab 顺序遍历，保证 Alpha Darken 正确性 |
| **Bounding Box 优化** | 只 dispatch 受影响区域 |

## 劣势与挑战

| 挑战 | 解决方案 |
|------|---------|
| **每像素遍历所有 dab** | 对于稀疏 dab 分布，浪费计算。可用 tile culling 优化 |
| **Storage Texture 格式限制** | 需要 `rgba32float`，内存占用较大 |
| **WebGPU 兼容性** | `read-write` storage texture 需要 Chromium 120+ |

## 性能预估

| 场景 | 当前 (per-dab) | Compute Shader | 加速比 |
|------|---------------|----------------|--------|
| 64 dabs, 1920x1080 | ~68ms P99 | ~10-15ms | 4-6x |
| 256 dabs, 4K | ~200ms+ | ~30-40ms | 5-7x |

## 实施建议

1. **检查 WebGPU 支持**: 确认目标平台支持 `read-write` storage texture
2. **渐进式集成**: 保留现有 Render Pipeline 作为 fallback
3. **性能对比**: 实现后对比两种方案的 P99 Frame Time

## 参考资料

- [WebGPU Compute Shader 最佳实践](https://toji.dev/webgpu-best-practices/)
- [Storage Texture 规范](https://www.w3.org/TR/webgpu/#texture-usage)
