# Dual Brush (双笔刷) 设计文档

> 版本: 1.0 | 创建日期: 2026-01-31

## 概述

Dual Brush（双笔刷）是 Photoshop 笔刷系统的高级功能，允许使用两个笔刷 tip 进行绘画：

- **主笔刷 (Primary)**: 定义颜色和基本形状
- **副笔刷 (Secondary/Dual)**: 作为遮罩裁剪主笔刷

最终效果：`Final Alpha = Primary_Alpha × Secondary_Alpha`

### 相关测试脚本

| 脚本                                                                                                     | 用途                                     |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| [analyze_brush_params.rs](file:///f:/CodeProjects/PaintBoard/src-tauri/examples/analyze_brush_params.rs) | 分析 ABR 描述符，提取 dualBrush 数据结构 |
| [analyze_desc_raw.rs](file:///f:/CodeProjects/PaintBoard/src-tauri/examples/analyze_desc_raw.rs)         | 原始 desc section 字节分析               |
| [debug_liuyang_abr.rs](file:///f:/CodeProjects/PaintBoard/src-tauri/examples/debug_liuyang_abr.rs)       | 调试 liuyang_paintbrushes.abr 的完整解析 |

测试笔刷："F:\CodeProjects\PaintBoard\abr\liuyang_paintbrushes.abr"

**运行方式**：

```bash
cd src-tauri && cargo run --example analyze_brush_params
```

![Photoshop Dual Brush 面板参考](../../../abr/ps_dual_brush_reference.png)

---

## ABR 数据结构

### 描述符结构 (`dualBrush`)

从 ABR 文件的 `desc` section 中提取的 `dualBrush` 描述符结构：

```
dualBrush: {
  useDualBrush: bool      // 启用开关
  Flip: bool              // 翻转副笔刷
  Brsh: {                 // 副笔刷完整描述符
    Dmtr: UnitFloat       // 直径 (#Pxl)
    Angl: UnitFloat       // 角度 (#Ang)
    Rndn: UnitFloat       // 圆度 (#Prc)
    Nm  : String          // 名称
    Spcn: UnitFloat       // 间距 (#Prc)
    Intr: bool            // 抗锯齿
    flipX: bool
    flipY: bool
    sampledData: String   // ★★★ 副笔刷 UUID (引用 samp section) ★★★
  }
  BlnM: Enum              // 混合模式 (BlnM::Mltp, BlnM::Drkn, etc.)
  useScatter: bool        // 使用散布
  Cnt : UnitFloat         // 数量 (#Prc)
  bothAxes: bool          // 双轴散布
  countDynamics: {        // 数量动态
    bVTy: int             // 控制源
    fStp: int             // fade step
    jitter: UnitFloat     // 抖动
    Mnm : UnitFloat       // 最小值
  }
  scatterDynamics: {...}  // 散布动态 (同上结构)
}
```

### 关键发现

1. **副笔刷通过 UUID 引用**：`sampledData` 字段指向 `samp` section 中已存在的笔刷
2. **不嵌入新笔刷**：副笔刷是对现有笔刷的引用，而非独立数据
3. **独立参数**：副笔刷有独立的 Size、Spacing、Scatter、Count 设置

---

## 数据类型定义

### Rust (src-tauri/src/abr/types.rs)

```rust
/// Dual Brush blend mode (Photoshop Dual Brush panel compatible)
/// Only 8 modes are available in PS Dual Brush
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DualBlendMode {
    #[default]
    Multiply,     // Mltp - 正片叠底
    Darken,       // Drkn - 变暗
    Overlay,      // Ovrl - 叠加
    ColorDodge,   // CDdg - 颜色减淡
    ColorBurn,    // CBrn - 颜色加深
    LinearBurn,   // LBrn - 线性加深
    HardMix,      // HrdM - 实色混合
    LinearHeight, // LnrH - 线性高度
}

/// Dual Brush settings (Photoshop Dual Brush panel compatible)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DualBrushSettings {
    /// Is dual brush enabled
    pub enabled: bool,

    /// Secondary brush UUID (references samp section brush)
    pub brush_id: Option<String>,

    /// Secondary brush name (for UI display)
    pub brush_name: Option<String>,

    /// Blend mode for dual brush (how secondary affects primary)
    pub mode: DualBlendMode,

    /// Flip secondary brush horizontally
    pub flip: bool,

    /// Size override for secondary brush (pixels)
    pub size: f32,

    /// Spacing for secondary brush (% of diameter)
    pub spacing: f32,

    /// Scatter amount (% displacement)
    pub scatter: f32,

    /// Apply scatter on both X and Y axes
    pub both_axes: bool,

    /// Number of secondary dabs per primary dab
    pub count: u32,

    /// Count dynamic control source
    pub count_control: u32,

    /// Scatter dynamic control source
    pub scatter_control: u32,
}

impl Default for DualBrushSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            brush_id: None,
            brush_name: None,
            mode: DualBlendMode::Multiply,
            flip: false,
            size: 25.0,
            spacing: 25.0,
            scatter: 0.0,
            both_axes: false,
            count: 1,
            count_control: 0,
            scatter_control: 0,
        }
    }
}
```

### TypeScript (src/stores/tool.ts)

```typescript
export type DualBlendMode =
  | 'multiply'
  | 'darken'
  | 'lighten'
  | 'colorBurn'
  | 'linearBurn'
  | 'colorDodge'
  | 'overlay'
  | 'softLight'
  | 'hardLight'
  | 'difference'
  | 'exclusion'
  | 'subtract'
  | 'divide';

export interface DualBrushSettings {
  enabled: boolean;
  brushId: string | null;
  brushName: string | null;
  mode: DualBlendMode;
  flip: boolean;
  size: number; // px
  spacing: number; // %
  scatter: number; // %
  bothAxes: boolean;
  count: number;
  countControl: ControlSource;
  scatterControl: ControlSource;
}

export const DEFAULT_DUAL_BRUSH: DualBrushSettings = {
  enabled: false,
  brushId: null,
  brushName: null,
  mode: 'multiply',
  flip: false,
  size: 25,
  spacing: 25,
  scatter: 0,
  bothAxes: false,
  count: 1,
  countControl: 'off',
  scatterControl: 'off',
};
```

---

## UI 设计

### Dual Brush 面板布局

```
┌─────────────────────────────────────────────────┐
│ Mode: [Color Burn ▼]              □ Flip       │
├─────────────────────────────────────────────────┤
│ ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┐   │
│ │ 30  │ 123 │  8  │ 10  │ 25  │ 112 │ 60  │   │ ← 笔刷网格
│ ├─────┼─────┼─────┼─────┼─────┼─────┼─────┤   │   (显示所有可用笔刷)
│ │ 30  │ 50  │ 60  │ 100 │ 127 │ 284 │ 80  │   │
│ ├─────┼─────┼─────┼─────┼─────┼─────┼─────┤   │
│ │ ... │ ... │ ... │ ... │ ... │ ... │ ... │   │
│ └─────┴─────┴─────┴─────┴─────┴─────┴─────┘   │
├─────────────────────────────────────────────────┤
│ Size    ───●───────────────────    [25 px]     │
├─────────────────────────────────────────────────┤
│ Spacing ───●───────────────────    [25%]       │
├─────────────────────────────────────────────────┤
│ Scatter □ Both Axes                            │
│         ───────────────────────    [0%]        │
├─────────────────────────────────────────────────┤
│ Count   ───●───────────────────    [1]         │
└─────────────────────────────────────────────────┘
```

### 组件结构

```
DualBrushSettings.tsx
├── ModeSelect (下拉菜单)
├── FlipCheckbox
├── BrushGrid (笔刷选择网格)
│   └── BrushThumbnail[] (复用现有组件)
├── SizeSlider
├── SpacingSlider
├── ScatterSection
│   ├── BothAxesCheckbox
│   └── ScatterSlider
└── CountSlider
```

---

## 渲染逻辑

### 架构概述

Dual Brush 的核心是 **Stroke 级别的 Alpha 图层混合**，而非 per-dab 遮罩：

```
┌─────────────────────────────────────────────────────────────┐
│                      Stroke 渲染流程                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   笔划路径 ────┬──── 主笔刷路径 ──── primaryMaskAccumulator   │
│               │                           │                  │
│               │                           │  blend(mode)     │
│               │                           ▼                  │
│               └──── 副笔刷路径 ──── dualMaskAccumulator ─────┤
│                    (独立 spacing/scatter)        │           │
│                                                  │           │
│                                     Final Alpha ◄┘           │
│                                          │                   │
│                                          ▼                   │
│                                   Apply to Color             │
└─────────────────────────────────────────────────────────────┘
```

**关键点**：

- 主副笔刷沿相同路径独立生成 dab
- 两者的 alpha 分别累积到独立 Float32Array buffer
- 在 sync/endStroke 时进行**全局 blend mode 混合**
- 副笔刷图案不会被主笔刷边缘裁切

### 算法伪代码

```python
# Stroke 开始
primary_alpha = Float32Array(canvas_size)   # 主笔刷 alpha 累积
secondary_alpha = Float32Array(canvas_size) # 副笔刷 alpha 累积

# 沿路径生成 dab
for each position in stroke_path:
    # 主笔刷 dab
    stamp_to_accumulator(primary_alpha, primary_brush, position)

    # 副笔刷 dab (独立 spacing，可能不同步)
    if should_stamp_secondary(position, secondary_spacing):
        for i in range(count):
            offset = calculate_scatter(scatter, both_axes)
            stamp_to_accumulator(secondary_alpha, secondary_brush, position + offset)

# Sync/EndStroke 时混合
for each pixel:
    blended = blend_dual(primary_alpha[pixel], secondary_alpha[pixel], mode)
    final_opacity = blended * base_opacity
    apply_to_color_buffer(pixel, final_opacity)
```

### GPU Shader 实现思路

在现有的 `computeBrush.wgsl` 中扩展：

```wgsl
// Dual brush uniform
struct DualBrushUniforms {
    enabled: u32,
    flip: u32,
    blend_mode: u32,
    scatter: f32,
    both_axes: u32,
    count: u32,
    _padding: vec2<u32>,
}

// 副笔刷纹理
@group(2) @binding(0) var dual_brush_texture: texture_2d<f32>;
@group(2) @binding(1) var dual_brush_sampler: sampler;

fn apply_dual_brush(primary_alpha: f32, uv: vec2<f32>, uniforms: DualBrushUniforms) -> f32 {
    if (uniforms.enabled == 0u) {
        return primary_alpha;
    }

    var result = primary_alpha;

    for (var i = 0u; i < uniforms.count; i++) {
        // Calculate scattered UV
        let scatter_offset = calculate_scatter(uniforms.scatter, uniforms.both_axes, i);
        var dual_uv = uv + scatter_offset;

        // Flip if needed
        if (uniforms.flip != 0u) {
            dual_uv.x = 1.0 - dual_uv.x;
        }

        // Sample secondary brush
        let secondary_alpha = textureSample(dual_brush_texture, dual_brush_sampler, dual_uv).r;

        // Blend
        result = blend_dual(result, secondary_alpha, uniforms.blend_mode);
    }

    return result;
}

fn blend_dual(primary: f32, secondary: f32, mode: u32) -> f32 {
    switch (mode) {
        case 0u: { return primary * secondary; }                    // Multiply
        case 1u: { return min(primary, secondary); }                // Darken
        case 2u: { return max(primary, secondary); }                // Lighten
        case 3u: { return 1.0 - (1.0 - primary) / max(secondary, 0.001); } // Color Burn
        // ... more modes
        default: { return primary * secondary; }
    }
}
```

---

## 实现阶段

### Phase 1: 数据层 (ABR 导入)

| 任务           | 文件        | 说明                                 |
| -------------- | ----------- | ------------------------------------ |
| 添加类型定义   | `types.rs`  | `DualBrushSettings`, `DualBlendMode` |
| 解析 dualBrush | `parser.rs` | 从描述符提取 dual brush 数据         |
| 前端类型       | `tool.ts`   | TypeScript 接口和默认值              |

### Phase 2: UI 层

| 任务         | 文件                       | 说明     |
| ------------ | -------------------------- | -------- |
| 创建面板组件 | `DualBrushSettings.tsx`    | 新建     |
| 集成到侧边栏 | `BrushPanelComponents.tsx` | 添加 tab |
| 复用笔刷网格 | `BrushPresets.tsx`         | 样式复用 |

### Phase 3: 渲染层

| 任务         | 文件                      | 说明                 |
| ------------ | ------------------------- | -------------------- |
| GPU Shader   | `computeBrush.wgsl`       | 添加 dual brush 混合 |
| CPU Fallback | `strokeBuffer.ts`         | TypeScript 实现      |
| Store 联动   | `GPUStrokeAccumulator.ts` | 传递 uniform         |

---

## 验证方案

### 单元测试

```bash
# ABR 解析测试
cd src-tauri && cargo test abr::tests::test_dual_brush_parsing
```

### 集成测试

```bash
# 分析脚本验证
cd src-tauri && cargo run --example analyze_brush_params
# 检查输出中是否有 dualBrush 数据
```

### 手动验证清单

- [ ] 导入 `liuyang_paintbrushes.abr`
- [ ] 选择一个带 Dual Brush 的笔刷
- [ ] 检查 "Dual Brush" tab 显示正确
- [ ] 调整 Size/Spacing/Scatter 参数
- [ ] 切换副笔刷选择
- [ ] 验证绘画效果（Phase 3 完成后）

---

## 参考资源

- [Photoshop Brush Engine Analysis](https://github.com/nicovideo/photoshop-brush)
- [Krita Dual Brush Implementation](https://invent.kde.org/graphics/krita/-/blob/master/plugins/paintops/defaultpaintops/brush/)
- [ABR Format Specification (Archive Team)](https://fileformats.archiveteam.org/wiki/Photoshop_brush)

---

## 变更历史

| 日期       | 版本 | 说明                                 |
| ---------- | ---- | ------------------------------------ |
| 2026-01-31 | 1.0  | 初始版本，完成数据结构分析和设计规划 |
