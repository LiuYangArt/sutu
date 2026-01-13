# 核心渲染管线设计

> 对应原文档 Phase 1 与 Phase 5

## Phase 1: 核心渲染管线 ⭐

> **这是手感正确的核心**。必须在任何其他功能之前正确实现。

### 1.1 Flow 与 Opacity 的本质区别

这是决定"像不像 PS"的最关键环节。

| 参数        | 作用域      | 行为                               | 类比          |
| ----------- | ----------- | ---------------------------------- | ------------- |
| **Flow**    | 单个 Dab    | 每次盖印的透明度，同一笔触内可累积 | 喷枪墨水堆积  |
| **Opacity** | 整条 Stroke | 透明度天花板，单次笔触内不可超越   | 调速器/限幅器 |

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
│  │ Catmull-Rom / Bezier 样条插值                            │   │
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

| 模式            | 公式 (S=源, D=目标)               | 说明               |
| --------------- | --------------------------------- | ------------------ |
| **Normal**      | `S·α + D·(1-α)`                   | 标准混合           |
| **Multiply**    | `S × D`                           | 正片叠底，变暗     |
| **Screen**      | `1 - (1-S)·(1-D)`                 | 滤色，变亮         |
| **Overlay**     | `D<0.5 ? 2·S·D : 1-2·(1-S)·(1-D)` | 叠加，增加对比度   |
| **Linear Burn** | `S + D - 1`                       | 线性加深           |
| **Color Dodge** | `D / (1-S)`                       | 颜色减淡（需钳制） |

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
2. **推荐**：使用 Texture2DArray（天生隔离，彻底解决溢出，WebGPU 完美支持）

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
