这是一条非常清晰的技术路径验证。既然在 **Substance Designer (SD)** 中复现了正确效果，这证明核心逻辑就是 **Alpha 通道的数学合成**。

SD 的逻辑非常纯粹：

1.  **输入**：笔刷形状 (Shape Alpha) + 噪点图 (Texture Noise)。
2.  **运算**：通过 Blend 节点（Multiply模式）将噪点叠到形状 Alpha 上。
3.  **输出**：新的 Alpha 用于后续上色。

基于这个验证结果，以及你之前的描述（左边糊，右边清晰），我们需要彻底重构 **CPU 笔刷渲染管线** 中关于 Pattern/Texture 的处理部分。

以下是对原方案（假设是基于常见的 Dab 渲染逻辑）的 **Code Review 与重构建议**：

### 1. 核心架构观念转变

- **原方案 (猜测)**：把 Texture 当作一张图片，贴在笔刷 Dab 上，然后把 Dab 印下去。
  - _问题_：每次 Dab 移动，Texture 跟随移动，叠加后导致纹理模糊。
- **新方案 (修正)**：Texture 是一张**无限大的滤镜纸**，铺在画布上。笔刷 Dab 只是一个**窗口（Mask）**，透过这个窗口去读取底下的滤镜纸数值，并修改窗口的透明度。

---

### 2. 算法修改详情 (Review & Refactor)

我们需要修改 CPU 里的 `render_dab` 或 `rasterize_brush` 函数。

#### A. 坐标采样 (Coordinate Sampling)

这是解决“糊”的关键。

- **❌ 旧逻辑 (Local Space)**：

  ```rust
  // 遍历笔刷 Dab 的每一个像素
  for y in 0..dab_height {
      for x in 0..dab_width {
          // 错误：使用相对 Dab 左上角的坐标采样纹理
          // 导致纹理跟随笔触移动
          let tex_val = sample_texture(texture, x, y);
      }
  }
  ```

- **✅ 新逻辑 (World/Canvas Space)**：

  ```rust
  // 假设 dab_x, dab_y 是当前笔触在画布上的绝对坐标
  for y in 0..dab_height {
      let canvas_y = dab_y + y; // 算出画布绝对 Y
      for x in 0..dab_width {
          let canvas_x = dab_x + x; // 算出画布绝对 X

          // 正确：使用画布坐标 + 缩放 + 偏移 来采样
          // 这样无论笔触怎么重叠，同一个画布位置采样的纹理值永远不变！
          let u = (canvas_x as f32 + offset_x) / scale;
          let v = (canvas_y as f32 + offset_y) / scale;

          let tex_val = sample_texture_bilinear(pattern, u, v);
      }
  }
  ```

#### B. 混合算法 (Blending Math)

这是解决“边缘清晰度”和“深度控制”的关键。对应 SD 图中的 `Blend (Multiply)` 节点。

- **❌ 旧逻辑 (直乘)**：

  ```rust
  // 错误：直接相乘。如果纹理有黑色，透明度直接变0，且无法控制强度
  let final_alpha = tip_alpha * tex_val;
  ```

- **✅ 新逻辑 (深度加权混合)**：
  我们需要引入 `depth` (深度/对比度) 参数，范围 0.0 - 1.0。
  - 当 `depth` 为 0 时：纹理完全不影响笔刷 (相当于乘以 1.0)。
  - 当 `depth` 为 1 时：纹理完全影响笔刷 (Multiply 效果最大化)。

  ```rust
  // 模拟 SD/PS 的 Texturize Multiply 算法
  // pattern_val: 0.0 (黑) - 1.0 (白)
  // depth: 用户设置的深度，或者受压感控制的动态深度

  // 核心公式：在 1.0 (无效果) 和 pattern_val (全效果) 之间插值
  let texture_influence = 1.0 - (depth * (1.0 - pattern_val));

  // 或者用 mix 写法理解: mix(1.0, pattern_val, depth)

  // 最终 Alpha = 笔刷原本形状 * 纹理影响系数
  // 这样笔刷原本清晰的边缘 (tip_alpha) 会被保留，只是内部变淡了
  let final_alpha = tip_alpha * texture_influence;
  ```

---

### 3. CPU 实现代码蓝图 (Rust 伪代码)

建议按照此逻辑重写你的 CPU 渲染循环：

```rust
struct BrushState {
    texture_data: Vec<u8>, // 纹理数据 (假设 Grayscale)
    tex_w: usize,
    tex_h: usize,
    scale: f32,
    depth: f32, // 0.0 - 1.0
    invert: bool,
    mode: TextureMode, // Multiply, Subtract, etc.
}

fn rasterize_dab(
    dab_buffer: &mut [u8], // 输出目标
    brush_tip: &[u8],      // 笔刷形状 Alpha
    width: usize,
    height: usize,
    canvas_pos_x: i32,     // Dab 在画布上的绝对坐标 X
    canvas_pos_y: i32,     // Dab 在画布上的绝对坐标 Y
    state: &BrushState
) {
    for y in 0..height {
        let global_y = canvas_pos_y + y as i32;

        for x in 0..width {
            let i = y * width + x;
            let tip_alpha = brush_tip[i] as f32 / 255.0;

            // 1. 优化：如果笔刷形状本身就是透明的，跳过计算
            if tip_alpha <= 0.0 {
                dab_buffer[i * 4 + 3] = 0; // Alpha = 0
                continue;
            }

            // 2. 计算纹理坐标 (World Space)
            let global_x = canvas_pos_x + x as i32;

            // 处理 Tiling (取模) 和 Scale
            // 注意：实际代码要处理负数坐标取模的情况
            let u = ((global_x as f32 / state.scale) as i32).rem_euclid(state.tex_w as i32) as usize;
            let v = ((global_y as f32 / state.scale) as i32).rem_euclid(state.tex_h as i32) as usize;

            // 3. 采样纹理
            let mut tex_val = state.texture_data[v * state.tex_w + u] as f32 / 255.0;
            if state.invert { tex_val = 1.0 - tex_val; }

            // 4. 计算混合 (Multiply Mode)
            // 逻辑: mix(1.0, tex_val, depth)
            let influence = 1.0 * (1.0 - state.depth) + tex_val * state.depth;

            // 5. 应用到 Alpha
            let final_alpha = tip_alpha * influence;

            // 6. 写入颜色 (假设 RGB 已由外部设定，这里只改 Alpha)
            // 注意：这里需要根据你的合成逻辑决定是预乘还是非预乘
            dab_buffer[i * 4 + 3] = (final_alpha * 255.0) as u8;
        }
    }
}
```

### 4. 总结：文档修改清单

请对照你的原始设计文档，检查并修改以下几点：

1.  **坐标系定义**：
    - **原**：可能未明确，或默认为 Local (Dab) Space。
    - **改**：必须明确声明 Texture 使用 **Canvas Space (Global Coordinates)**。纹理的 UV 必须基于 `(DabPosition + PixelOffset) / Scale` 计算。

2.  **纹理采样方式**：
    - **原**：可能是一次性裁切。
    - **改**：必须支持 **Tiling (平铺)**。当坐标超出纹理尺寸时，通过取模运算 (`%`) 循环采样。

3.  **混合公式**：
    - **原**：简单的乘法 (`Alpha * Texture`)。
    - **改**：基于深度的线性插值 (`Lerp(1.0, Texture, Depth)`)。这能保证当 Depth 为 0 时，笔刷完全恢复原状；Depth 适中时，保留笔刷原本清晰的轮廓。

4.  **性能考量**：
    - 纹理计算在最内层循环。建议先实现“最近邻采样” (Nearest Neighbor, 直接转 `int` 取模)，验证效果正确后再考虑双线性插值 (Bilinear)，因为在 CPU 上跑双线性插值极其消耗性能。对于高分辨率噪点图，最近邻通常也够用了。

按照这个逻辑去写代码，你的 CPU 笔刷就能得到和 Substance Designer 以及 Photoshop 一致的效果：**纹理固定在纸上，笔刷扫过去显现纹理，且边缘轮廓由笔刷形状主导。**
