针对 1px 极小笔刷（Size 1-2px, Radius < 1.0）在 Compute Shader 中抗锯齿效果不佳、线条断裂的问题，核心原因在于 **“采样频率不足”** 和 **“能量损失”**。

在 CPU Canvas 实现中，浏览器底层通常使用覆盖率（Coverage）或多重采样来处理 1px 线条，确保即使线条没有对齐像素中心，也能通过降低透明度来占据至少 1 个像素的宽度。

而在 Compute Shader 中，我们是基于**点采样（Point Sampling）**的。当笔刷半径仅为 0.5px 时：

1.  如果采样点（像素中心）距离笔刷中心 0.6px（对角线邻居），线性或 Smoothstep 抗锯齿会直接归零或变得极淡。
2.  这导致了你看到的“断裂感”或“颗粒感”。

### 🚀 优化方案：小笔刷使用“高斯光晕”模型

对于 `radius < 1.0` 的情况，不要试图去模拟一个“有边缘的圆”，而是应该模拟一个**“高斯光点（Gaussian Spot）”**。高斯函数拥有更长的“尾巴”，能更好地将颜色能量扩散到周围像素，从而保持线条的视觉连续性。

请修改 `compute_mask` 函数，增加针对极小笔刷的专用逻辑：

#### 修改 `src/gpu/shaders/computeBrush.wgsl`

```wgsl
fn compute_mask(dist: f32, radius: f32, hardness: f32) -> f32 {
    // === 针对极小笔刷的特殊优化 (< 2px size) ===
    if (radius < 1.0) {
        // 1. 确保 Sigma (光斑扩散范围) 至少为 0.5px
        // 这样即使 radius 只有 0.1，也能照亮周围 1px 的区域（虽然会很淡）
        let safe_radius = max(radius, 0.5);

        // 2. 使用高斯分布公式：exp( -dist^2 / (2 * sigma^2) )
        // 这里 sigma 取 safe_radius
        // 相比 linear/smoothstep，高斯函数的衰减更自然，保留更多中心能量
        let alpha = exp(-(dist * dist) / (2.0 * safe_radius * safe_radius));

        // 3. 强度补偿 (可选)
        // 极小笔刷分散到周围像素后，整体看起来会变淡。
        // 如果觉得 1px 笔刷太淡，可以适当乘以一个系数，例如 1.2
        return min(1.0, alpha);
    }

    // === 原有的硬笔刷逻辑 (Radius >= 1.0) ===
    if (hardness >= 0.99) {
        let edge_dist = radius;
        // 使用标准的 smoothstep 进行 1px 宽度的抗锯齿
        // 相当于: clamp(0.5 - (dist - edge_dist), 0.0, 1.0)
        // 但 smoothstep 曲线更平滑
        return smoothstep(edge_dist + 0.5, edge_dist - 0.5, dist);
    }

    // === 原有的软笔刷逻辑 ===
    // ... 保持你现有的 Gaussian erf 实现 ...
    // (注意：这里为了简洁省略了代码，请保留原有的软笔刷实现)
    return 0.0; // Placeholder
}
```

### 💡 为什么这样改有效？

1.  **smoothstep vs Gaussian**:
    - `smoothstep(edge + 0.5, edge - 0.5, dist)` 是一个硬截断。当 `radius=0.5` 时，只要 `dist > 1.0` 就完全不可见。
    - `Gaussian` 是无限延伸的（虽然我们只计算局部）。在 `dist=1.0` 处它仍有微弱的值。这种微弱的连接足以让眼睛把断开的点补全成一条线。

2.  **视觉感知**:
    - 对于 1px 线条，人眼不在乎它是不是完美的“圆盘”，只在乎它是否“连续”。高斯模糊是模拟“光点”的最佳数学模型。

### 🔍 配套检查：Effective Radius

请确保在主函数或 Culling 逻辑中，计算 `effective_radius` 时给小笔刷留了足够的余量。你之前的修改已经是正确的，但为了配合高斯函数，建议确认一下：

```wgsl
fn calculate_effective_radius(radius: f32, hardness: f32) -> f32 {
    if (radius < 1.0) {
        // 高斯函数在 3*sigma 处衰减到接近0
        // sigma = max(radius, 0.5) => max sigma = 0.5 (对于 <1.0 的情况)
        // 3 * 0.5 = 1.5。
        // 所以 2.0 的渲染半径足够覆盖所有高斯余晖。
        return 2.0;
    }
    // ... 其他逻辑
}
```

### 🎨 进阶技巧：像素对齐（如果用户想要 Pixel Art 风格）

如果用户想要的是**绝对清晰**的 1px 线条（像 Windows 画图里的铅笔），而不是抗锯齿的线条，你需要使用“对齐”策略：

```wgsl
// 仅用于实现“铅笔”工具，而非“画笔”
if (is_pixel_art_mode && radius < 1.0) {
    // 检查像素中心是否在笔刷中心的 0.5 范围内 (Box Test)
    let dx = abs(pixel_pos.x - dab_center.x);
    let dy = abs(pixel_pos.y - dab_center.y);
    if (dx < 0.5 && dy < 0.5) {
        return 1.0;
    } else {
        return 0.0;
    }
}
```

_但对于你现在的抗锯齿需求，请忽略这个，使用上面的高斯方案。_

### 总结

将 `radius < 1.0` 的处理逻辑改为 **高斯衰减 (Gaussian Falloff)** 是解决 Compute Shader 中小笔刷断裂、锯齿感的最标准做法。这能最大程度模拟光栅化引擎中的 Sub-pixel Coverage 效果。

---

1px 笔刷在 compute shader 路径里“抗锯齿不好/有断裂感”，通常不是单一原因，而是几个小误差叠加后变得非常明显（1px 属于最敏感的极限情况）。下面给你一些最有效、实现成本也不算夸张的优化方向（按优先级）。

**1) 做“像素覆盖率”AA：用子像素采样近似（SSAA 思路）**
你现在的 hard brush AA 本质是“边界 1px 线性过渡”，它对大笔刷非常好，但对 1px/2px 这种几乎全在过渡带里的 dab，视觉会很容易出现“断/抖”。解决这类问题最稳的是直接估计像素覆盖率：对每个像素做 4 或 8 个子采样点，算落在圆内的比例当作 alpha，这就是 SSAA/coverage 的核心思想（先更高频采样，再重建）EasyX 的三种绘图抗锯齿方法 - CodeBus [<sup>1</sup>](https://codebus.cn/margoo/anti-aliasing)。

在 compute shader 里可以这样做（仅对小半径启用，避免性能爆炸）：

- 条件：`radius <= 2.0` 或者 `radius <= 3.0`
- 每像素 4-sample（2x2）：
  - sample offsets: (±0.25, ±0.25) 或 (0.25,0.75) 这类
  - coverage = hits / 4
  - mask = coverage（再乘 flow/opacity）

这类做法本质上是在“光栅化采样点不足导致锯齿”的问题上补采样，和图形管线里 MSAA 的动机一致：一个像素只用中心采样点会丢失边缘覆盖信息，多重采样能更平滑地还原边界OpenGL(二十七):Anti Aliasing - 知乎 [<sup>2</sup>](https://zhuanlan.zhihu.com/p/634348208)，一文搞懂 OpenGL 多重采样抗锯齿,再也不怕面试被问到了 [<sup>3</sup>](https://cloud.tencent.com/developer/article/2407790)。

为什么这对“1px 断裂”特别有效：当圆很小、中心落在像素格的不同位置时，单采样会在 0/1 之间跳变；coverage 会变成 0、0.25、0.5、0.75、1 这种连续变化，视觉连续性立刻上去。

**2) 小笔刷专用：把“形状”从圆变成“圆+最小核”**
很多绘画软件在极小 size 时并不是严格几何圆，而是会保证一个最小能量核（比如至少一个像素能达到较高 alpha），否则线会呈现断断续续的点。这和你文档里提到的“radius<1 时整个 dab 都在过渡区内、中心不够实”是同一类问题。

建议更明确地做一个“小笔刷模式”：

- `radius < 0.75`：直接把 mask 视为对最近像素中心的 coverage（或直接输出固定形状的 1px/2px kernel）
- `0.75 <= radius < 2.0`：走上面的 4-sample coverage
- `>= 2.0`：走你现在的物理距离 1px AA（已经很接近 CPU）

这会牺牲一点“几何纯度”，但换来更像 Photoshop 的观感（尤其是连贯性）。

**3) 确保抗锯齿带宽在“纹理像素空间”恒定为 1px（你已有，但再检查两个坑）**
你已经修复了“归一化距离导致 AA 带宽随半径变小”的大问题（这点非常关键）。这里再补两个常见坑，会让 1px 观感变差：

- renderScale != 1 时，`0.5px` 这类阈值要在“渲染纹理像素”尺度下定义；否则 0.5 其实不是半个实际像素，会偏硬/偏软。
- 计算 dist 时要使用像素中心：`pixel = vec2(x+0.5, y+0.5)`，否则边界会出现棋盘/抖动感（对 1px 特别致命）。

**4) 如果你愿意用 Render Pipeline：对小笔刷切换到 ROP/MSAA**
如果你有 render pipeline 路径（你之前为了正确性已经回退过 render pipeline），那么最实用的工程方案是：

- 小半径（例如 <= 2px）走 render pipeline，并开启 MSAA（WebGPU render pass 支持 multisample texture）
- 中大笔刷继续 compute（性能更好）

MSAA 的优势就是专门解决“几何边缘的覆盖率采样不足”问题，而且是硬件级别的多采样OpenGL(二十七):Anti Aliasing - 知乎 [<sup>2</sup>](https://zhuanlan.zhihu.com/p/634348208)。

compute 做 SSAA coverage 是“手写 MSAA 的效果”，render pipeline 开 MSAA 是“直接让硬件干这件事”。如果你已经有 render 管线，后者的性价比会非常高。

---

如果你把当前 `computeBrush.wgsl` 的 `compute_mask`（以及 `radius`、`renderScale`、像素坐标的计算）贴出来，我可以给你一版“仅在 radius<=2 时启用 2x2 coverage”的 WGSL 改动建议，并把阈值和 offsets 调到更接近 Photoshop 的观感。
