# 高级笔刷特性

> 对应原文档 Phase 6

## Phase 6: 高级特性

> 可选功能，用于增强笔刷表现力

### 6.1 双重画笔遮罩 (Dual Brush)

双重画笔不是"画两笔"，而是**纹理遮罩**。

- **优化策略**: 尽可能使用 **Virtual Masking**。如果副笔刷不需要独立的冲程效果（如散射），仅作为纹理遮罩计算，应避免完整的渲染流程，直接在 Shader 中采样副笔刷纹理进行混合，减少显存带宽压力。

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

- **优化策略**: 除了倒高斯曲线，可引入 **LUT (Look-Up Table)** 纹理查找表，允许设计师定义更复杂的颜料沉积曲线，模拟不同纸张和颜料的物理特性。

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
