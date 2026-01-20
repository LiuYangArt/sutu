# ABR 笔刷 Cursor 轮廓优化方案

## 问题描述

当前 ABR 纹理笔刷的 cursor 轮廓存在以下问题：

1. **轮廓有连线**: 多个断开区域之间出现不应有的连接线
2. **尖锐折角**: 轮廓不够平滑，有锯齿感
3. **形状不匹配**: 复杂纹理的轮廓与实际形状差异较大

## 当前实现分析

### 现有算法 (`src-tauri/src/abr/cursor.rs`)

1. **边界像素检测**: 遍历所有像素，找出边界像素（阈值以上且相邻有阈值以下的像素）
2. **最近邻连接**: 从左上角开始，贪婪连接最近的边界像素（距离阈值 √8 ≈ 2.83px）
3. **RDP简化**: Ramer-Douglas-Peucker 算法简化路径
4. **多子路径**: 当遇到间隙时开始新的子路径

### 问题根因

- 最近邻算法不保证追踪边界顺序，可能跳跃连接
- 缺乏真正的轮廓追踪（如 Moore-Neighbor 或 Marching Squares）
- 简化后没有平滑处理

## Krita 参考实现

### 核心类

```cpp
// libs/brush/kis_boundary.cc
KisOutlineGenerator generator(device->colorSpace(), OPACITY_TRANSPARENT_U8);
generator.setSimpleOutline(true);
d->m_boundary = generator.outline(device->data(), ...);

// 每个子路径独立闭合
Q_FOREACH (const QPolygon & polygon, d->m_boundary) {
    d->path.addPolygon(polygon);
    d->path.closeSubpath();
}
```

### 关键特性

1. **专业轮廓生成器**: `KisOutlineGenerator` 使用扫描线算法
2. **多子路径支持**: 返回 `QVector<QPolygon>`，每个独立闭合
3. **Cosmetic Pen**: 使用 `pen.setWidth(0)` 保持固定像素宽度

## 优化方案

### 方案1: Marching Squares 算法 (推荐)

**原理**: 将图像分成 2x2 网格，根据四角的二值状态（16种情况）确定等值线走向。

**优点**:
- 保证生成封闭、有序的轮廓
- 天然支持多个独立区域
- 算法成熟，易于实现

**实现步骤**:

```rust
fn marching_squares(binary: &[bool], w: usize, h: usize) -> Vec<Vec<(f32, f32)>> {
    // 1. 遍历所有 2x2 网格
    // 2. 计算 case index (0-15)
    // 3. 根据 lookup table 确定边的连接方式
    // 4. 追踪每条等值线直到闭合
}
```

**参考**: https://en.wikipedia.org/wiki/Marching_squares

### 方案2: Moore-Neighbor 追踪

**原理**: 从边界点开始，沿着边界顺时针/逆时针追踪，直到回到起点。

**优点**:
- 简单直接
- 保证顺序正确

**缺点**:
- 处理内部空洞需要额外逻辑

### 方案3: 使用现有库

考虑使用 Rust 生态中的轮廓提取库：
- `contour` crate
- `imageproc` crate 的 `find_contours`

## 平滑处理

无论使用哪种轮廓提取算法，都应添加平滑后处理：

### Chaikin 角切割算法

```rust
fn chaikin_smooth(points: &[(f32, f32)], iterations: usize) -> Vec<(f32, f32)> {
    let mut result = points.to_vec();
    for _ in 0..iterations {
        let mut smoothed = Vec::new();
        for i in 0..result.len() {
            let p0 = result[i];
            let p1 = result[(i + 1) % result.len()];
            // Q = 0.75 * P0 + 0.25 * P1
            // R = 0.25 * P0 + 0.75 * P1
            smoothed.push((0.75 * p0.0 + 0.25 * p1.0, 0.75 * p0.1 + 0.25 * p1.1));
            smoothed.push((0.25 * p0.0 + 0.75 * p1.0, 0.25 * p0.1 + 0.75 * p1.1));
        }
        result = smoothed;
    }
    result
}
```

### 处理流程

```
原始轮廓 → Marching Squares → RDP 简化 → Chaikin 平滑 → SVG Path
```

## 实现计划

### Phase 1: 核心算法替换
- [ ] 实现 Marching Squares 轮廓提取
- [ ] 确保多子路径正确分离
- [ ] 添加单元测试覆盖各种形状

### Phase 2: 平滑处理
- [ ] 实现 Chaikin 平滑算法
- [ ] 调整 RDP epsilon 和 Chaikin 迭代次数
- [ ] 平衡精度和性能

### Phase 3: 性能优化
- [ ] 大尺寸纹理的性能测试
- [ ] 考虑缓存轮廓结果
- [ ] 异步生成避免阻塞

## 验收标准

1. 轮廓无异常连线
2. 轮廓平滑，无明显锯齿
3. 与纹理形状高度匹配
4. 性能: 256x256 纹理 < 10ms

## 参考资料

- [Marching Squares Wikipedia](https://en.wikipedia.org/wiki/Marching_squares)
- [Krita KisOutlineGenerator 源码](https://invent.kde.org/graphics/krita/-/blob/master/libs/image/kis_outline_generator.cpp)
- [Chaikin's Algorithm](https://www.cs.unc.edu/~dm/UNC/COMP258/LECTURES/Chaikins-Algorithm.pdf)
