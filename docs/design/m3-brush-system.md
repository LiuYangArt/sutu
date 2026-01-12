# M3 笔刷系统设计文档

> 版本: 2.0 | 创建日期: 2026-01-12 | 更新日期: 2026-01-12

## 概述

本文档规划 PaintBoard 的专业笔刷系统实现，目标是兼容 Photoshop ABR 笔刷格式，并复刻 PS 的笔刷手感。

**核心理念**：手感正确优先于功能完备。Flow/Opacity 分离机制是"像不像 PS"的决定性因素。

## 决策记录

| 决策项 | 选择 | 理由 |
|--------|------|------|
| **实现优先级** | **核心渲染管线优先** | Flow/Opacity 三级架构是手感核心，必须先正确 |
| 渲染架构 | **WebGPU 前端渲染** | GPU 加速，性能最优，为未来大画布做准备 |
| 兼容程度 | **接受合理差异** | PS 笔刷引擎专有，100% 复现不现实 |
| 混合管线 | **Stroke Buffer 隔离** | 正确实现 Opacity 天花板效果 |

---

## 研究结论

### ABR 格式可行性分析

**结论：可行，但需分阶段实现**

| 方面 | 评估 |
|------|------|
| 笔刷纹理提取 | ✅ 完全可行，有成熟开源方案 |
| 基础动态参数 | ✅ 可行，格式已被逆向工程 |
| 完整动态系统 | ⚠️ 中等难度，需要自研笔刷引擎 |
| 100% PS 兼容 | ❌ 不现实，PS 笔刷引擎专有 |

### 开源参考资源

| 项目 | 语言 | 特点 | 许可证 |
|------|------|------|--------|
| [brush-viewer](https://github.com/jlai/brush-viewer) | TypeScript | 支持 v6-10，使用 Kaitai 解析 | MIT |
| [PSBrushExtract](https://github.com/MorrowShore/PSBrushExtract) | Python | 提取参数和纹理 | AGPL-3.0 |
| [Krita kis_abr_brush_collection](https://invent.kde.org/graphics/krita) | C++ | 最成熟的实现 | GPL |

### ABR 文件结构（v6+）

```
ABR File
├── Header (2 bytes version + 2 bytes sub-version)
├── 8BIMsamp (Sampled Brush Textures)
│   └── Item[]
│       ├── Length (4 bytes)
│       ├── UUID (Pascal string)
│       ├── Dimensions (rectangle)
│       ├── Depth (16-bit, usually 8)
│       ├── Compression mode (0=raw, 1=RLE)
│       └── Image data (grayscale alpha mask)
├── 8BIMpatt (Patterns, optional)
└── 8BIMdesc (Brush Presets Descriptor)
    └── BrshVlLs (Brush Value List)
        └── brushPreset[]
            ├── Nm   (Name, TEXT)
            ├── Brsh (Brush Shape)
            │   ├── Dmtr (Diameter, UntF#Pxl)
            │   ├── Angl (Angle, UntF#Ang)
            │   ├── Rndn (Roundness, UntF#Prc)
            │   ├── Spcn (Spacing, UntF#Prc)
            │   └── sampledData (UUID reference)
            ├── useTipDynamics (bool)
            ├── szVr (Size Variation)
            │   ├── bVTy (Control type: 0=Off, 2=Pressure, 6=Direction)
            │   ├── jitter (UntF#Prc)
            │   └── Mnm  (Minimum, UntF#Prc)
            ├── angleDynamics
            ├── roundnessDynamics
            ├── useScatter (bool)
            ├── dualBrush
            ├── useTexture (bool)
            ├── usePaintDynamics (bool)
            ├── prVr (Pressure Variation → Opacity)
            ├── opVr (Opacity Variation)
            └── useColorDynamics (bool)
```

### Photoshop 笔刷动态参数详解

| 动态类型 | 参数 | 控制方式 |
|----------|------|----------|
| **Shape Dynamics** | Size Jitter, Minimum Diameter | Pen Pressure / Tilt / Fade |
| | Angle Jitter | Pen Pressure / Tilt / Direction |
| | Roundness Jitter, Minimum Roundness | Pen Pressure / Tilt |
| **Scattering** | Scatter %, Both Axes | - |
| | Count, Count Jitter | Pen Pressure |
| **Texture** | Pattern, Scale, Mode, Depth | - |
| **Dual Brush** | Mode, Size, Spacing, Scatter, Count | - |
| **Color Dynamics** | Foreground/Background Jitter | Pen Pressure |
| | Hue/Saturation/Brightness Jitter | - |
| **Transfer** | Opacity Jitter, Flow Jitter | Pen Pressure / Tilt |

---

## 实现方案

### 阶段划分

```
Phase 1: 核心渲染管线 ⭐ 手感核心，最高优先级
    ├── Flow/Opacity 三级管线架构
    ├── Stroke Buffer 实现
    ├── 基础混合模式 (Normal, Multiply)
    ├── 输入平滑 (Catmull-Rom 插值)
    └── 距离累积盖印算法
         ↓
Phase 2: 笔刷引擎扩展
    ├── 圆形笔刷生成（硬度可调）
    ├── 采样笔刷支持（图像笔尖）
    └── 基础动态（压感 → 大小/透明度）
         ↓
Phase 3: ABR 解析器
    ├── 递归 ActionDescriptor 解析
    ├── 纹理提取 + 归一化（8BIMsamp）
    ├── 默认值回退机制
    └── 转换为内部格式
         ↓
Phase 4: 笔刷预设 UI
    ├── 预设网格面板
    ├── ABR 导入对话框
    ├── 参数编辑器
    └── 预设管理（保存/删除）
         ↓
Phase 5: GPU 性能优化
    ├── GPU Instancing 批量渲染
    ├── Texture Atlas 纹理图集
    └── 瓦片化渲染 (Tile-Based)
         ↓
Phase 6: 高级特性（可选）
    ├── 双重画笔遮罩 (Dual Brush)
    ├── 高级混合模式 (Color Dodge/Burn)
    ├── 湿边效果 (Wet Edges)
    └── 颜色动态 (Color Dynamics)
```

---

## Phase 1: 核心渲染管线 ⭐

> **这是手感正确的核心**。必须在任何其他功能之前正确实现。

### 1.1 Flow 与 Opacity 的本质区别

这是决定"像不像 PS"的最关键环节。

| 参数 | 作用域 | 行为 | 类比 |
|------|--------|------|------|
| **Flow** | 单个 Dab | 每次盖印的透明度，同一笔触内可累积 | 喷枪墨水堆积 |
| **Opacity** | 整条 Stroke | 透明度天花板，单次笔触内不可超越 | 调速器/限幅器 |

**行为示例**：
- Flow=10%, Opacity=50%：反复涂抹会累积，但最高只能到 50%
- 抬笔后再画第二条笔触，才能与第一条叠加产生更深颜色

**错误做法**：直接将 `Opacity * Flow` 作为透明度画到图层 → 无法实现"天花板"效果

### 1.2 三级渲染管线架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         输入点流                                 │
│                  (x, y, pressure, tiltX, tiltY)                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      输入平滑 (Smoothing)                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Catmull-Rom 样条插值                                     │   │
│  │ 滑动窗口平均 (5-10 点) 用于角度平滑                       │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   距离累积盖印算法                               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ accumulated_distance += distance(current, last)          │   │
│  │ threshold = diameter * spacing_percent                   │   │
│  │ while accumulated_distance >= threshold:                 │   │
│  │     emit_dab(interpolated_position)                      │   │
│  │     accumulated_distance -= threshold                    │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              Level 1: Dab 生成 (Flow 控制)                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ dab_alpha = brush_tip_alpha * flow                       │   │
│  │ 每个 Dab 独立渲染，Alpha 由 Flow 参数决定                 │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│           Level 2: Stroke Buffer (累积缓冲)                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 临时 FBO/纹理，接收当前笔触的所有 Dab                     │   │
│  │ 使用标准 Alpha 混合，颜色在此快速堆积                     │   │
│  │ 笔触开始时清空，笔触结束时合成到图层                      │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│           Level 3: Layer (Opacity 天花板)                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ final_alpha = min(stroke_buffer_alpha, opacity)          │   │
│  │ Opacity 作为全局乘数/钳制值限制最终透明度                 │   │
│  │ 或：在 Shader 中读取目标像素并钳制                        │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        最终画布输出                              │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 Stroke Buffer 数据结构

```rust
// src-tauri/src/brush/stroke_buffer.rs

/// 笔触累积缓冲区
/// 隔离当前笔触，实现 Opacity 天花板效果
pub struct StrokeBuffer {
    /// 缓冲区尺寸（通常与画布相同或为脏区域）
    width: u32,
    height: u32,
    /// RGBA 像素数据（预乘 Alpha）
    data: Vec<u8>,
    /// 脏区域（优化：只处理被绘制的区域）
    dirty_rect: Option<Rect>,
    /// 当前笔触是否激活
    active: bool,
}

impl StrokeBuffer {
    /// 笔触开始时调用
    pub fn begin_stroke(&mut self) {
        self.clear();
        self.active = true;
        self.dirty_rect = None;
    }

    /// 渲染单个 Dab 到缓冲区
    pub fn stamp_dab(&mut self, dab: &Dab, flow: f32) {
        let dab_alpha = dab.alpha * flow;
        // 标准 Alpha 混合到 stroke buffer
        // dst = src * src_alpha + dst * (1 - src_alpha)
        self.blend_dab(dab, dab_alpha);
        self.expand_dirty_rect(dab.bounds());
    }

    /// 笔触结束时，将缓冲区合成到图层
    pub fn end_stroke(&mut self, layer: &mut Layer, opacity: f32) {
        if let Some(rect) = self.dirty_rect {
            // 关键：应用 Opacity 天花板
            self.composite_to_layer(layer, rect, opacity);
        }
        self.active = false;
    }

    /// 合成到图层，应用 Opacity 限制
    fn composite_to_layer(&self, layer: &mut Layer, rect: Rect, opacity: f32) {
        for y in rect.top..rect.bottom {
            for x in rect.left..rect.right {
                let stroke_pixel = self.get_pixel(x, y);
                let layer_pixel = layer.get_pixel(x, y);

                // Opacity 作为 Alpha 天花板
                let clamped_alpha = stroke_pixel.a.min(opacity);

                // 混合到图层
                let final_pixel = blend_normal(
                    stroke_pixel.with_alpha(clamped_alpha),
                    layer_pixel
                );
                layer.set_pixel(x, y, final_pixel);
            }
        }
    }
}

/// 单个盖印数据
pub struct Dab {
    /// 中心位置
    pub position: Point2D,
    /// 缩放后的大小
    pub size: f32,
    /// 旋转角度
    pub angle: f32,
    /// 笔尖 Alpha 值 (0-1)
    pub alpha: f32,
    /// 笔尖纹理引用
    pub tip_texture: TextureRef,
}
```

### 1.4 混合模式数学公式

> 精确复现 PS 效果需要正确的数学公式

| 模式 | 公式 (S=源, D=目标) | 说明 |
|------|---------------------|------|
| **Normal** | `S·α + D·(1-α)` | 标准混合 |
| **Multiply** | `S × D` | 正片叠底，变暗 |
| **Screen** | `1 - (1-S)·(1-D)` | 滤色，变亮 |
| **Overlay** | `D<0.5 ? 2·S·D : 1-2·(1-S)·(1-D)` | 叠加，增加对比度 |
| **Linear Burn** | `S + D - 1` | 线性加深 |
| **Color Dodge** | `D / (1-S)` | 颜色减淡（需钳制） |

```rust
// src-tauri/src/brush/blend.rs

/// 标准 Alpha 混合（预乘 Alpha）
#[inline]
pub fn blend_normal(src: Pixel, dst: Pixel) -> Pixel {
    Pixel {
        r: src.r + dst.r * (1.0 - src.a),
        g: src.g + dst.g * (1.0 - src.a),
        b: src.b + dst.b * (1.0 - src.a),
        a: src.a + dst.a * (1.0 - src.a),
    }
}

/// 正片叠底
#[inline]
pub fn blend_multiply(src: Pixel, dst: Pixel) -> Pixel {
    Pixel {
        r: src.r * dst.r,
        g: src.g * dst.g,
        b: src.b * dst.b,
        a: blend_normal(src, dst).a, // Alpha 仍用标准混合
    }
}

/// 滤色
#[inline]
pub fn blend_screen(src: Pixel, dst: Pixel) -> Pixel {
    Pixel {
        r: 1.0 - (1.0 - src.r) * (1.0 - dst.r),
        g: 1.0 - (1.0 - src.g) * (1.0 - dst.g),
        b: 1.0 - (1.0 - src.b) * (1.0 - dst.b),
        a: blend_normal(src, dst).a,
    }
}
```

### 1.5 距离累积盖印算法

```rust
// src-tauri/src/brush/stamper.rs

pub struct BrushStamper {
    /// 累积距离
    accumulated_distance: f32,
    /// 上一个渲染点
    last_point: Option<BrushPoint>,
    /// 插值器
    interpolator: CatmullRomInterpolator,
}

impl BrushStamper {
    /// 处理新输入点，返回需要渲染的 Dab 列表
    pub fn process_point(
        &mut self,
        point: BrushPoint,
        brush: &BrushPreset,
    ) -> Vec<Dab> {
        let mut dabs = Vec::new();

        // 计算当前动态大小
        let current_size = brush.tip.diameter
            * brush.dynamics.size.apply(point.pressure);

        // 盖印阈值 = 大小 × 间距百分比
        let threshold = current_size * brush.tip.spacing;

        if let Some(ref last) = self.last_point {
            // 使用样条插值生成平滑路径点
            let path_points = self.interpolator.interpolate(last, &point);

            for path_point in path_points {
                let distance = path_point.distance_from(&self.last_stamp_point);
                self.accumulated_distance += distance;

                // 当累积距离超过阈值时，生成 Dab
                while self.accumulated_distance >= threshold {
                    let t = 1.0 - (self.accumulated_distance - threshold) / distance;
                    let stamp_point = path_point.lerp(&self.last_stamp_point, t);

                    dabs.push(Dab {
                        position: stamp_point.position,
                        size: current_size,
                        angle: brush.tip.angle
                            + brush.dynamics.angle.apply_direction(&stamp_point),
                        alpha: brush.dynamics.opacity.apply(stamp_point.pressure),
                        tip_texture: brush.tip.get_texture(),
                    });

                    self.accumulated_distance -= threshold;
                    self.last_stamp_point = stamp_point;
                }
            }
        }

        self.last_point = Some(point);
        dabs
    }
}
```

### 1.6 核心文件结构

```
src-tauri/src/brush/
├── mod.rs              # 模块入口，导出公共 API
├── types.rs            # 数据结构定义
├── stroke_buffer.rs    # ⭐ Stroke Buffer 实现
├── blend.rs            # ⭐ 混合模式算法
├── stamper.rs          # ⭐ 距离累积盖印器
├── tip.rs              # 笔尖生成（圆形、采样）
├── dynamics.rs         # 动态参数计算
├── renderer.rs         # 图章渲染器
├── cache.rs            # 笔尖纹理缓存
├── engine.rs           # 现有引擎（保持兼容）
└── interpolation.rs    # Catmull-Rom 插值算法
```

---

## Phase 2: 笔刷引擎扩展

### 2.1 数据结构设计

```rust
// src-tauri/src/brush/types.rs

/// 笔刷笔尖定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrushTip {
    /// 唯一标识符
    pub id: String,
    /// 显示名称
    pub name: String,
    /// 笔尖类型
    pub tip_type: BrushTipType,
    /// 基础直径 (pixels)
    pub diameter: f32,
    /// 角度 (degrees, 0-360)
    pub angle: f32,
    /// 圆度 (0-1, 1=圆形, <1=椭圆)
    pub roundness: f32,
    /// 间距 (% of diameter, 如 25% = 0.25)
    pub spacing: f32,
    /// 是否启用抗锯齿
    pub anti_alias: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BrushTipType {
    /// 参数化圆形笔刷
    Round {
        /// 硬度 (0-1, 1=硬边, 0=软边)
        hardness: f32,
    },
    /// 采样图像笔刷
    Sampled {
        /// 灰度图像数据 (作为 alpha mask)
        /// 存储为 Vec<u8>，每个值 0-255
        image_data: Vec<u8>,
        /// 图像宽度
        width: u32,
        /// 图像高度
        height: u32,
    },
}

/// 笔刷动态设置
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BrushDynamics {
    /// 大小动态
    pub size: DynamicControl,
    /// 角度动态
    pub angle: DynamicControl,
    /// 圆度动态
    pub roundness: DynamicControl,
    /// 不透明度动态
    pub opacity: DynamicControl,
    /// 流量动态
    pub flow: DynamicControl,
}

/// 单个动态参数控制
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamicControl {
    /// 控制来源
    pub control: ControlSource,
    /// 抖动 (随机性, 0-1)
    pub jitter: f32,
    /// 最小值 (0-1)
    pub minimum: f32,
}

impl Default for DynamicControl {
    fn default() -> Self {
        Self {
            control: ControlSource::Off,
            jitter: 0.0,
            minimum: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ControlSource {
    #[default]
    Off,
    PenPressure,
    PenTilt,
    PenTiltX,
    PenTiltY,
    Direction,
    Fade { steps: u32 },
    Initial { direction: bool },
}

/// 散布设置
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScatterSettings {
    pub enabled: bool,
    /// 散布距离 (% of diameter)
    pub scatter: f32,
    /// 是否双轴散布
    pub both_axes: bool,
    /// 每个间隔的图章数量
    pub count: u32,
    /// 数量抖动 (0-1)
    pub count_jitter: f32,
}

/// 完整笔刷预设
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrushPreset {
    /// 唯一标识符
    pub id: String,
    /// 显示名称
    pub name: String,
    /// 笔尖定义
    pub tip: BrushTip,
    /// 动态设置
    pub dynamics: BrushDynamics,
    /// 散布设置
    pub scatter: ScatterSettings,
    /// 是否来自 ABR 导入
    pub from_abr: bool,
    /// 原始 ABR 文件路径（如有）
    pub source_file: Option<String>,
}
```

### 2.2 圆形笔刷生成算法

```rust
// src-tauri/src/brush/tip.rs

/// 生成圆形笔刷的 alpha mask
pub fn generate_round_brush(diameter: u32, hardness: f32) -> Vec<u8> {
    let size = diameter as usize;
    let mut data = vec![0u8; size * size];

    let center = diameter as f32 / 2.0;
    let radius = center;

    // hardness 控制边缘渐变
    // hardness = 1.0: 硬边，无渐变
    // hardness = 0.0: 完全渐变到边缘
    let inner_radius = radius * hardness;
    let fade_width = radius - inner_radius;

    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 + 0.5 - center;
            let dy = y as f32 + 0.5 - center;
            let dist = (dx * dx + dy * dy).sqrt();

            let alpha = if dist <= inner_radius {
                1.0
            } else if dist <= radius {
                // 线性渐变（可改为其他曲线）
                1.0 - (dist - inner_radius) / fade_width
            } else {
                0.0
            };

            data[y * size + x] = (alpha * 255.0) as u8;
        }
    }

    data
}
```

### 2.3 动态参数计算

```rust
// src-tauri/src/brush/dynamics.rs

impl DynamicControl {
    /// 应用动态控制，返回 0-1 的缩放因子
    pub fn apply(&self, pressure: f32) -> f32 {
        let base_value = match self.control {
            ControlSource::Off => 1.0,
            ControlSource::PenPressure => pressure,
            ControlSource::PenTilt => 1.0, // TODO: 需要倾斜数据
            _ => 1.0,
        };

        // 应用最小值和抖动
        let min = self.minimum;
        let jitter = self.jitter * rand::random::<f32>();
        let value = base_value * (1.0 - min) + min;

        (value + jitter).clamp(0.0, 1.0)
    }

    /// 应用方向动态（用于角度）
    pub fn apply_direction(&self, point: &BrushPoint) -> f32 {
        match self.control {
            ControlSource::Direction => point.direction_angle,
            _ => 0.0,
        }
    }
}
```

---

## Phase 3: ABR 解析器

> 强化递归解析逻辑和默认值回退机制

### 3.1 ActionDescriptor 键值映射表

| 类别 | 键代码 | 类型 | 功能 | 默认值 |
|------|--------|------|------|--------|
| 基础属性 | `Dmtr` | UnitFloat | 直径 (Diameter) | 30.0 |
| 基础属性 | `Hrdn` | Float | 硬度 (Hardness) | 1.0 |
| 基础属性 | `Spcn` | Float | 间距 (Spacing) | 0.25 |
| 基础属性 | `Angl` | Float | 角度 (Angle) | 0.0 |
| 基础属性 | `Rndn` | Float | 圆度 (Roundness) | 1.0 |
| 形状动态 | `szVr` | Descriptor | 大小变化 | Off |
| 形状动态 | `bVTy` | Enum | 控制类型 (0=Off, 2=Pressure) | 0 |
| 形状动态 | `jitter` | Float | 抖动量 | 0.0 |
| 形状动态 | `Mnm` | Float | 最小值 | 0.0 |
| 双重画笔 | `DuaB` / `UseD` | Boolean | 启用双重画笔 | false |
| 纹理 | `Txtr` | Descriptor | 纹理参数块（嵌套） | None |
| 翻转 | `flip` / `Flip` | Boolean | 翻转 X/Y | false |

### 3.2 解析器架构

```rust
// src-tauri/src/abr/mod.rs

mod parser;
mod samp;
mod desc;
mod types;
mod error;
mod defaults;  // ⭐ 新增：默认值回退

pub use parser::AbrParser;
pub use types::*;
pub use error::AbrError;
```

```rust
// src-tauri/src/abr/defaults.rs

/// ABR 参数默认值
/// 当 ActionDescriptor 缺少某个键时，使用这些默认值
pub struct AbrDefaults;

impl AbrDefaults {
    pub const DIAMETER: f32 = 30.0;
    pub const HARDNESS: f32 = 1.0;
    pub const SPACING: f32 = 0.25;
    pub const ANGLE: f32 = 0.0;
    pub const ROUNDNESS: f32 = 1.0;
    pub const SIZE_JITTER: f32 = 0.0;
    pub const SIZE_MINIMUM: f32 = 0.0;
    pub const OPACITY_JITTER: f32 = 0.0;
    pub const SCATTER: f32 = 0.0;
    pub const SCATTER_COUNT: u32 = 1;
}
```

### 3.3 递归 Descriptor 解析

```rust
// src-tauri/src/abr/desc.rs

use super::defaults::AbrDefaults;

/// ActionDescriptor 值类型
#[derive(Debug, Clone)]
pub enum DescValue {
    Integer(i32),
    Float(f64),
    UnitFloat { value: f64, unit: String },
    Boolean(bool),
    Text(String),
    Enum { type_id: String, value: String },
    Descriptor(HashMap<String, DescValue>),  // ⭐ 嵌套描述符
    List(Vec<DescValue>),
    Reference(Vec<ReferenceItem>),
}

/// 递归解析 Descriptor
pub fn parse_descriptor(cursor: &mut Cursor<&[u8]>) -> Result<HashMap<String, DescValue>, AbrError> {
    let mut map = HashMap::new();

    // 读取类名
    let _class_name = read_unicode_string(cursor)?;
    let _class_id = read_key(cursor)?;

    // 读取项目数量
    let item_count = cursor.read_u32::<BigEndian>()?;

    for _ in 0..item_count {
        let key = read_key(cursor)?;
        let value = parse_descriptor_value(cursor)?;
        map.insert(key, value);
    }

    Ok(map)
}

/// 解析单个值（递归处理嵌套 Descriptor）
fn parse_descriptor_value(cursor: &mut Cursor<&[u8]>) -> Result<DescValue, AbrError> {
    let type_code = read_4char(cursor)?;

    match type_code.as_str() {
        "long" => Ok(DescValue::Integer(cursor.read_i32::<BigEndian>()?)),
        "doub" => Ok(DescValue::Float(cursor.read_f64::<BigEndian>()?)),
        "UntF" => {
            let unit = read_4char(cursor)?;
            let value = cursor.read_f64::<BigEndian>()?;
            Ok(DescValue::UnitFloat { value, unit })
        }
        "bool" => Ok(DescValue::Boolean(cursor.read_u8()? != 0)),
        "TEXT" => Ok(DescValue::Text(read_unicode_string(cursor)?)),
        "enum" => {
            let type_id = read_key(cursor)?;
            let value = read_key(cursor)?;
            Ok(DescValue::Enum { type_id, value })
        }
        "Objc" => {
            // ⭐ 递归解析嵌套 Descriptor
            let nested = parse_descriptor(cursor)?;
            Ok(DescValue::Descriptor(nested))
        }
        "VlLs" => {
            let count = cursor.read_u32::<BigEndian>()?;
            let mut list = Vec::with_capacity(count as usize);
            for _ in 0..count {
                list.push(parse_descriptor_value(cursor)?);
            }
            Ok(DescValue::List(list))
        }
        _ => {
            // 跳过未知类型
            Err(AbrError::UnknownDescriptorType(type_code))
        }
    }
}

/// 从 Descriptor 提取笔刷预设，带默认值回退
pub fn extract_brush_preset(desc: &HashMap<String, DescValue>) -> AbrBrushPreset {
    AbrBrushPreset {
        name: desc.get_text("Nm").unwrap_or_default(),
        diameter: desc.get_unit_float("Dmtr").unwrap_or(AbrDefaults::DIAMETER),
        hardness: desc.get_float("Hrdn").unwrap_or(AbrDefaults::HARDNESS),
        spacing: desc.get_float("Spcn").unwrap_or(AbrDefaults::SPACING),
        angle: desc.get_float("Angl").unwrap_or(AbrDefaults::ANGLE),
        roundness: desc.get_float("Rndn").unwrap_or(AbrDefaults::ROUNDNESS),
        sampled_data_uuid: desc.get_text("sampledData"),
        dynamics: extract_dynamics(desc),
    }
}

/// 提取动态参数
fn extract_dynamics(desc: &HashMap<String, DescValue>) -> AbrDynamics {
    let mut dynamics = AbrDynamics::default();

    // 大小动态
    if let Some(DescValue::Descriptor(sz_var)) = desc.get("szVr") {
        dynamics.use_tip_dynamics = true;
        dynamics.size_control = sz_var.get_enum_value("bVTy").unwrap_or(0);
        dynamics.size_jitter = sz_var.get_float("jitter").unwrap_or(AbrDefaults::SIZE_JITTER);
        dynamics.size_minimum = sz_var.get_float("Mnm").unwrap_or(AbrDefaults::SIZE_MINIMUM);
    }

    // 角度动态
    if let Some(DescValue::Descriptor(ang_var)) = desc.get("angleDynamics") {
        dynamics.angle_control = ang_var.get_enum_value("bVTy").unwrap_or(0);
        dynamics.angle_jitter = ang_var.get_float("jitter").unwrap_or(0.0);
    }

    // 透明度动态
    if let Some(DescValue::Descriptor(op_var)) = desc.get("opVr") {
        dynamics.use_paint_dynamics = true;
        dynamics.opacity_control = op_var.get_enum_value("bVTy").unwrap_or(0);
        dynamics.opacity_jitter = op_var.get_float("jitter").unwrap_or(AbrDefaults::OPACITY_JITTER);
    }

    // 散布
    if desc.get_bool("useScatter").unwrap_or(false) {
        dynamics.use_scatter = true;
        dynamics.scatter = desc.get_float("Sctr").unwrap_or(AbrDefaults::SCATTER);
        dynamics.scatter_count = desc.get_int("Cnt").unwrap_or(AbrDefaults::SCATTER_COUNT as i32) as u32;
    }

    dynamics
}
```

### 3.4 纹理归一化

```rust
// src-tauri/src/abr/samp.rs

/// 归一化笔刷纹理为标准格式
/// 输出：白底透明，Alpha 通道代表不透明度
pub fn normalize_brush_texture(image: &GrayscaleImage) -> GrayscaleImage {
    let mut normalized = Vec::with_capacity(image.data.len());

    for &pixel in &image.data {
        // ABR 中通常：0=透明, 255=不透明
        // 但某些版本可能相反，需要检测
        normalized.push(pixel);
    }

    // 检测是否需要反转（如果中心比边缘更暗）
    let should_invert = detect_inverted_alpha(&image);
    if should_invert {
        for pixel in &mut normalized {
            *pixel = 255 - *pixel;
        }
    }

    GrayscaleImage {
        width: image.width,
        height: image.height,
        data: normalized,
    }
}

/// 检测 Alpha 是否反转（黑透白不透 vs 白透黑不透）
fn detect_inverted_alpha(image: &GrayscaleImage) -> bool {
    let cx = image.width / 2;
    let cy = image.height / 2;
    let center_idx = (cy * image.width + cx) as usize;
    let corner_idx = 0;

    // 如果中心比角落更暗，可能需要反转
    image.data.get(center_idx).unwrap_or(&128) < image.data.get(corner_idx).unwrap_or(&128)
}
```

### 3.5 解析器类型定义

```rust
// src-tauri/src/abr/types.rs

#[derive(Debug, Clone)]
pub struct AbrFile {
    pub version: AbrVersion,
    pub brushes: Vec<AbrBrush>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbrVersion {
    V1,   // Very old (PS 4)
    V2,   // Old format (PS 5-6)
    V6,   // New format (PS 7+)
    V7,   // New format variant
    V10,  // Latest (CC)
}

#[derive(Debug, Clone)]
pub struct AbrBrush {
    pub name: String,
    pub uuid: Option<String>,
    pub tip_image: Option<GrayscaleImage>,
    pub diameter: f32,
    pub spacing: f32,
    pub angle: f32,
    pub roundness: f32,
    pub hardness: Option<f32>,
    pub dynamics: Option<AbrDynamics>,
}

#[derive(Debug, Clone)]
pub struct GrayscaleImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct AbrDynamics {
    pub use_tip_dynamics: bool,
    pub size_control: u32,      // 0=Off, 2=Pressure, 6=Direction...
    pub size_jitter: f32,
    pub size_minimum: f32,
    pub angle_control: u32,
    pub angle_jitter: f32,
    pub use_scatter: bool,
    pub scatter: f32,
    pub scatter_count: u32,
    pub use_paint_dynamics: bool,
    pub opacity_control: u32,
    pub opacity_jitter: f32,
}
```

### 3.6 解析流程

```rust
// src-tauri/src/abr/parser.rs

impl AbrParser {
    pub fn parse(data: &[u8]) -> Result<AbrFile, AbrError> {
        let mut cursor = Cursor::new(data);

        // 1. 读取版本号
        let version = Self::read_version(&mut cursor)?;

        match version {
            AbrVersion::V1 | AbrVersion::V2 => {
                Self::parse_old_format(&mut cursor, version)
            }
            AbrVersion::V6 | AbrVersion::V7 | AbrVersion::V10 => {
                Self::parse_new_format(&mut cursor, version)
            }
        }
    }

    fn parse_new_format(cursor: &mut Cursor<&[u8]>, version: AbrVersion)
        -> Result<AbrFile, AbrError>
    {
        let mut brushes = Vec::new();
        let mut samples = HashMap::new();

        // 2. 扫描所有 8BIM 块
        while let Some(block) = Self::read_8bim_block(cursor)? {
            match block.key.as_str() {
                "samp" => {
                    // 3. 解析采样纹理
                    let samp_brushes = samp::parse_samp_block(&block.data)?;
                    for sb in samp_brushes {
                        samples.insert(sb.uuid.clone(), sb);
                    }
                }
                "desc" => {
                    // 4. 解析描述符
                    let presets = desc::parse_desc_block(&block.data)?;
                    for preset in presets {
                        // 5. 关联纹理和描述符
                        let tip_image = preset.sampled_data_uuid
                            .as_ref()
                            .and_then(|uuid| samples.get(uuid))
                            .map(|s| s.image.clone());

                        brushes.push(AbrBrush {
                            name: preset.name,
                            uuid: preset.sampled_data_uuid,
                            tip_image,
                            diameter: preset.diameter,
                            spacing: preset.spacing,
                            angle: preset.angle,
                            roundness: preset.roundness,
                            hardness: None,
                            dynamics: Some(preset.dynamics),
                        });
                    }
                }
                "patt" => {
                    // 图案，暂不支持
                }
                _ => {
                    // 忽略未知块
                }
            }
        }

        Ok(AbrFile { version, brushes })
    }
}
```

### 3.7 8BIMsamp 解析

```rust
// src-tauri/src/abr/samp.rs

pub struct SampledBrush {
    pub uuid: String,
    pub image: GrayscaleImage,
}

pub fn parse_samp_block(data: &[u8]) -> Result<Vec<SampledBrush>, AbrError> {
    let mut cursor = Cursor::new(data);
    let mut brushes = Vec::new();

    while cursor.position() < data.len() as u64 {
        // 读取项目长度
        let item_length = cursor.read_u32::<BigEndian>()?;
        let item_start = cursor.position();

        // 读取 UUID (Pascal string)
        let uuid = read_pascal_string(&mut cursor)?;

        // 跳过未知字节
        cursor.seek(SeekFrom::Current(8))?;

        // 读取深度
        let depth = cursor.read_u16::<BigEndian>()?;

        // 读取边界矩形
        let top = cursor.read_i32::<BigEndian>()?;
        let left = cursor.read_i32::<BigEndian>()?;
        let bottom = cursor.read_i32::<BigEndian>()?;
        let right = cursor.read_i32::<BigEndian>()?;

        let width = (right - left) as u32;
        let height = (bottom - top) as u32;

        // 再次读取深度
        let _depth2 = cursor.read_u16::<BigEndian>()?;

        // 读取压缩模式
        let compression = cursor.read_u8()?;

        // 读取图像数据
        let image_data = match compression {
            0 => read_raw_image(&mut cursor, width, height, depth)?,
            1 => read_rle_image(&mut cursor, width, height)?,
            _ => return Err(AbrError::UnsupportedCompression(compression)),
        };

        brushes.push(SampledBrush {
            uuid,
            image: GrayscaleImage { width, height, data: image_data },
        });

        // 跳到下一项（考虑 4 字节对齐）
        let consumed = cursor.position() - item_start;
        let padding = (4 - (consumed % 4)) % 4;
        cursor.seek(SeekFrom::Current(padding as i64))?;
    }

    Ok(brushes)
}
```

### 3.8 Tauri 命令

```rust
// src-tauri/src/commands.rs

#[tauri::command]
pub async fn import_abr_file(path: String) -> Result<Vec<BrushPreset>, String> {
    let data = std::fs::read(&path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let abr_file = AbrParser::parse(&data)
        .map_err(|e| format!("Failed to parse ABR: {}", e))?;

    let presets: Vec<BrushPreset> = abr_file.brushes
        .into_iter()
        .map(|b| b.into())
        .collect();

    Ok(presets)
}

#[tauri::command]
pub fn get_brush_presets() -> Vec<BrushPreset> {
    // 从应用状态获取已加载的预设
    BRUSH_PRESETS.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_active_brush(preset_id: String) -> Result<(), String> {
    // 设置当前活动笔刷
    // ...
}
```

---

## Phase 4: 笔刷预设 UI

### 4.1 组件结构

```
src/components/BrushPanel/
├── index.tsx              # 主面板容器
├── BrushPresetGrid.tsx    # 预设网格（缩略图）
├── BrushPresetItem.tsx    # 单个预设项
├── BrushSettings.tsx      # 详细参数编辑
├── BrushTipEditor.tsx     # 笔尖参数
├── DynamicsEditor.tsx     # 动态参数
├── ImportDialog.tsx       # ABR 导入对话框
└── BrushPanel.css         # 样式
```

### 4.2 状态管理

```typescript
// src/stores/brush.ts

interface BrushPreset {
  id: string;
  name: string;
  thumbnail: string;  // base64 data URL
  tip: {
    type: 'round' | 'sampled';
    diameter: number;
    hardness: number;
    angle: number;
    roundness: number;
    spacing: number;
  };
  dynamics: {
    size: DynamicControl;
    opacity: DynamicControl;
    angle: DynamicControl;
  };
  scatter: {
    enabled: boolean;
    amount: number;
    count: number;
  };
  fromAbr: boolean;
}

interface DynamicControl {
  control: 'off' | 'pressure' | 'tilt' | 'direction' | 'fade';
  jitter: number;
  minimum: number;
}

interface BrushState {
  presets: BrushPreset[];
  activePresetId: string | null;
  isLoading: boolean;

  // Actions
  loadPresets: () => Promise<void>;
  importAbr: (path: string) => Promise<void>;
  setActivePreset: (id: string) => void;
  updatePreset: (id: string, updates: Partial<BrushPreset>) => void;
  deletePreset: (id: string) => void;
  savePreset: (preset: BrushPreset) => Promise<void>;
}

export const useBrushStore = create<BrushState>((set, get) => ({
  presets: [],
  activePresetId: null,
  isLoading: false,

  loadPresets: async () => {
    set({ isLoading: true });
    try {
      const presets = await invoke<BrushPreset[]>('get_brush_presets');
      set({ presets, isLoading: false });
    } catch (e) {
      console.error('Failed to load presets:', e);
      set({ isLoading: false });
    }
  },

  importAbr: async (path: string) => {
    set({ isLoading: true });
    try {
      const newPresets = await invoke<BrushPreset[]>('import_abr_file', { path });
      set((state) => ({
        presets: [...state.presets, ...newPresets],
        isLoading: false,
      }));
    } catch (e) {
      console.error('Failed to import ABR:', e);
      set({ isLoading: false });
      throw e;
    }
  },

  // ... other actions
}));
```

### 4.3 UI 设计稿

```
┌─────────────────────────────────────────┐
│  Brushes                          [+] │  ← 标题 + 导入按钮
├─────────────────────────────────────────┤
│ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐       │
│ │     │ │     │ │     │ │     │       │  ← 预设网格
│ │ ○   │ │ ○   │ │ ✿   │ │ ★   │       │    (缩略图)
│ │     │ │     │ │     │ │     │       │
│ └─────┘ └─────┘ └─────┘ └─────┘       │
│  Hard    Soft    Leaf   Sparkle       │
│                                         │
│ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐       │
│ │     │ │     │ │     │ │     │       │
│ ...                                    │
├─────────────────────────────────────────┤
│  Brush Tip                              │  ← 展开式设置
│  ├─ Size:     [====●====] 20px         │
│  ├─ Hardness: [●========] 100%         │
│  ├─ Spacing:  [==●======] 25%          │
│  └─ Angle:    [====●====] 0°           │
├─────────────────────────────────────────┤
│  Shape Dynamics                    [▼] │
│  ├─ Size:     [Pressure ▼] Jitter: 0%  │
│  └─ Angle:    [Direction▼] Jitter: 0%  │
├─────────────────────────────────────────┤
│  Transfer                          [▼] │
│  └─ Opacity:  [Pressure ▼] Jitter: 0%  │
└─────────────────────────────────────────┘
```

---

## Phase 5: GPU 性能优化

> 解决高分辨率画布和密集笔刷的性能瓶颈

### 5.1 GPU Instancing 批量渲染

当笔刷间距为 1% 时，绘制一条长线可能需要渲染数千个 Dab。每个 Dab 作为独立 Draw Call 会导致 CPU 驱动开销成为瓶颈。

**解决方案**：使用实例化渲染 (Instanced Rendering)

```rust
// 实例数据结构
#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct DabInstance {
    /// 位置 (x, y)
    pub position: [f32; 2],
    /// 旋转角度 (radians)
    pub rotation: f32,
    /// 缩放大小
    pub size: f32,
    /// 透明度 (0-1)
    pub opacity: f32,
    /// 纹理图集中的 UV 区域 (u, v, width, height)
    pub uv_rect: [f32; 4],
}

// 批量提交
pub struct DabBatcher {
    instances: Vec<DabInstance>,
    max_batch_size: usize,  // 通常 1000-5000
}

impl DabBatcher {
    pub fn add_dab(&mut self, dab: &Dab) {
        self.instances.push(DabInstance {
            position: [dab.position.x, dab.position.y],
            rotation: dab.angle,
            size: dab.size,
            opacity: dab.alpha,
            uv_rect: dab.tip_texture.uv_rect(),
        });

        if self.instances.len() >= self.max_batch_size {
            self.flush();
        }
    }

    pub fn flush(&mut self) {
        if self.instances.is_empty() {
            return;
        }
        // 上传实例缓冲并执行单次 draw call
        // gpu.draw_instanced(self.instances.len())
        self.instances.clear();
    }
}
```

**性能提升**：数千次 Draw Call → 个位数 Draw Call

### 5.2 Texture Atlas 纹理图集

频繁切换纹理绑定是昂贵操作。将所有笔尖纹理打包到一个大纹理中。

```rust
// src-tauri/src/brush/atlas.rs

pub struct BrushAtlas {
    /// 图集纹理 (通常 4096x4096)
    texture: GpuTexture,
    /// 每个笔尖的 UV 区域
    regions: HashMap<String, UvRect>,
    /// 当前打包位置
    packer: RectPacker,
    /// 填充边距 (防止 Mipmap 溢出)
    padding: u32,
}

#[derive(Clone, Copy)]
pub struct UvRect {
    pub u: f32,
    pub v: f32,
    pub width: f32,
    pub height: f32,
}

impl BrushAtlas {
    /// 添加笔尖纹理到图集
    pub fn add_tip(&mut self, id: &str, image: &GrayscaleImage) -> Option<UvRect> {
        // 添加填充边距防止 Mipmap 边缘溢出
        let padded_width = image.width + self.padding * 2;
        let padded_height = image.height + self.padding * 2;

        let rect = self.packer.pack(padded_width, padded_height)?;

        // 上传到 GPU 纹理
        self.texture.write_region(
            rect.x + self.padding,
            rect.y + self.padding,
            image.width,
            image.height,
            &image.data,
        );

        let uv = UvRect {
            u: (rect.x + self.padding) as f32 / self.texture.width() as f32,
            v: (rect.y + self.padding) as f32 / self.texture.height() as f32,
            width: image.width as f32 / self.texture.width() as f32,
            height: image.height as f32 / self.texture.height() as f32,
        };

        self.regions.insert(id.to_string(), uv);
        Some(uv)
    }
}
```

**Mipmap 陷阱**：图集中相邻笔尖可能颜色溢出。解决方案：
1. 预留足够填充边距 (2-4 像素)
2. 或使用 Texture2DArray（每层独立，无溢出问题）

### 5.3 瓦片化渲染 (Tile-Based)

超大画布（4K/8K+）不应分配连续大内存。

```rust
// src-tauri/src/canvas/tiled.rs

pub struct TiledCanvas {
    /// 瓦片大小 (通常 64x64 或 128x128)
    tile_size: u32,
    /// 稀疏存储：只有被绘制的瓦片才分配内存
    tiles: HashMap<TileCoord, Tile>,
    /// 画布总尺寸
    width: u32,
    height: u32,
}

#[derive(Hash, Eq, PartialEq, Clone, Copy)]
pub struct TileCoord {
    pub x: i32,
    pub y: i32,
}

pub struct Tile {
    /// RGBA 像素数据
    data: Vec<u8>,
    /// 是否有未提交的修改
    dirty: bool,
}

impl TiledCanvas {
    /// 获取受笔触影响的瓦片列表
    pub fn get_affected_tiles(&self, stroke_bounds: &Rect) -> Vec<TileCoord> {
        let start_x = stroke_bounds.left / self.tile_size as i32;
        let end_x = stroke_bounds.right / self.tile_size as i32;
        let start_y = stroke_bounds.top / self.tile_size as i32;
        let end_y = stroke_bounds.bottom / self.tile_size as i32;

        let mut coords = Vec::new();
        for y in start_y..=end_y {
            for x in start_x..=end_x {
                coords.push(TileCoord { x, y });
            }
        }
        coords
    }

    /// 懒加载：首次访问时才分配瓦片
    pub fn get_or_create_tile(&mut self, coord: TileCoord) -> &mut Tile {
        self.tiles.entry(coord).or_insert_with(|| {
            Tile {
                data: vec![0u8; (self.tile_size * self.tile_size * 4) as usize],
                dirty: false,
            }
        })
    }
}
```

**优势**：
- 空白区域不占用显存
- 只上传/更新脏瓦片
- 支持"无限画布"概念

---

## Phase 6: 高级特性

> 可选功能，用于增强笔刷表现力

### 6.1 双重画笔遮罩 (Dual Brush)

双重画笔不是"画两笔"，而是**纹理遮罩**。

```
主笔刷 (Primary) → 定义颜色和基本形状
副笔刷 (Dual)    → 作为"饼干模具"裁剪主笔刷

最终 Alpha = Primary_Alpha × Dual_Alpha
```

```rust
// src-tauri/src/brush/dual.rs

pub struct DualBrushRenderer {
    /// 主笔刷盖印器
    primary_stamper: BrushStamper,
    /// 副笔刷盖印器（独立间距和动态）
    dual_stamper: BrushStamper,
}

impl DualBrushRenderer {
    pub fn render_stroke(
        &mut self,
        points: &[BrushPoint],
        primary_brush: &BrushPreset,
        dual_brush: &BrushPreset,
        blend_mode: DualBlendMode,
    ) -> Vec<MaskedDab> {
        let mut result = Vec::new();

        for point in points {
            // 生成主笔刷 Dab
            let primary_dabs = self.primary_stamper.process_point(*point, primary_brush);

            // 生成副笔刷 Dab（独立的间距和动态）
            let dual_dabs = self.dual_stamper.process_point(*point, dual_brush);

            // 合成：副笔刷作为遮罩
            for p_dab in &primary_dabs {
                for d_dab in &dual_dabs {
                    let masked_alpha = match blend_mode {
                        DualBlendMode::Multiply => p_dab.alpha * d_dab.alpha,
                        DualBlendMode::Subtract => (p_dab.alpha - d_dab.alpha).max(0.0),
                        // ... 其他模式
                    };

                    result.push(MaskedDab {
                        position: p_dab.position,
                        size: p_dab.size,
                        alpha: masked_alpha,
                        // ...
                    });
                }
            }
        }

        result
    }
}

#[derive(Clone, Copy)]
pub enum DualBlendMode {
    Multiply,    // 正片叠底（最常用）
    Subtract,    // 减去
    Darken,      // 变暗
    Lighten,     // 变亮
}
```

### 6.2 湿边效果 (Wet Edges)

模拟水彩颜料在边缘堆积的物理现象。

```rust
// src-tauri/src/brush/wet_edges.rs

/// 将 Dab 的 Alpha 通过倒高斯曲线映射
/// 效果：增强边缘 Alpha，降低中心 Alpha
pub fn apply_wet_edges(dab_alpha: &mut [u8], width: u32, height: u32, intensity: f32) {
    let cx = width as f32 / 2.0;
    let cy = height as f32 / 2.0;
    let max_dist = (cx * cx + cy * cy).sqrt();

    for y in 0..height {
        for x in 0..width {
            let idx = (y * width + x) as usize;
            let original = dab_alpha[idx] as f32 / 255.0;

            if original < 0.01 {
                continue; // 跳过透明像素
            }

            // 计算到中心的距离
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let dist = (dx * dx + dy * dy).sqrt() / max_dist;

            // 倒高斯：边缘更高，中心更低
            let edge_boost = 1.0 - (-dist * dist * 4.0).exp();
            let wet_alpha = original * (1.0 - intensity) + edge_boost * intensity;

            dab_alpha[idx] = (wet_alpha.clamp(0.0, 1.0) * 255.0) as u8;
        }
    }
}
```

### 6.3 高级混合模式实现

Color Dodge 等模式需要读取目标像素，在传统 Framebuffer 中是未定义行为。

**解决方案**：
1. **乒乓缓冲 (Ping-Pong Buffering)**：交替读写两个纹理
2. **GL_KHR_blend_equation_advanced** 扩展（如果可用）
3. **Compute Shader**：完全控制读写

```wgsl
// WebGPU Compute Shader for Color Dodge
@compute @workgroup_size(8, 8)
fn color_dodge_blend(
    @builtin(global_invocation_id) id: vec3<u32>
) {
    let coord = vec2<i32>(id.xy);
    let src = textureLoad(src_texture, coord, 0);
    let dst = textureLoad(dst_texture, coord, 0);

    // Color Dodge: D / (1 - S)
    var result: vec4<f32>;
    result.r = select(dst.r / (1.0 - src.r), 1.0, src.r >= 1.0);
    result.g = select(dst.g / (1.0 - src.g), 1.0, src.g >= 1.0);
    result.b = select(dst.b / (1.0 - src.b), 1.0, src.b >= 1.0);
    result.a = src.a + dst.a * (1.0 - src.a);

    textureStore(output_texture, coord, clamp(result, vec4(0.0), vec4(1.0)));
}
```

---

## 关键文件清单

### 需要修改的现有文件

| 文件 | 变更说明 |
|------|----------|
| `src-tauri/src/lib.rs` | 添加 `abr` 模块导入 |
| `src-tauri/src/brush/mod.rs` | 扩展导出，添加新子模块 |
| `src-tauri/src/brush/engine.rs` | 集成新笔刷渲染器 |
| `src-tauri/src/commands.rs` | 添加 ABR 导入命令 |
| `src-tauri/Cargo.toml` | 添加依赖（byteorder 等） |
| `src/stores/tool.ts` | 添加笔刷预设引用 |
| `src/components/Canvas/index.tsx` | 使用新笔刷引擎渲染 |
| `src/components/Toolbar/index.tsx` | 添加笔刷面板入口 |

### 需要新建的文件

| 文件 | 说明 | 阶段 |
|------|------|------|
| `src-tauri/src/brush/stroke_buffer.rs` | ⭐ Stroke Buffer 实现 | Phase 1 |
| `src-tauri/src/brush/blend.rs` | ⭐ 混合模式算法 | Phase 1 |
| `src-tauri/src/brush/stamper.rs` | ⭐ 距离累积盖印器 | Phase 1 |
| `src-tauri/src/brush/types.rs` | 笔刷数据结构 | Phase 2 |
| `src-tauri/src/brush/tip.rs` | 笔尖生成算法 | Phase 2 |
| `src-tauri/src/brush/dynamics.rs` | 动态参数计算 | Phase 2 |
| `src-tauri/src/brush/renderer.rs` | 图章渲染器 | Phase 2 |
| `src-tauri/src/brush/cache.rs` | 纹理缓存 | Phase 2 |
| `src-tauri/src/abr/mod.rs` | ABR 模块入口 | Phase 3 |
| `src-tauri/src/abr/parser.rs` | ABR 主解析器 | Phase 3 |
| `src-tauri/src/abr/samp.rs` | samp 块解析 | Phase 3 |
| `src-tauri/src/abr/desc.rs` | desc 块解析（递归） | Phase 3 |
| `src-tauri/src/abr/types.rs` | ABR 专用类型 | Phase 3 |
| `src-tauri/src/abr/defaults.rs` | ⭐ 默认值回退 | Phase 3 |
| `src-tauri/src/abr/error.rs` | 错误类型 | Phase 3 |
| `src/stores/brush.ts` | 笔刷预设 store | Phase 4 |
| `src/components/BrushPanel/index.tsx` | 笔刷面板 | Phase 4 |
| `src/components/BrushPanel/*.tsx` | 子组件 | Phase 4 |
| `src/components/BrushPanel/BrushPanel.css` | 样式 | Phase 4 |
| `src-tauri/src/brush/atlas.rs` | 纹理图集 | Phase 5 |
| `src-tauri/src/brush/batcher.rs` | GPU 批量渲染 | Phase 5 |
| `src-tauri/src/canvas/tiled.rs` | 瓦片化画布 | Phase 5 |
| `src-tauri/src/brush/dual.rs` | 双重画笔 | Phase 6 |
| `src-tauri/src/brush/wet_edges.rs` | 湿边效果 | Phase 6 |

---

## 验证方案

### 单元测试

```bash
# Rust 笔刷模块测试
cd src-tauri && cargo test brush

# Rust ABR 解析器测试
cd src-tauri && cargo test abr

# 前端 store 测试
pnpm test -- --grep brush
```

### 集成测试

1. **ABR 导入测试**
   - 使用 `abr/tahraart.abr` 作为测试文件
   - 验证笔刷数量正确
   - 验证笔刷纹理尺寸正确
   - 验证基础参数（直径、间距）正确

2. **笔刷渲染测试**
   - 圆形笔刷不同硬度效果
   - 采样笔刷图章效果
   - 压感动态响应

3. **端到端测试**
   - 启动应用
   - 点击"导入 ABR"
   - 选择测试文件
   - 验证预设列表更新
   - 选择一个预设
   - 在画布绘画
   - 验证笔刷效果

---

## 参考资源

### 格式规范
- [ABR 格式分析 (Archive Team)](https://fileformats.archiveteam.org/wiki/Photoshop_brush)
- [Adobe Photoshop File Formats Specification](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/)

### 开源实现
- [Krita ABR 实现 (C++)](https://invent.kde.org/graphics/krita/-/blob/master/libs/brush/kis_abr_brush_collection.cpp)
- [brush-viewer (TypeScript)](https://github.com/jlai/brush-viewer)
- [PSBrushExtract (Python)](https://github.com/MorrowShore/PSBrushExtract)

### 笔刷动态参考
- [Adobe Photoshop Brush Settings](https://helpx.adobe.com/photoshop/using/brush-settings.html)
- [Photoshop Brush Dynamics Tutorial](https://www.photoshopessentials.com/basics/brush-dynamics/)

---

## 风险与应对

| 风险 | 影响 | 应对策略 |
|------|------|----------|
| ABR 格式版本差异大 | 部分文件无法解析 | 优先支持 v6-v10，记录不支持的版本 |
| PS 动态效果难以完美复现 | 效果与原版有差异 | 接受合理差异，专注核心效果 |
| 大尺寸笔刷性能问题 | 绘画卡顿 | 纹理缓存 + 降采样 + GPU Instancing |
| 复杂 descriptor 解析 | 参数丢失 | 递归解析 + 默认值回退机制 |
| Flow/Opacity 实现错误 | 手感不对 | 优先实现并充分测试三级管线 |

---

## 更新日志

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-01-12 | 2.0 | 重大重构：Flow/Opacity 三级管线、GPU 优化、高级特性 |
| 2026-01-12 | 1.0 | 初始版本 |
