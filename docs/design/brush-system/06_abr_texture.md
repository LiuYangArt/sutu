# ABR 纹理与图案导入设计

> 扩展 ABR 解析器以支持纹理 (Texture) 和图案 (Pattern) 的导入。

## 现状分析

目前的 ABR 解析器 (Phase 3) 仅支持：

1. **Sampled Data (`samp`)**: 提取笔刷笔头图片。
2. **Basic Dynamics**: 提取基础的压感、散布动态。

**缺失功能**:

- ❌ **Texture (`Txtr`)**: 笔刷的纹理叠加设置（Scale, Depth, Mode）。
- ❌ **Patterns (`patt`)**: 嵌入在 ABR 文件中的图案资源。

**竞品参考 (Krita)**:

- Krita (`libs/brush/kis_abr_brush_collection.cpp`) 仅提取 `samp` 块中的笔头图片。
- Krita 能够读取独立的 `.pat` 文件 (`libs/pigment/resources/KoPattern.cpp`)，但似乎不从 ABR 中直接提取并自动关联图案。
- **结论**: 我们有机会做得比 Krita 更好，实现完整的 "All-in-One" 导入体验。

## 1. ABR 文件结构扩展

在 ABR (v6+) 文件中，除了 `samp` (笔头) 和 `desc` (预设参数) 外，还可能包含 `patt` (图案) 块。

```
8BIM "samp" -> 笔头图片数据 (已实现)
8BIM "desc" -> 笔刷预设参数 (部分实现)
8BIM "patt" -> 嵌入的图案资源 (需新增)
```

### 1.1 `patt` 块结构 Reference

`patt` 块的内部结构通常遵循 Photoshop/GIMP Pattern File (`.pat`) 格式，或者是其变体。

**通用 Pattern 结构**:

```rust
struct PatternBlock {
    length: u32,
    patterns: Vec<Pattern>,
}

struct Pattern {
    image_length: u32,
    version: u32,        // Usually 1
    width: u32,
    height: u32,
    color_depth: u32,    // 1=Gray, 3=RGB, 4=RGBA
    magic: u32,          // 'GPAT' (GIMP) or similar
    name: PascalString,  // Pattern Name
    data: Vec<u8>,       // Raw pixel data (no compression in simple .pat, but ABR might differ)
}
```

_注：Adobe 的 `patt` 资源块可能包含特定的 Image Mode headers，需抓包验证。_

## 2. 解析器扩展方案

### 2.1 新增模块 `src-tauri/src/abr/patt.rs`

```rust
pub struct AbrPattern {
    pub uuid: String, // 生成或提取的唯一ID
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub mode: PatternMode, // Grayscale, RGB, Indexed...
    pub data: Vec<u8>,     // RGBA 像素数据
}

pub fn parse_patt_block(data: &[u8]) -> Result<Vec<AbrPattern>, AbrError> {
    // 类似于 .pat 文件的解析逻辑
    // 1. 读取 Header
    // 2. 读取 Image Data (可能需要处理 RowBytes padding)
    // 3. 转换为标准 RGBA
}
```

### 2.2 扩展 `ActionDescriptor` 解析 (`desc.rs`)

在 `src-tauri/src/abr/desc.rs` 中，需要增加对 `Txtr` (Texture) 键及其子参数的解析：

| Key    | Type                | Description                      | Target Struct          |
| ------ | ------------------- | -------------------------------- | ---------------------- |
| `Txtr` | Descriptor          | **纹理主块**                     | `AbrTextureParams`     |
| `Ptrn` | Descriptor / String | **关联图案** (包含 Name/ID)      | `texture_pattern_id`   |
| `Scl ` | UnitFloat (Percent) | 缩放 (Scale)                     | `texture_scale`        |
| `Md  ` | Enum                | 混合模式 (Multiply, Subtract...) | `texture_blend_mode`   |
| `Dpt ` | UnitFloat (Percent) | 深度 (Depth)                     | `texture_depth`        |
| `InvT` | Boolean             | 反相 (Invert)                    | `texture_invert`       |
| `sdDw` | Float               | 深度抖动 (Depth Jitter)          | `texture_depth_jitter` |

### 2.3 数据关联逻辑

1. **Pass 1 (`patt`)**: 扫描 ABR，解析所有 `patt` 块，将图案存入临时 Map (Key: Pattern Name / ID)。
2. **Pass 2 (`desc`)**: 解析笔刷预设。遇到 `Txtr` -> `Ptrn` 时，通过名字/ID 在 Pattern Map 中查找对应的资源。
3. **Link**: 如果找到图案，将图像数据通过 UUID 关联；如果未找到（引用了外部图案），则标记为 Missing 或尝试使用默认噪声图。

## 3. 存储与应用

### 3.1 资源存储

为了避免 ABR 文件过大导致内存爆炸，解析出的图案应当落盘：

- **路径**: `App_Data/patterns/{uuid}.png`
- **元数据**: 在数据库或 JSON 中记录 Pattern UUID -> File Path 的映射。

### 3.2 笔刷引擎集成

扩展 `BrushPreset` 结构体：

```typescript
interface BrushPreset {
  // ... existing fields
  texture?: {
    enabled: boolean;
    patternId: string; // 指向图案资源
    scale: number;
    depth: number;
    mode: BlendMode;
  };
}
```

在 `BrushEngine` (Rust) 和 GPU Shader 中，需增加 Texture Sampler：

- 将 Pattern 上传为 GPU Texture。
- 在 Shader 中计算 UV (通常基于 Screen Space 或 Stroke Space)。
- 根据 Depth 和 Blend Mode 混合该纹理。

## 4. 任务清单 (Task List)

- [ ] **Research**: 获取带 Pattern 的 ABR 样本文件，分析 8BIM `patt` 二进制结构。
- [ ] **Impl**: 实现 `src-tauri/src/abr/patt.rs` 解析器。
- [ ] **Impl**: 扩展 `AbrParser` 以支持 `patt` 块读取。
- [ ] **Impl**: 更新 `AbrDynamics` 和 `ActionDescriptor` 解析逻辑，支持 `Txtr` 字段。
- [ ] **Test**: 编写单元测试，验证从 ABR 提取图案并成功还原图片。
