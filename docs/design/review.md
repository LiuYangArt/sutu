这份设计文档的**方向是正确的**，即试图填补 ABR 解析中“纹理缺失”的空白。

然而，作为一名开发人员，我对这份文档的**置信度评级为 6/10**。

目前的文档在**文件结构假设**、**数据可用性风险**以及**渲染实现细节**上过于乐观或模糊。如果不解决这些问题，开发过程中极有可能遭遇“解析不到数据”或者“渲染效果完全不对”的阻塞性问题。

以下是我提出的**深度优化建议**和**风险预警**：

---

### 1. 核心风险：ABR 文件真的包含图案数据吗？(Data Availability)

这是最大的风险点。
**现状分析**：标准的 `.abr` 文件（尤其是旧版本）通常**只包含笔头形状 (`samp`) 和参数**。当你在 Photoshop 中为一个笔刷设置纹理时，ABR 文件中记录的往往只是一个指向 Photoshop 图案库的**引用 (UUID 或 Name)**，而不是图案的**像素数据**本身。
**后果**：如果你只解析 ABR，你可能会得到一个 `patternId: "Paper-Texture-01"`，但根本找不到对应的图片数据块 `patt`。

**优化方案**：

- **调整预期**：明确 ABR 解析器可能面临“有参数无数据”的情况。
- **策略变更**：
  - **Case A (嵌入式)**：某些新型或特定导出的 ABR *可能*包含嵌入资源。需要通过 Hex Editor 验证 `8BIM` 资源块中是否存在 ID 为 `0x0408` (Pattern) 或类似的数据。
  - **Case B (引用式 - 常见)**：如果 ABR 只有引用，你需要提供一个**“缺失资源占位符”**机制，或者允许用户**额外导入 `.pat` 文件**来建立映射库。
- **补充任务**：在 Task List 中增加一项关键任务——**ABR 样本逆向分析**。拿到 5-10 个带纹理的 ABR，用 Hex Editor 确认里面是否真的有大块的图像数据。如果没有，这个设计文档的一半内容（解析 `patt`）都要推翻重写为“导入外部 .pat 文件”。

### 2. 解析逻辑优化：二进制结构的复杂性

文档对 `patt` 块的假设（"类似于 .pat 文件"）过于简化。

**优化方案**：

- **压缩算法**：Adobe 的图像资源几乎从不存储 Raw RGBA。它们通常使用 **PackBits (RLE)** 或 **Zip** 压缩，且通道顺序往往是 **Planar** (RRRGGGBBB) 而非 Interleaved (RGBRGB)。文档必须提及解码器需求。
- **色彩模式**：图案可能是索引颜色 (Indexed Color)、灰度或 CMYK。必须实现**色彩空间转换**逻辑，统一转为 RGBA8。
- **大端序 (Big Endian)**：Adobe 文件格式是 Big Endian，而现代 CPU 是 Little Endian。文档应显式提醒解析时需处理字节序转换。

### 3. 存储与去重 (Storage & Deduplication)

文档提议 `App_Data/patterns/{uuid}.png`。这在工程上不够严谨。

**优化方案**：

- **内容寻址存储 (Content-Addressable Storage)**：
  - 不要用 UUID 做文件名（不同的笔刷可能引用同一个图案，但 UUID 可能不同，或者同一个图案被多次包含）。
  - **方案**：对解码后的图案像素数据计算 **SHA-256 哈希**。
  - **文件名**：`patterns/a1b2c3d4....png`。
  - **映射表**：维护一个 `Map<ABR_Pattern_UUID, File_Hash>`。
  - **收益**：防止用户导入 10 个笔刷包后，磁盘里存了 100 份一模一样的“噪点图”。

### 4. 渲染引擎细节：Texture Depth 不是简单的 Blend

文档中提到 `mode: BlendMode` 和 `depth: number`。在 Photoshop 的笔刷纹理中，**Depth (深度)** 的计算逻辑非常特殊，它不是标准的图层混合模式。

**优化方案**：

- **明确 Shader 逻辑**：
  - Photoshop 的纹理逻辑通常是：`Final_Alpha = Brush_Tip_Alpha * Texture_Influence`。
  - `Texture_Influence` 的计算公式近似于：

    ```glsl
    // 伪代码
    float textureValue = texture(u_pattern, uv).r; // 假设是灰度
    if (invert) textureValue = 1.0 - textureValue;

    // Depth 控制纹理的对比度/穿透力
    float dynamicDepth = u_depth * u_pressure_control; // 深度常受压感控制

    // 核心混合：纹理作为一种“遮罩”或者“加深/减淡”
    // 简单乘法是不够的，通常是 Subtract 或 Height map 逻辑
    float influence = mix(1.0, textureValue, dynamicDepth);

    // 应用模式 (Multiply, Subtract, Linear Burn 等)
    // 这里的 Mode 是指纹理如何与笔头形状混合，而不是与画布混合
    ```

- **UV 坐标系**：
  - 明确纹理是 **Screen Space (屏幕空间)** 还是 **Stroke Space (笔触空间)**？
  - Photoshop 笔刷纹理通常支持 **"Scale"**，这是相对于笔刷大小还是相对于图案原始尺寸？(通常是相对于图案原始尺寸)。

---

### 修正后的设计文档建议 (Diff View)

建议将以下内容更新到文档中，以提高置信度：

#### 2.1 新增模块 `src-tauri/src/abr/patt.rs` (Revised)

```rust
pub struct AbrPattern {
    // 使用 Hash 避免重复存储
    pub content_hash: String,
    // 原始 ID，用于与 desc 匹配
    pub original_id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub mode: ImageMode, // Gray, RGB, CMYK, Lab...
    pub data: Vec<u8>,   // Decoded RGBA8
}

pub fn parse_patt_resource(data: &[u8]) -> Result<Vec<AbrPattern>, AbrError> {
    // 关键：处理 Adobe 的 PackBits 压缩和 Planar 通道布局
    // 关键：处理 Big Endian 读取
}
```

#### 2.3 数据关联逻辑 (Revised)

1.  **Extract**: 尝试从 ABR 中提取嵌入的 `8BIM` 资源 (ID `0x0408` 或类似)。
2.  **Fallback**: 如果 ABR 中未找到图案数据（只有引用），记录 `Missing Pattern UUID`。
3.  **External Import**: 提供接口 `import_pat_file(path)`，解析标准 `.pat` 文件，并尝试将其 ID 注册到系统的资源库中，以解决 Missing 引用。

#### 3.2 笔刷引擎集成 (Shader Spec)

- **UV Calculation**: 必须实现 `Texturize` 逻辑。
  ```glsl
  // Pattern 通常是平铺在画布上的，仿佛在有纹理的纸上作画
  vec2 uv = (gl_FragCoord.xy / u_viewport_size) * (u_viewport_size / (pattern_size * u_scale));
  // 加上 Offset 来模拟 "Jitter"
  ```

### 总结

这份文档目前的置信度较低，主要是因为**未确认 ABR 是否真的携带数据**。

**下一步行动建议**：
在写任何代码之前，**先做“逆向调研”**。

1.  找一个 Photoshop 笔刷，加上纹理，导出 `.abr`。
2.  用 Hex Editor 打开，搜索纹理的文件名或者 `8BIM` 头。
3.  如果找不到大块数据，那么你的 `patt.rs` 解析器设计就是无用功，你需要转而设计 `.pat` 导入器。

只要确认了这一点，这个设计文档就可以被批准实施了。

---
