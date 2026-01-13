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

| 决策项         | 选择                   | 理由                                        |
| -------------- | ---------------------- | ------------------------------------------- |
| **实现优先级** | **核心渲染管线优先**   | Flow/Opacity 三级架构是手感核心，必须先正确 |
| 渲染架构       | **WebGPU 前端渲染**    | GPU 加速，性能最优，为未来大画布做准备      |
| 兼容程度       | **接受合理差异**       | PS 笔刷引擎专有，100% 复现不现实            |
| 混合管线       | **Stroke Buffer 隔离** | 正确实现 Opacity 天花板效果                 |

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

| 文件                               | 变更说明                 |
| ---------------------------------- | ------------------------ |
| `src-tauri/src/lib.rs`             | 添加 `abr` 模块导入      |
| `src-tauri/src/brush/mod.rs`       | 扩展导出，添加新子模块   |
| `src-tauri/src/brush/engine.rs`    | 集成新笔刷渲染器         |
| `src-tauri/src/commands.rs`        | 添加 ABR 导入命令        |
| `src-tauri/Cargo.toml`             | 添加依赖（byteorder 等） |
| `src/stores/tool.ts`               | 添加笔刷预设引用         |
| `src/components/Canvas/index.tsx`  | 使用新笔刷引擎渲染       |
| `src/components/Toolbar/index.tsx` | 添加笔刷面板入口         |

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
