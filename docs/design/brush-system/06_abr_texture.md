# ABR 纹理与图案系统设计 (Revised)

> 基于 Review 意见的修正版设计 (v2.0)
> 核心策略转变：从“尝试从 ABR 提取”转变为“构建统一的 Pattern 库与链接机制”

## 1. 核心风险与对策

**现状认知**：
ABR 文件格式存在两种情况：

1.  **嵌入式 (Embedded)**：极少数文件在 `8BIM` 块中包含完整的 `patt` 图像数据。
2.  **引用式 (Referenced)**：**绝大多数** ABR 文件仅包含 `Txtr` 参数和一个指向外部图案的 `UUID/Name`。

**设计准则**:
系统必须具备**容错性**。当 ABR 仅包含引用时，不能让功能失效，而应提供“缺失资源占位符”并允许用户通过导入 `.pat` 文件来补充资源。

## 2. 架构设计：Pattern Library

不再是简单的 ABR 解析器扩展，而是建立一个独立的**图案资源库 (Pattern Library)**。

### 2.1 数据模型

```rust
// src-tauri/src/brush/pattern_library.rs

pub struct PatternResource {
    /// 内容哈希 (SHA-256)，用于去重存储
    pub content_hash: String,

    /// 原始名称 (来自 .pat 或 ABR)
    pub name: String,

    /// 已知的 UUID/ID 列表 (一个图案可能有多个 ID 指向它)
    pub known_ids: Vec<String>,

    /// 图像元数据
    pub width: u32,
    pub height: u32,
    pub mode: PatternMode,
}

pub struct PatternLibrary {
    /// 内存索引：PatternID (UUID/Name) -> ContentHash
    pub id_map: HashMap<String, String>,

    /// 内存索引：ContentHash -> PatternResource
    pub resources: HashMap<String, PatternResource>,
}
```

### 2.2 存储方案 (Content-Addressable Storage)

为了避免重复存储（不同的笔刷包可能包含相同的噪点图），采用内容寻址存储。

- **存储路径**: `App_Data/patterns/{first_2_chars}/{rest_of_hash}.png`
  - 例如: `App_Data/patterns/a1/b2c3d4...png`
- **去重逻辑**: 导入新图案时，先计算 Raw RGBA 数据的 SHA-256。如果 Hash 已存在，仅更新 `id_map` 增加新的引用 ID，不写入文件。

## 3. 解析器实现方案

### 3.1 扩展 ABR 解析器

主要目标是提取参数，并**尝试**提取数据。

**在 `src-tauri/src/abr/parser.rs`**:

1.  扫描 `8BIM` 块。
2.  **Check A**: 如果发现 `patt` 块 (ID `0x0408` 或 `PHUT`), 尝试解码 Pattern 数据并存入 Library。
3.  **Check B**: 解析 `desc` 时，读取 `Txtr` 节点：
    - 记录 `pattern_uuid` 和 `pattern_name`。
    - 提取 `Scale`, `Depth`, `BlendMode`, `Invert` 等参数。
    - **Link**: 查询 Library 是否已有该 UUID。如果没有，标记为 `Missing`。

### 3.2 新增 PAT 解析器

为了弥补 ABR 数据的缺失，必须支持标准 `.pat` 文件导入。

**在 `src-tauri/src/format/pat_parser.rs`**:
支持 Adobe Photoshop Pattern File Format。

- **Header**: Version, Mode, Width, Height, Name.
- **Compression**: 解码 PackBits (RLE) 压缩的数据。
- **Color Conversion**: 将 CMYK / Grayscale / Indexed 转换为标准 RGBA8。

## 4. 渲染管线 (Shader)

复刻 Photoshop 的 Texturize 逻辑。

### 4.1 数据准备

- CPU 端将 Pattern 图片上传至 TextureArray 或利用 Bindless Texture。
- 传入 Uniforms: `u_texture_scale`, `u_texture_depth`, `u_texture_mode`, `u_pattern_size`.

### 4.2 Fragment Shader 逻辑

```glsl
// Screen Space UV Calculation
// 纹理通常是相对于"纸张"固定的，不随笔画路径旋转
vec2 screen_uv = gl_FragCoord.xy / u_viewport_size;

// 调整 Tiling
// Ps Scale 是相对于 Pattern 原始尺寸，不是相对于 Brush Size
vec2 pattern_uv = (gl_FragCoord.xy) / (u_pattern_size * u_scale / 100.0);

// Sample Texture
float tex_value = socket_sample_pattern(pattern_uv).r; // 假设使用灰度处理
if (u_invert) tex_value = 1.0 - tex_value;

// Depth Calculation (Contrast/Visibility)
// Depth 越低，纹理越不可见（100% Depth = Full Texture Effect）
// Depth 同时也受压感控制 (Depth Jitter)
float dynamic_depth = u_depth * u_pressure_depth_control;

// Blending (Texture as a Mask/Modifier)
// 这里的 Mode 是 Texture 与 Tip 的混合，常见是 Multiply 或 Subtract
float influence = 1.0;

if (u_mode == TEXTURE_MODE_MULTIPLY) {
    // 模拟正片叠底：纹理越黑(0)，输出越黑。Depth 控制混合程度。
    influence = mix(1.0, tex_value, dynamic_depth);
} else if (u_mode == TEXTURE_MODE_SUBTRACT) {
    // 模拟减去：纹理越亮，扣除越多
    influence = mix(1.0, 1.0 - tex_value, dynamic_depth);
} else if (u_mode == TEXTURE_MODE_HEIGHT) {
    // 模拟高度图（类似 impasto 的感觉，比较复杂，v2 实现）
    influence = mix(0.5, tex_value, dynamic_depth) * 2.0;
}

// Final Alpha Modulation
final_alpha *= influence;
```

## 5. 任务清单 (Revised Task List)

### Phase 3.1: 基础架构

- [ ] **Impl**: 实现 `PatternLibrary` 结构与 `CAS` 存储逻辑 (Hash计算, 文件读写)。
- [ ] **Impl**: 实现基础 `.pat` 文件解析器 (支持 RLE, Mode 转换)。

### Phase 3.2: ABR 集成

- [ ] **Impl**: 修改 `AbrParser`，增加对 `Txtr` 参数块的解析。
- [ ] **Impl**: 在 ABR 导入流程中，增加 Pattern Link 步骤（自动匹配库中已有的 Pattern）。
- [ ] **Impl**: 尝试探测 ABR 中的 `patt` 块（低优先级，视样本验证结果而定）。

### Phase 3.3: 渲染实现

- [ ] **Impl**: `BrushShader` 增加 Pattern Uniforms。
- [ ] **Impl**: 实现 `Texturize` 核心算法 (Screen Space UV + Depth Mix)。
- [ ] **UI**: 笔刷设置面板增加 "Texture" 选项卡 (预览图 + 参数滑块)。

## 6. 验证计划

1.  **Unit Test**: 构造极简的 `.pat` 文件进行解析测试。
2.  **Integration Test**: 导入一个已知只含引用的 ABR，断言其 Pattern 状态为 Missing。
3.  **Integration Test**: 手动导入对应的 `.pat`，断言 ABR 笔刷自动恢复关联。
