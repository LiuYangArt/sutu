# Wet Edge 功能实现失败复盘

**日期**: 2026-01-21
**状态**: 未完成
**严重程度**: 功能未实现

## 问题描述

尝试复刻 Photoshop 的 Wet Edge（湿边）效果，该效果应使笔刷中心更透明（~60%），边缘相对更不透明（~80%），产生类似水彩的效果。

最终结果：GPU 渲染有部分效果但不正确（看起来像修改了 flow 而非 opacity），CPU 渲染完全没有效果。

## 根因分析

### 1. 对 Photoshop Wet Edge 效果理解不足

在动手实现之前，没有深入研究 Photoshop Wet Edge 的实际工作原理：
- 仅凭用户描述（中心 60%，边缘 80%）就开始编码
- 没有研究 Krita 或其他开源软件的实现
- 没有理解 Wet Edge 与 Alpha Darken 混合模式的交互

### 2. 项目渲染架构复杂，数据流路径众多

PaintBoard 有多条渲染路径，实现功能时漏掉了关键路径：

```
渲染路径矩阵：
┌─────────────────┬──────────────────────────────────────────┐
│ 后端            │ 代码路径                                  │
├─────────────────┼──────────────────────────────────────────┤
│ GPU             │ GPUStrokeAccumulator → computeBrush.wgsl │
│ CPU + Rust SIMD │ strokeBuffer.stampDabRust → commands.rs  │
│ CPU + JS        │ strokeBuffer.stampDab → maskCache.ts     │
└─────────────────┴──────────────────────────────────────────┘
```

**遗漏的路径**：
- 第一轮：完全遗漏 CPU 渲染路径的 IPC 调用（`strokeBuffer.ts` → `commands.rs`）
- 第二轮：发现 `useRustPath = false`，实际使用的是纯 JS 路径
- 第三轮：修复 JS 路径后，发现 GPU 效果也不正确

### 3. Alpha Darken 混合模式的误解

最初的实现只修改了 `src_alpha`（累积速率），但没有修改 `dab_opacity`（目标上限）：

```wgsl
// 错误：只修改 mask，不修改 ceiling
let final_mask = mask * wet_factor;
let src_alpha = final_mask * flow;
color = alpha_darken_blend(color, src_color, src_alpha, dab.dab_opacity);  // ← 原始值
```

Alpha Darken 的工作原理：alpha 会趋向 `dab_opacity` 上限，即使 `src_alpha` 很小，多画几笔后仍会达到 100%。

**修复后**：
```wgsl
// 正确：同时修改 mask 和 ceiling
let factor = 1.0 - wet_edge * (1.0 - wet_factor);
final_mask = mask * factor;
final_dab_opacity = dab.dab_opacity * factor;  // ← 同时降低上限
color = alpha_darken_blend(color, src_color, src_alpha, final_dab_opacity);
```

### 4. 调试过程低效

- 初期没有添加调试日志，盲目修改代码
- 多次修改后才意识到需要验证数据是否到达渲染代码
- 添加 `console.log` 后才发现实际使用的是 GPU 路径而非 CPU 路径

## 修改的文件清单

| 文件 | 修改内容 | 状态 |
|------|----------|------|
| `src/stores/tool.ts` | 添加 `wetEdgeEnabled` 状态 | ✓ 完成 |
| `src/gpu/types.ts` | `DabInstanceData` 添加 `wetEdge` 字段 | ✓ 完成 |
| `src/gpu/GPUStrokeAccumulator.ts` | `stampDab` 传递 wetEdge | ✓ 完成 |
| `src/gpu/resources/InstanceBuffer.ts` | `push`/`getDabsData` 处理 wetEdge | ✓ 完成 |
| `src/gpu/pipeline/ComputeBrushPipeline.ts` | `packDabData` 打包 wetEdge | ✓ 完成 |
| `src/gpu/shaders/computeBrush.wgsl` | wet edge 变换逻辑 | ✓ 完成但效果不对 |
| `src-tauri/src/brush/soft_dab.rs` | CPU 版 wet_edge 实现 | ✓ 完成 |
| `src-tauri/src/commands.rs` | `stamp_soft_dab` 添加参数 | ✓ 完成 |
| `src/utils/strokeBuffer.ts` | `DabParams` + IPC 调用 | ✓ 完成 |
| `src/utils/maskCache.ts` | `stampToBuffer` 添加 wetEdge | ✓ 完成 |
| `src/components/Canvas/useBrushRenderer.ts` | `BrushRenderConfig` + `dabParams` | ✓ 完成 |
| `src/components/Canvas/index.tsx` | 解构 `wetEdgeEnabled` | ✓ 完成 |
| `src/components/BrushPanel/settings/WetEdgesSettings.tsx` | UI 组件 | ✓ 新建 |
| `src/components/BrushPanel/index.tsx` | 启用 tab | ✓ 完成 |

## 遗留问题

1. **GPU 效果不正确**：看起来像修改了 flow 而非 opacity
2. **CPU 渲染无效果**：需要进一步调试 JS 路径
3. **算法可能根本错误**：需要研究 Photoshop/Krita 的真实实现

## 经验教训

### 1. 先研究再实现

在实现复杂图形效果前，必须：
- 研究参考软件（Krita、GIMP）的开源实现
- 理解效果与现有混合模式的交互
- 创建最小可验证原型

### 2. 了解项目的渲染架构

在修改渲染相关功能前，绘制完整的数据流图：
- 列出所有渲染路径（GPU/CPU/Rust/JS）
- 确认当前实际使用的路径
- 确保所有路径都被修改

### 3. 先调试后修改

添加功能前先加入调试日志：
```typescript
// 在入口点添加
console.log('[stampDab] wetEdge =', wetEdge, 'backend =', backend);
```
确认数据流正确后再实现逻辑。

### 4. 理解 Alpha Darken

Alpha Darken 混合模式的关键：
- `src_alpha`：每次叠加的贡献量
- `dab_opacity`：目标上限（ceiling）
- **修改透明度效果必须同时修改两者**

## 后续建议

1. **研究 Krita 源码**：`kis_wetness_mask.cpp` 或相关文件
2. **创建独立测试**：不依赖完整渲染管线的单元测试
3. **分阶段实现**：
   - Phase 1: 纯 JS 原型验证算法
   - Phase 2: GPU shader 实现
   - Phase 3: CPU/Rust 对齐

## 参考资料

- Krita 源码：`F:\CodeProjects\krita\`
- PaintBoard 架构文档：`docs/architecture.md`
- Alpha Darken 文档：`docs/design/alpha-darken-blend.md`（如有）
