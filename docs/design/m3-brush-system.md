# M3 笔刷系统设计文档

> 版本: 2.1 | 创建日期: 2026-01-12 | 更新日期: 2026-01-13 (Split)

## 概述

本文档规划 PaintBoard 的专业笔刷系统实现，目标是兼容 Photoshop ABR 笔刷格式，并复刻 PS 的笔刷手感。

**核心理念**：手感正确优先于功能完备。Flow/Opacity 分离机制是"像不像 PS"的决定性因素。

> **注意**：为了优化阅读体验和 Context 占用，本文档已被拆分为多个子文档。请参考以下链接：
>
> - [CORE: 渲染管线与 GPU 优化](./brush-system/01_rendering_pipeline.md) (Phase 1 & 5)
> - [ENGINE: 笔刷引擎数据与算法](./brush-system/02_brush_engine.md) (Phase 2)
> - [IO: ABR 文件解析](./brush-system/03_abr_parser.md) (Phase 3)
> - [UI: 笔刷预设与交互](./brush-system/04_ui_ux.md) (Phase 4)
> - [ADV: 高级特性](./brush-system/05_advanced_features.md) (Phase 6)

## 决策记录

| 决策项         | 选择                   | 理由                                                      |
| -------------- | ---------------------- | --------------------------------------------------------- |
| **实现优先级** | **核心渲染管线优先**   | Flow/Opacity 三级架构是手感核心，必须先正确               |
| 渲染架构       | **混合笔刷引擎**       | **变更**: WebGPU (主) + TS (备)，Rust 仅作 I/O 和后备计算 |
| 兼容程度       | **接受合理差异**       | PS 笔刷引擎专有，100% 复现不现实                          |
| 混合管线       | **Stroke Buffer 隔离** | 正确实现 Opacity 天花板效果                               |

> **重要架构变更 (2026-01-21)**:
> 初始设计计划完全依赖 Rust 后端进行笔刷计算，但由于 IPC 传输高频图像数据存在延迟，生产环境已调整为 **Frontend-First** 混合架构。
>
> - **Primary**: WebGPU Compute Shader (`src/gpu`)
> - **Fallback**: TypeScript (`src/utils/strokeBuffer.ts`)
> - **Reserved**: Rust 引擎 (`src-tauri/src/brush`) 目前保留作为纯数值计算或未来 WASM 移植的参考。

---

## 研究结论

### ABR 格式可行性分析

**结论：可行，但需分阶段实现**

| 方面         | 评估                          |
| ------------ | ----------------------------- |
| 笔刷纹理提取 | ✅ 完全可行，有成熟开源方案   |
| 基础动态参数 | ✅ 可行，格式已被逆向工程     |
| 完整动态系统 | ⚠️ 中等难度，需要自研笔刷引擎 |
| 100% PS 兼容 | ❌ 不现实，PS 笔刷引擎专有    |

### 开源参考资源

| 项目                                                                    | 语言       | 特点                         | 许可证   |
| ----------------------------------------------------------------------- | ---------- | ---------------------------- | -------- |
| [brush-viewer](https://github.com/jlai/brush-viewer)                    | TypeScript | 支持 v6-10，使用 Kaitai 解析 | MIT      |
| [PSBrushExtract](https://github.com/MorrowShore/PSBrushExtract)         | Python     | 提取参数和纹理               | AGPL-3.0 |
| [Krita kis_abr_brush_collection](https://invent.kde.org/graphics/krita) | C++        | 最成熟的实现                 | GPL      |

### ABR 文件结构（v6+）

(详见 [03_abr_parser.md](./brush-system/03_abr_parser.md))

### Photoshop 笔刷动态参数详解

| 动态类型           | 参数                                | 控制方式                        |
| ------------------ | ----------------------------------- | ------------------------------- |
| **Shape Dynamics** | Size Jitter, Minimum Diameter       | Pen Pressure / Tilt / Fade      |
|                    | Angle Jitter                        | Pen Pressure / Tilt / Direction |
|                    | Roundness Jitter, Minimum Roundness | Pen Pressure / Tilt             |
| **Scattering**     | Scatter %, Both Axes                | -                               |
|                    | Count, Count Jitter                 | Pen Pressure                    |
| **Texture**        | Pattern, Scale, Mode, Depth         | -                               |
| **Dual Brush**     | Mode, Size, Spacing, Scatter, Count | -                               |
| **Color Dynamics** | Foreground/Background Jitter        | Pen Pressure                    |
|                    | Hue/Saturation/Brightness Jitter    | -                               |
| **Transfer**       | Opacity Jitter, Flow Jitter         | Pen Pressure / Tilt             |

---

## 实现方案

### 阶段划分

```
Phase 1: 核心渲染管线 (见 01_rendering_pipeline.md)
     ↓
Phase 2: 笔刷引擎扩展 (见 02_brush_engine.md)
     ↓
Phase 3: ABR 解析器 (见 03_abr_parser.md)
     ↓
Phase 4: 笔刷预设 UI (见 04_ui_ux.md)
     ↓
Phase 5: GPU 性能优化 (见 01_rendering_pipeline.md)
     ↓
Phase 6: 高级特性 (见 05_advanced_features.md)
```

---

## Phase 7: 未来展望 (Roadmap)

### 7.1 AI 辅助绘图

- **ML 轨迹预测**: 使用 LSTM 或 Transformer 模型学习用户的笔触习惯，预测下一帧坐标，实现"负延迟"手感（Zero Lag）。
- **神经笔刷 (Neural Brushes)**: 基于 Style Transfer 技术的实时风格化笔刷。

### 7.2 沉浸式交互

- **VR/AR 集成**: 渲染管线解耦，支持输出到 XR 设备的 Framebuffer，支持 6DoF 手柄输入映射到笔刷参数（如旋转、深度）。

---

## 关键文件清单

### 需要修改的现有文件

| 文件                               | 变更说明                              |
| ---------------------------------- | ------------------------------------- |
| `src-tauri/src/lib.rs`             | 添加 `abr` 模块导入                   |
| `src-tauri/src/brush/mod.rs`       | [Reserved] 扩展导出，添加新子模块     |
| `src-tauri/src/brush/engine.rs`    | [Reserved] 集成新笔刷渲染器           |
| `src-tauri/src/commands.rs`        | 添加 ABR 导入命令                     |
| `src-tauri/Cargo.toml`             | 添加依赖（byteorder 等）              |
| `src/stores/tool.ts`               | 添加笔刷预设引用                      |
| `src/components/Canvas/index.tsx`  | 使用新笔刷引擎渲染                    |
| `src/components/Toolbar/index.tsx` | 添加笔刷面板入口                      |
| `src/gpu/*`                        | **Primary**: WebGPU 笔刷着色器与管线  |
| `src/utils/strokeBuffer.ts`        | **Fallback**: TypeScript 笔刷引擎实现 |
| `src/utils/maskCache.ts`           | **Fallback**: 笔刷形状缓存            |

### 需要新建的文件

(详情见各子文档)

---

##验证方案与参考资源

(见各子文档及 [00_overview.md](./brush-system/00_overview.md) - _误, 其实都在这里_)

### 单元测试

```bash
# Rust 笔刷模块测试
cd src-tauri && cargo test brush

# Rust ABR 解析器测试
cd src-tauri && cargo test abr
```

### 参考资源

- [ABR 格式分析 (Archive Team)](https://fileformats.archiveteam.org/wiki/Photoshop_brush)
- [Adobe Photoshop File Formats Specification](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/)

---

## 附录 A: 湿边 (Wet Edge) 实现方案 (优化版 v2)

> **更新于 2026-01-21**: 已整合用户反馈及 Review 深度优化建议 (非线性衰减、视觉保真度)。

### A.1 "湿边" 的物理机制与模型

用户观察到的 Photoshop Wet Edge 行为：

- **全局变暗 (Global Dimming)**: 整体不透明度降低（边缘约 80%）。
- **中心镂空 (Hollow Center)**: 中心比边缘明显更透明（中心约 60%）。
- **非线性衰减 (Non-linear Decay)**: 镂空区不是线性过渡，而是中心区域较宽，边缘快速变深（类似干涸的水渍）。
- **不透明度上限 (Opacity Ceiling)**: 效果通过限制 Single Stroke 的最大不透明度实现。

**数学模型优化**:

设 `w` 为湿边强度 (0.0 到 1.0)。
设 `mask` 为笔刷笔尖形状 (0.0 边缘 -> 1.0 中心)。

```rust
// 1. 形状整形 (Mask Shaping) - 关键优化
// 使用 Gamma 校正 (pow) 将 mask 的高值区域推宽
// mask^3.0 会让 0.5 变为 0.125，使"中心"范围更集中，"边缘"与"中心"的对比更强
let shaped_mask = mask.powf(3.0);

// 2. 全局变暗
// PS 观察: 边缘约 80%
let edge_factor = 1.0 - (0.2 * w);

// 3. 中心镂空 (使用 shaped_mask)
// 中心约 60% (0.6 / 0.8 = 0.75)
let center_reduction = 0.25 * w * shaped_mask;

// 组合因子
let wet_factor = edge_factor * (1.0 - center_reduction);
```

### A.2 实现策略

#### 1. 数据结构更新

- **类型定义**:
  - `BrushPreset`: 添加 `wetEdge` (float, 0-1)。
  - `DabData`/`SoftDab`: 添加 `wetEdge`。
  - 确保 `wetEdge` 为 **可调节参数** 而非单纯的开关，方便调试最佳手感。
  - _Debug Flags_: 在 Uniforms 中添加 `debug_mode`。

#### 2. GPU 逻辑 (`computeBrush.wgsl`)

**核心优化**:

1.  使用 `pow(mask, 3.0)` 模拟非线性液体张力。
2.  确保 `Ceiling` 限制仅作用于当前 **Stroke Buffer** 的积累。
3.  添加调试视图。

```wgsl
// ... Inside main function ...

if (uniforms.wet_enabled > 0) {
    let wet_strength = dab.wet_edge;

    // 1. 形状预处理 (Puddle Effect)
    // 3.0 是经验值，越大边缘积墨感越强
    let shaped_mask = pow(mask, 3.0);

    // 2. 计算系数
    let edge_factor = 1.0 - (0.2 * wet_strength);
    let center_hollow = 1.0 - (0.25 * wet_strength * shaped_mask);

    let wet_factor = edge_factor * center_hollow;

    // 3. 调试模式 (Phase 2必加)
    if (uniforms.debug_mode == 1u) {
        // Red = Edge Dimming, Green = Hollow Factor
        let debug_color = vec4<f32>(edge_factor, center_hollow, 0.0, 1.0);
        textureStore(output_tex, vec2<i32>(pixel_x, pixel_y), debug_color);
        return;
    }

    // 4. 应用系数
    // Alpha Darken Ceiling: 限制本笔画的内部积累
    let effective_ceiling = dab.dab_opacity * wet_factor;

    // Flow Modulation: 减缓堆积速度，配合 Ceiling
    let effective_src_alpha = mask * dab.flow * wet_factor;

    // 5. 混合
    color = alpha_darken_blend(color, dab_color, effective_src_alpha, effective_ceiling);
}
```

**硬边笔刷 (Hardness = 1.0) 的平滑处理**:
若笔刷极硬，`mask` 接近二值，`pow` 也无法产生平滑渐变，导致"空心管"效果。

- _建议_: 强制 Wet Edge 计算使用一个带有最小柔化半径的 Mask，或在 Shader 中利用 SDF (如果可用) 重新计算一个柔化 mask 用于镂空计算。

#### 3. CPU 逻辑 (Rust Backend - `soft_dab.rs`)

复刻 WGSL 的非线性逻辑：

```rust
if wet_edge > 0.001 {
    let shaped_mask = mask_shape.powf(3.0);
    let edge_factor = 1.0 - (0.2 * wet_edge);
    let center_hollow = 1.0 - (0.25 * wet_edge * shaped_mask);
    let wet_factor = edge_factor * center_hollow;

    target_opacity = dab_opacity * wet_factor;
    effective_src_alpha = mask_shape * flow * wet_factor;
}
```

#### 4. CPU 逻辑 (TypeScript Backend - `maskCache.ts`)

> **注意**: 虽然主要是 Fallback，但为保证一致性也需修改。

在 `stampToBuffer` 的混合循环中：

```typescript
// ... 内层循环 ...
let maskValue = this.mask[maskRowStart + mx]!;
if (maskValue < 0.001) continue;

let effectiveSrcAlpha = maskValue * flow;
let effectiveCeiling = dabOpacity;

if (wetEdge > 0) {
  // 应用非线性衰减
  const shapedMask = Math.pow(maskValue, 3.0);
  const edgeFactor = 1.0 - 0.2 * wetEdge;
  const centerHollow = 1.0 - 0.25 * wetEdge * shapedMask;
  const wetFactor = edgeFactor * centerHollow;

  effectiveCeiling = dabOpacity * wetFactor;
  effectiveSrcAlpha = maskValue * flow * wetFactor;
}

// 传递 modified 参数给 blendPixel
this.blendPixel(buffer, idx, effectiveSrcAlpha, effectiveCeiling, r, g, b);
```

### A.3 验证计划 (提升置信度)

1.  **Debug View 验证**:
    - 开启 `debug_mode`。
    - 观察单点：应看到中心偏绿（镂空强），边缘偏红（变暗弱）。
    - 验证 `pow` 参数：调整指数 (2.0 - 5.0)，找到最像"干涸水渍"的边缘锐度。

2.  **硬笔刷测试**:
    - 使用 Hard Round 笔刷。
    - 检查是否出现 60% 透明度的"甜甜圈"伪影。
    - 如果有，需引入 `min_softness` 强制柔化 Wet Edge 的 mask。

3.  **叠加死锁测试**:
    - 确保 `Alpha Darken` 只限制 **Stroke Buffer**。
    - Stroke Buffer 合成到 Canvas 时应使用 `Normal` 或 `Multiply` 混合，确保第二笔能加深颜色。
