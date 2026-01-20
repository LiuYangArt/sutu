# ABR 笔刷 Cursor 轮廓优化方案

## 1. 问题背景

当前 ABR 纹理笔刷的 cursor 轮廓基于简单的**最近邻算法 (Nearest Neighbor)** 生成，存在以下核心问题：

1.  **拓扑连接错误**: 多个断开区域之间出现不应有的连接线（"连线问题"）。
2.  **形状不匹配**: 二值化阈值判定丢失了边缘的灰度信息，导致轮廓与实际笔触形状差异较大。
3.  **边缘粗糙**: 缺乏亚像素精度和平滑处理，呈现锯齿状或尖锐折角。
4.  **边界异常**: 当纹理边缘存在非零像素时，轮廓闭合逻辑可能失效。

## 2. 目标

实现 Photoshop/Krita 级别的专业笔刷预览：

- **准确拓扑**: 正确分离独立的纹理孤岛，无异常连线。
- **平滑边缘**: 使用亚像素精度和曲线平滑，消除锯齿。
- **高鲁棒性**: 能够处理噪点、孔洞及边界情况。
- **高性能**: 256x256 纹理生成耗时 < 5ms，支持缓存。

## 3. 技术方案：增强型灰度 Marching Squares 流水线

我们将采用一套完整的图形处理流水线，替代原有的单一算法：

```mermaid
graph LR
    A[Alpha Texture] --> B[Boundary Padding]
    B --> C[Gray Marching Squares]
    C --> D[Topology Assembly (Quantized)]
    D --> E[Filter & Simplify]
    E --> F[Smoothing (Compensated)]
    F --> G[Normalized SVG Path]
```

### 3.1 预处理与核心算法 (Preprocessing & Extraction)

- **虚拟边界填充 (Virtual Padding)**:
  - 为了防止轮廓在图像边缘截断导致无法闭合，输入处理时需进行虚拟 Padding。
  - `get_pixel(x, y)`: 当坐标 `< 0` 或 `>= width/height` 时，强制返回 `0`。
  - 遍历范围扩大为 `width + 1` x `height + 1`，确保边缘处也能生成完整的闭合包围盒。
- **灰度 Marching Squares (Linear Interpolation)**:
  - 基于**灰度场**提取等值线（Iso-level）。
  - **亚像素插值**: 计算轮廓点在网格边上的精确位置。
    $$ t = \frac{iso - v_0}{v_1 - v_0} $$
  - **歧义处理 (Asymptotic Decider)**:
    - 针对 Case 5 (0101) 和 Case 10 (1010) 的鞍点歧义。
    - 计算网格中心均值 `avg = (v0+v1+v2+v3)/4`。
    - 若 `avg >= iso`，则连接方式与 `avg < iso` 相反，确保拓扑连贯性，避免“翻转”现象。

### 3.2 拓扑组装 (Topology Assembly)

输出的线段集合是无序的，必须组装成多条闭合路径（Polygons）。

- **坐标量化 (Spatial Hashing)**:
  - **问题**: 浮点数精度误差可能导致首尾端点无法精确匹配（`p_end != p_start`）。
  - **解法**:引入量化层。将坐标映射为整数 Key 进行哈希匹配。
  - `Quantization Scale`: 推荐 `16` (即 1/16 像素精度)。
  - Key: `((x * 16.0).round() as i32, (y * 16.0).round() as i32)`。
- **组装逻辑**:
  - 使用 `HashMap<GridPoint, Vec<Segment>>` 建立邻接表。
  - 追踪路径时，确保首尾相连形成闭环 (`Ring`)。
  - **方向性**: 区分**外轮廓 (CCW)** 和 **内孔洞 (CW)**（可选，视最终渲染需求而定，通常 SVG `fill-rule: evenodd` 可自动处理）。

### 3.3 过滤与简化 (Filter & Simplify)

- **轻量预过滤 (Pre-filter)**:
  - (可选) 对极度破碎的噪点纹理，在提取前进行微幅高斯模糊 (Radius=1px) 或形态学闭运算，使细碎噪点融合。
- **面积过滤**:
  - 计算多边形面积 (`Signed Area`)。
  - 剔除 `abs(area) < threshold` 的微小斑点。
- **RDP 简化**:
  - 参数 `epsilon` 动态适应笔刷大小。

### 3.4 平滑处理与补偿 (Smoothing & Compensation)

- **Chaikin 算法**:
  - 迭代 1-2 次进行切角平滑。
- **收缩补偿**:
  - Chaikin 会导致形状向内收缩。
  - **策略 A**: 降低初始 Iso-level (如 0.4 而非 0.5) 使原始轮廓稍大。
  - **策略 B**: 平滑后进行简单的多边形膨胀 (Offsetting)。
  - _当前决策_: 优先采用策略 A (调整阈值)，成本最低。

## 4. 详细设计 (Rust)

### 4.1 数据结构

```rust
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point { x: f32, y: f32 }

// 用于 HashMap 的量化 Key
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct QuantizedPoint(i32, i32);

impl From<Point> for QuantizedPoint {
    fn from(p: Point) -> Self {
        Self(
            (p.x * 16.0).round() as i32,
            (p.y * 16.0).round() as i32
        )
    }
}

pub struct Segment { p1: Point, p2: Point }
pub type Polygon = Vec<Point>;
```

### 4.2 处理流程

```rust
pub fn generate_normalized_outline(pixels: &[u8], width: u32, height: u32) -> String {
    // 1. 设置参数
    let iso_level = 100u8; // 稍微降低阈值以补偿收缩 (0.4 * 255)

    // 2. 提取线段 (含 Virtual Padding 和 Asymptotic Decider)
    let segments = marching_squares_padded(pixels, width, height, iso_level);

    // 3. 组装路径 (使用 QuantizedPoint 解决浮点精度)
    let mut polygons = assemble_polygons_quantized(segments);

    // 4. 后处理
    polygons.retain(|poly| polygon_area(poly).abs() > 4.0); // 面积过滤

    for poly in &mut polygons {
        *poly = rdp_simplify(poly, 1.0);
        *poly = chaikin_smooth(poly, 2);
    }

    // 5. 归一化输出 (0.0-1.0 UV空间)
    to_normalized_svg_path(&polygons, width, height)
}
```

## 5. 性能与缓存优化

- **归一化缓存 (Normalization Cache)**:
  - 生成的 Path 数据应基于 **0.0 ~ 1.0 的 UV 坐标系**。
  - **优势**: 笔刷缩放 (Size) 和旋转 (Rotation) 完全由前端 CSS/SVG `transform` 处理，无需重新计算 Geometry。
  - Rust 后端只需在 Texture ID 变更时计算一次。
- **邻接查询**:
  - 使用 `HashMap` 代替 `Vec` 遍历查找，确保组装复杂度接近 O(N)。

## 6. 实施计划

### Phase 1: 核心算法库 (`src-tauri/src/abr/outline/`)

- [ ] 实现 `marching_squares`：
  - 支持 Virtual Padding (w+1, h+1)。
  - 支持 Linear Interpolation。
  - 支持 Asymptotic Decider (Case 5/10)。
- [ ] 实现 `assemble_polygons`：
  - 基于 `QuantizedPoint` 的 `HashMap` 邻接表。
  - 处理闭环逻辑。
- [ ] 单元测试：
  - 边界测试 (像素在图像边缘)。
  - 断开孤岛测试。

### Phase 2: 后处理流水线

- [ ] 实现 `rdp_simplify`。
- [ ] 实现 `chaikin_smooth`。
- [ ] 实现 `polygon_area` 及过滤逻辑。
- [ ] 实现 Path 归一化输出。

### Phase 3: 集成与验证

- [ ] 替换 `cursor.rs` 逻辑。
- [ ] 验证 `key` 精度是否导致微小断裂。
- [ ] 调整 Iso-level 以获得最佳视觉大小匹配。

## 7. 验收标准

1.  **闭合性**: 所有轮廓必须闭合，不得不自然的断口，尤其在画板边缘。
2.  **拓扑**: 多岛屿纹理正确分离，无连线。
3.  **缩放**: 改变笔刷大小时，轮廓平滑缩放，无抖动或重算延迟。
4.  **视觉**: 轮廓圆润，与实际绘制出的笔触范围吻合度 > 90%。
