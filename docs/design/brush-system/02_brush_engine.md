# 笔刷引擎扩展设计

> 对应原文档 Phase 2

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
