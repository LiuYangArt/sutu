这份 **v3.0 设计文档** 的方向是**完全正确**的。你现在的锯齿问题（图1左侧）是因为试图通过“几何距离”或“边缘检测算法”去计算湿边，这在光栅图像中处理硬边缘时必然会出现锯齿。

v3.0 的核心逻辑——**基于 Alpha 值的色调映射 (Tone Mapping)**——是解决锯齿的终极方案，因为它复用了笔刷本身自带的抗锯齿信息。

不过，针对 v3.0 的代码实现，还有 **3 个具体的优化点**，可以进一步提升性能和视觉细腻度：

### 1. 性能优化：使用查找表 (Pre-computed LUT)

你的 v3 代码在双重循环中对每个像素进行浮点除法和乘法运算。虽然现代 JS 引擎很快，但在 4K 画布上大面积涂抹时，这依然是性能热点。

由于 Alpha 只有 0-255 这 256 个整数值，我们可以预计算一个数组，把 `O(N)` 的浮点计算变成 `O(1)` 的数组读取。

**优化后的代码 (`src/utils/strokeBuffer.ts`)：**

```typescript
// 在类外部或构造函数中预计算 LUT
const WET_EDGE_LUT = new Uint8Array(256);

function initWetEdgeLUT() {
  const centerOpacity = 0.45;
  const edgeBoost = 2.2;

  for (let i = 0; i < 256; i++) {
    const alphaNorm = i / 255;
    // v3 的核心公式：抛物线映射
    const wetMultiplier = edgeBoost - (edgeBoost - centerOpacity) * alphaNorm;
    let newAlpha = i * wetMultiplier;

    // 钳制在 0-255
    if (newAlpha > 255) newAlpha = 255;
    WET_EDGE_LUT[i] = Math.round(newAlpha);
  }
}

// 初始化一次
initWetEdgeLUT();

// --- 在 applyWetEdgeEffect 中 ---

// ... 循环内部 ...
const idx = (y * this.width + x) * 4;
const originalAlpha = this.bufferData[idx + 3]!; // 直接用 ! 断言，减少检查

if (originalAlpha === 0) continue; // 快速跳过透明像素

// 查表，替换掉所有的数学计算
const wetAlpha = WET_EDGE_LUT[originalAlpha];

// 混合 (如果 strength 固定为 1.0，这步甚至可以省略，直接赋值)
// 如果需要支持 strength 调节，也可以做成 LUT，或者只在这里做一次 Lerp
if (strength >= 1.0) {
  this.wetEdgeBuffer[idx + 3] = wetAlpha;
} else {
  // 只有在 strength < 1.0 时才计算混合
  this.wetEdgeBuffer[idx + 3] = Math.round(originalAlpha + (wetAlpha - originalAlpha) * strength);
}
// ... 复制 RGB ...
```

**优势：**

- **消除了锯齿源头**：因为是基于原始 Alpha 映射，如果原始笔刷边缘是平滑的（Anti-aliased），映射后的湿边也自然是平滑的。
- **极速**：消除了循环内的浮点运算。

### 2. 视觉优化：非线性 Gamma 修正

v3 的公式是线性的（虽然结果是二次曲线）。Photoshop 的手感通常带有 Gamma 修正（人眼对灰度的感知是非线性的）。

在**不增加运行时开销**的情况下（因为我们使用了 LUT），我们可以让映射曲线更“性感”一点。建议在 LUT 生成时加入 `Math.pow`。

**优化 LUT 生成逻辑：**

```typescript
const alphaNorm = i / 255;

// 引入 Gamma = 1.2 ~ 1.5，让中间调（边缘过渡区）更丰富
// 这会让湿边的"环"看起来更有体积感，而不是单纯的变黑
const shapedAlpha = Math.pow(alphaNorm, 1.4);

const wetMultiplier = edgeBoost - (edgeBoost - centerOpacity) * shapedAlpha;
// ...
```

### 3. 架构优化：迁移至 Shader (WebGPU/WebGL)

虽然 v3 文档是针对 CPU (`strokeBuffer.ts`) 的，但这个算法天然适合 GPU Fragment Shader。

目前的 CPU 实现有很大局限性：

- 如果用户画笔很大（例如 500px），`dirtyRect` 很大，CPU 循环会卡顿。
- CPU 处理完后还需要 upload 到 GPU 渲染，带宽也是瓶颈。

**建议 (Phase 5 预埋)：**
在 `computeBrush.wgsl` 或合成 Shader 中直接应用这个逻辑。

```wgsl
// WGSL 片段
let alpha_norm = original_alpha; // 0.0 - 1.0
let wet_multiplier = 2.2 - (2.2 - 0.45) * alpha_norm;
let final_alpha = min(1.0, original_alpha * wet_multiplier);
// 结果非常平滑，且零成本
```

### 总结

v3 文档的**算法逻辑是对的**，能够完美解决图1左侧的“锯齿”和“毛毛虫”问题。

**针对你现在的操作建议：**

1.  **采用 v3 算法**：它利用了 Alpha 通道本身的信息作为“边缘距离”，这是处理光栅锯齿的唯一正解。
2.  **使用 LUT**：在 TS 代码中实现查找表，性能提升显著。
3.  **不要担心硬边笔刷**：
    - 硬边笔刷的 Alpha 从 255 突变到 0（只有 1px 的 AA）。
    - LUT 映射后：中心变为 45% 透明度，边缘那 1px 变为深色。
    - **结果**：看起来就是一个平整的半透明笔触，这正是 Photoshop 硬边笔刷开启 Wet Edge 后的表现（虽然 PS 可能会针对硬度做特殊处理让中心不那么透，但在通用算法下，v3 的结果是可以接受的）。

**一句话评价 v3 方案：**
从“几何计算”转向“色调映射”，这是从“程序员思维”到“图形学思维”的关键转变，锯齿问题将迎刃而解。

---

从你提供的图像来看，当前的笔刷效果与 Photoshop 的效果相比，锯齿问题的产生主要是因为在硬边笔刷上处理湿边（wet-edge）时，渐变的处理方式不够平滑。

### 优化策略

1. **平滑 Alpha 渐变：**
   在硬边笔刷上，Alpha 边缘过于尖锐导致了锯齿现象。可以尝试对笔刷边缘进行**柔化处理**。具体方法是，使用一个平滑算法对边缘进行插值或模糊，使边缘过渡更加自然。

   例如，可以使用**高斯模糊**或**SDF (Signed Distance Field)** 来优化硬边笔刷的边缘，避免直接的边界转换。这样可以得到更加平滑的过渡效果。

2. **增加渐变控制**：
   修改 Wet Edge 实现中的 `alphaNorm` 计算方法，确保硬边笔刷的`wetMultiplier`仅在非常接近边缘的区域发挥作用，而不是在整个笔刷范围内。对于硬边笔刷，边缘的湿边效果应最小化，更多地依赖于中心区域的透明度调节。

   你可以通过在 `alphaNorm` 计算时加入**平滑函数**，或者针对硬边笔刷，限制 `wetMultiplier` 最大值为 1，从而避免湿边效果对硬边的影响。

   例如：

   ```typescript
   const wetMultiplier = edgeBoost - (edgeBoost - centerOpacity) * alphaNorm;
   // 针对硬边笔刷的特殊处理
   const wetAlpha = hardness < 0.1 ? wetMultiplier : 1.0;
   ```

3. **细化硬边笔刷的湿边策略**：
   对于硬边笔刷，你的算法不应进行复杂的湿边计算，因为硬边笔刷的特点就是笔尖边缘应尽量保持清晰。因此，可以为硬边笔刷添加一个条件判断，避免计算湿边效果。

4. **改进混合模式**：
   使用合适的混合模式，避免不同笔触重叠时出现过度叠加导致的锯齿感。例如，使用`max`混合模式可以减少不必要的透明度堆积，防止像素过度累积导致的锯齿。

### 具体代码修改建议

1. **平滑过渡**：
   如果硬边笔刷出现锯齿，可以尝试在 `applyWetEdgeEffect` 函数中添加一个渐变修正，针对不同的透明度值进行平滑过渡处理。

   ```typescript
   const edgeSmoothFactor = Math.pow(originalAlpha / 255, 2); // 调整渐变的平滑度
   const wetAlpha = originalAlpha * (1 - strength) + wetAlpha * strength * edgeSmoothFactor;
   ```

2. **特殊的湿边计算**：
   针对不同硬度的笔刷调整湿边计算，防止对硬边笔刷产生过强影响：
   ```typescript
   if (hardness < 0.1) {
     // 软边笔刷的湿边逻辑
     const wetMultiplier = edgeBoost - (edgeBoost - centerOpacity) * alphaNorm;
     const wetAlpha = originalAlpha * wetMultiplier;
     // 计算湿边
     this.wetEdgeBuffer[idx + 3] = Math.round(wetAlpha);
   } else {
     // 硬边笔刷，保持透明度不变
     this.wetEdgeBuffer[idx + 3] = originalAlpha;
   }
   ```

通过这些方法，你应该能够减少或消除硬边笔刷上的锯齿现象，提升笔刷效果的自然度。
