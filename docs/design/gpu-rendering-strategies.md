# GPU 渲染策略研究：WebGPU vs Makepad

## 背景

当前软笔刷性能优化已达到 JS + Canvas 2D 的极限。大尺寸笔刷（500px+）仍有明显瓶颈。需要探索 GPU 加速方案以突破性能天花板。

本文档研究两个可行方向：
1. **WebGPU Compute Shader** - 在现有 Tauri + React 架构上增加 GPU 计算能力
2. **Rust Makepad** - 完全重写为原生 GPU 渲染框架

## 方案一：WebGPU Compute Shader

### 概述

WebGPU 是 WebGL 的下一代替代品，提供现代 GPU API 访问能力，支持 Compute Shader 进行通用计算。

### Tauri 支持情况

| 平台 | WebView | WebGPU 支持 | 状态 |
|------|---------|------------|------|
| Windows | WebView2 (Chromium) | ✅ 已支持 | Stable channel 可用 |
| macOS | WKWebView | ✅ 已支持 | Safari 17+ |
| Linux | WebKitGTK | ⚠️ 有限 | 依赖发行版版本 |

**关键发现**：
- WebView2 (Windows) 基于 Chromium，WebGPU 在 stable channel 已可用
- Tauri v2 有 unstable cargo feature 支持多 WebView + 原生渲染
- 社区有 `tauri-v2-wgpu` 示例项目

**参考来源**：
- [Tauri 官方文档](https://tauri.app)
- [GitHub: tauri-v2-wgpu](https://github.com)
- [Reddit: wgpu with Tauri](https://reddit.com)

### 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                      Tauri 应用                              │
├─────────────────────────────────────────────────────────────┤
│  React 前端                                                  │
│  ├── BrushTool.tsx      → 笔刷 UI 控制                       │
│  ├── CanvasRenderer.tsx → 调用 WebGPU 模块                   │
│  └── gpu/                                                    │
│      ├── WebGPUContext.ts   → GPU 设备初始化                 │
│      ├── BrushCompute.ts    → Compute Shader 调度            │
│      └── shaders/                                            │
│          ├── brush_blend.wgsl  → 笔刷混合 Compute Shader     │
│          └── composite.wgsl   → 图层合成 Shader              │
├─────────────────────────────────────────────────────────────┤
│  GPU (WebGPU)                                                │
│  ├── Storage Texture A (当前画布)                            │
│  ├── Storage Texture B (更新后画布)                          │
│  └── Uniform Buffer (笔刷参数)                               │
└─────────────────────────────────────────────────────────────┘
```

### Compute Shader 设计 (WGSL)

```wgsl
// brush_blend.wgsl - Alpha Darken 混合 Compute Shader

struct BrushParams {
    center: vec2<f32>,      // 笔刷中心位置
    radius: f32,            // 笔刷半径
    hardness: f32,          // 硬度 0-1
    flow: f32,              // 流量 0-1
    dab_opacity: f32,       // dab 透明度
    color: vec3<f32>,       // RGB 颜色
    roundness: f32,         // 圆度
    angle: f32,             // 角度
};

@group(0) @binding(0) var canvas_in: texture_storage_2d<rgba8unorm, read>;
@group(0) @binding(1) var canvas_out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> brush: BrushParams;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let pos = vec2<f32>(f32(id.x), f32(id.y));
    let dims = textureDimensions(canvas_in);

    if (id.x >= dims.x || id.y >= dims.y) {
        return;
    }

    // 计算到笔刷中心的距离
    let delta = pos - brush.center;
    let dist = length(delta) / brush.radius;

    // 计算 mask 值
    var mask_value: f32 = 0.0;
    if (dist <= 1.0) {
        if (brush.hardness >= 0.99) {
            // 硬笔刷
            mask_value = 1.0;
        } else {
            // 软笔刷 - Gaussian 衰减
            let t = (dist - brush.hardness) / (1.0 - brush.hardness);
            mask_value = exp(-2.5 * t * t);
        }
    }

    if (mask_value < 0.001) {
        // 无变化，直接复制
        let src = textureLoad(canvas_in, vec2<i32>(id.xy));
        textureStore(canvas_out, vec2<i32>(id.xy), src);
        return;
    }

    // Alpha Darken 混合
    let src_alpha = mask_value * brush.flow;
    let dst = textureLoad(canvas_in, vec2<i32>(id.xy));
    let dst_a = dst.a;

    let out_a = select(
        dst_a + (brush.dab_opacity - dst_a) * src_alpha,
        dst_a,
        dst_a >= brush.dab_opacity - 0.001
    );

    var out_rgb: vec3<f32>;
    if (dst_a > 0.001) {
        out_rgb = dst.rgb + (brush.color - dst.rgb) * src_alpha;
    } else {
        out_rgb = brush.color;
    }

    textureStore(canvas_out, vec2<i32>(id.xy), vec4<f32>(out_rgb, out_a));
}
```

### 实现步骤

1. **检测 WebGPU 支持**
   ```typescript
   async function initWebGPU(): Promise<GPUDevice | null> {
     if (!navigator.gpu) {
       console.warn('WebGPU not supported');
       return null;
     }
     const adapter = await navigator.gpu.requestAdapter();
     if (!adapter) return null;
     return await adapter.requestDevice();
   }
   ```

2. **创建 Storage Texture 双缓冲**
   ```typescript
   const textureA = device.createTexture({
     size: [width, height],
     format: 'rgba8unorm',
     usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
   });
   const textureB = device.createTexture({ /* 同上 */ });
   ```

3. **每帧调度 Compute Shader**
   ```typescript
   function dispatchBrushDab(params: BrushParams) {
     // 更新 uniform buffer
     device.queue.writeBuffer(uniformBuffer, 0, paramsData);

     // 创建 compute pass
     const encoder = device.createCommandEncoder();
     const pass = encoder.beginComputePass();
     pass.setPipeline(brushPipeline);
     pass.setBindGroup(0, bindGroup);
     pass.dispatchWorkgroups(
       Math.ceil(width / 16),
       Math.ceil(height / 16)
     );
     pass.end();

     device.queue.submit([encoder.finish()]);

     // 交换双缓冲
     [textureA, textureB] = [textureB, textureA];
   }
   ```

### 优缺点分析

| 优点 | 缺点 |
|------|------|
| 增量式改动，保留现有 UI 代码 | WebGPU API 仍在演进中 |
| GPU 并行处理，性能大幅提升 | Linux 支持有限 |
| 可渐进式采用（软笔刷先用 GPU） | 需要学习 WGSL |
| 社区有示例可参考 | Tauri WebGPU 集成需要摸索 |

### 风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| Linux 兼容性 | 中 | 运行时检测，降级到 Canvas 2D |
| WebGPU API 变更 | 低 | 使用稳定 API 子集 |
| 性能不如预期 | 低 | Compute Shader 本身很快，瓶颈可能在数据传输 |

---

## 方案二：Rust Makepad 原生渲染

### 概述

Makepad 是一个 Rust 原生 UI 框架，完全使用 GPU 渲染，内置 shader 语言。

### Makepad 核心特性

- **GPU 优先渲染**：所有 UI 元素都通过 GPU 绘制
- **内置 Shader 语言**：类似 Rust 的 DSL，可编写自定义渲染逻辑
- **跨平台**：macOS, Windows, Linux, WASM
- **实时热重载**：DSL 代码可实时更新

**参考来源**：
- [Makepad GitHub](https://github.com/makepad/makepad)
- [HackerNews: Makepad 1.0](https://ycombinator.com)
- [YouTube: Building a Code Editor in Makepad](https://youtube.com)

### 架构对比

```
当前架构 (Tauri + React)          Makepad 架构
─────────────────────────         ─────────────────────────
┌─────────────────────┐           ┌─────────────────────┐
│    React UI         │           │    Makepad DSL UI   │
│  (HTML/CSS/JS)      │           │    (Rust DSL)       │
├─────────────────────┤           ├─────────────────────┤
│    Canvas 2D        │           │    Custom Widget    │
│  (JS 像素操作)       │           │  (GPU Shader)       │
├─────────────────────┤           ├─────────────────────┤
│    WebView          │           │    wgpu/Metal/DX    │
│  (浏览器渲染)        │           │  (原生 GPU)          │
├─────────────────────┤           ├─────────────────────┤
│    Tauri (Rust)     │           │    Makepad Runtime  │
└─────────────────────┘           └─────────────────────┘
```

### 自定义画布 Widget 示例

```rust
// Makepad 风格的自定义画布 widget
use makepad_widgets::*;

live_design! {
    CanvasWidget = {{CanvasWidget}} {
        draw_bg: {
            fn pixel(self) -> vec4 {
                // 从纹理采样当前画布内容
                let canvas_color = sample2d(self.canvas_texture, self.pos);
                return canvas_color;
            }
        }
    }
}

#[derive(Live, Widget)]
pub struct CanvasWidget {
    #[live] draw_bg: DrawQuad,
    #[rust] canvas_texture: Texture,
    #[rust] brush_engine: BrushEngine,
}

impl Widget for CanvasWidget {
    fn handle_event(&mut self, cx: &mut Cx, event: &Event) {
        match event {
            Event::PointerDown(e) | Event::PointerMove(e) => {
                if e.is_primary {
                    self.brush_engine.stamp_dab(e.position, e.pressure);
                    self.redraw(cx);
                }
            }
            _ => {}
        }
    }

    fn draw(&mut self, cx: &mut Cx2d) {
        self.draw_bg.draw_abs(cx, self.area());
    }
}

// 笔刷引擎 - 直接操作 GPU 纹理
pub struct BrushEngine {
    canvas_texture: Texture,
    brush_shader: Shader,
}

impl BrushEngine {
    pub fn stamp_dab(&mut self, pos: Vec2, pressure: f32) {
        // 调用 compute shader 进行混合
        // Makepad 的 shader 系统直接操作 GPU
    }
}
```

### 迁移成本评估

| 组件 | 当前实现 | Makepad 需要 | 工作量 |
|------|----------|-------------|--------|
| 工具栏 UI | React + lucide | Makepad DSL | 高 |
| 颜色选择器 | React 组件 | Makepad Widget | 高 |
| 图层面板 | React + Zustand | Makepad + 状态管理 | 高 |
| 画布渲染 | Canvas 2D | GPU Shader | 中 |
| 笔刷引擎 | TypeScript | Rust (可复用后端) | 低 |
| 数位板输入 | Rust WinTab | Rust WinTab (保留) | 无 |

**总工作量估计**：相当于重写 80% 的前端代码

### 优缺点分析

| 优点 | 缺点 |
|------|------|
| 原生性能，无 WebView 开销 | 完全重写 UI |
| 统一 Rust 技术栈 | Makepad 生态不成熟 |
| 内置 Shader 支持 | 学习曲线陡峭 |
| 更小的二进制体积 | 文档和示例较少 |

### 风险评估

| 风险 | 等级 | 说明 |
|------|------|------|
| 生态成熟度 | 高 | Makepad 1.0 刚发布，API 可能变更 |
| 重写工作量 | 高 | 需要重做所有 UI 组件 |
| 维护负担 | 中 | 依赖单一框架 |
| 学习成本 | 中 | DSL 和 Shader 语言 |

---

## 方案对比

| 维度 | WebGPU Compute Shader | Makepad 原生 |
|------|----------------------|--------------|
| **改动范围** | 增量（仅画布渲染） | 全面重写 |
| **实现复杂度** | 中等 | 高 |
| **预计工期** | 1-2 周 | 2-3 个月 |
| **性能上限** | 高（GPU 计算） | 极高（原生 GPU） |
| **维护成本** | 低 | 中 |
| **风险等级** | 低 | 高 |
| **技术债务** | 增加少量 | 清理现有，引入新的 |

---

## 建议

### 短期策略（推荐）：WebGPU Compute Shader

1. **保留现有架构**，仅替换画布渲染层
2. **渐进式采用**：先实现软笔刷 GPU 混合，验证效果
3. **运行时降级**：不支持 WebGPU 时回退到 Canvas 2D
4. **预计工期**：1-2 周核心功能

### 长期策略（可选）：评估 Makepad

1. **持续观察** Makepad 生态发展
2. 等 **Makepad 2.0** 或更稳定版本
3. 如果 WebGPU 方案遇到不可逾越的限制，再考虑迁移

---

## 下一步行动

如果选择 **WebGPU 方案**：

1. [ ] 创建 `src/gpu/` 目录结构
2. [ ] 实现 WebGPU 设备初始化和检测
3. [ ] 编写 `brush_blend.wgsl` Compute Shader
4. [ ] 集成到 StrokeAccumulator
5. [ ] 添加运行时降级逻辑
6. [ ] 性能测试对比

如果选择 **Makepad 方案**：

1. [ ] 创建独立 Makepad 原型项目
2. [ ] 实现基础画布 Widget
3. [ ] 验证数位板输入集成
4. [ ] 评估工作量和风险
5. [ ] 决定是否全面迁移

---

## 参考资料

### WebGPU
- [WebGPU Fundamentals](https://webgpufundamentals.org)
- [Chrome WebGPU Samples](https://chrome.com)
- [wgpu_canvas Crate](https://crates.io)

### Makepad
- [Makepad GitHub](https://github.com/makepad/makepad)
- [Makepad YouTube](https://youtube.com)

### Tauri + GPU
- [Tauri v2 wgpu Example](https://github.com)
- [Reddit: wgpu with Tauri](https://reddit.com)
