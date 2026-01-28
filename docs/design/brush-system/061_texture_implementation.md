# 笔刷纹理系统实现技术文档 (Texture System Implementation)

**文档版本**: 1.0
**最后更新**: 2026-01-27
**状态**: Phase 2 Completed (Resource Extraction & Integration)

## 1. 概述 (Overview)

PaintBoard 的纹理系统旨在支持 Photoshop 兼容的纹理笔刷效果。该系统允许笔刷在绘制过程中通过纹理图案（Pattern）来调制不透明度（Opacity），从而模拟纸张纹理、噪点或特定的笔触质感。

本文档详细描述了从 ABR 文件解析、资源存储到前端渲染的完整技术实现细节，特别是针对 Photoshop CS6+ 复杂笔刷包中“分离式存储结构”的支持方案。

## 2. 核心架构 (Architecture)

系统采用 **资源与定义分离** 的架构，通过后端进行统一的资源去重管理，前端按需加载。

```mermaid
graph TD
    User[用户] -->|导入 ABR/PAT| Cmd[Tauri Command: import_abr/pat]

    subgraph Backend [Rust Core]
        Cmd --> Parser[AbrParser / PatParser]
        Parser -->|1. 提取原始图像| RawData[Raw Pattern Data]
        RawData -->|2. 计算 SHA256| Hash[Content Hash]
        Hash -->|3. 去重存储| Lib[PatternLibrary (CAS)]
        Lib -->|存储| Disk[App Data/patterns/*.lz4]
    end

    subgraph Frontend [React/TS]
        Cmd -->|4. 返回笔刷预设| Presets[BrushPresets]
        Presets -->|5. 应用设置| Store[ToolStore]
        Store -->|6. 请求纹理| PM[PatternManager]
        PM -->|7. Lazy Load| Proto[Protocol: project://pattern/:id]
    end

    Proto -->|8. 读取| Lib
```

### 2.1 关键设计决策

1.  **内容寻址存储 (CAS, Content-Addressable Storage)**:
    - **问题**: 不同的笔刷包可能包含完全相同的通用纹理（如标准噪点图）。
    - **解法**: 使用 SHA-256 哈希作为资源的物理存储键值。这确保了无论导入多少次，相同的纹理只会在磁盘上存储一份。
    - **映射**: 维护 `PatternUUID (来自 ABR)` -> `ContentHash` 的映射表。

2.  **分离式 ABR 解析 (Separated Storage Support)**:
    - **发现**: 现代 ABR 文件（特别是工具预设导出的）不再将纹理设置嵌入在每个笔刷的 `samp` 段中，而是将所有纹理打包在文件尾部的全局 `patt` 段。
    - **实现**: 解析器在读取完笔刷定义后，会主动扫描文件以查找全局资源段，并将其批量导入库中。

3.  **懒加载机制 (Lazy Loading)**:
    - **性能**: 避免启动时加载数百兆的纹理数据到内存。
    - **协议**: 前端仅持有 ID，仅在渲染需要时通过 `project://pattern/{id}` 协议请求数据。

## 3. 后端实现细节 (Rust)

### 3.1 ABR 解析器升级 (`src-tauri/src/abr/parser.rs`)

针对 `liuyang_paintbrushes.abr` 等复杂文件，我们实现了多阶段解析策略：

1.  **Header 解析**: 识别 ABR 版本（V6/V10）。
2.  **Sample 扫描**: 解析 `samp` 段，提取笔刷尖端形状（Brush Tips）。
    - _注_: 在分离式结构中，此处的 `Txtr` 元数据通常为空。
3.  **Global Section 扫描 (Phase 1)**:
    - 解析器会跳过已读取区域，继续向后扫描文件。
    - 寻找 `8BIM` 签名的 `patt` (Patterns) 数据块。
    - 一旦发现，提取整个数据块（可能包含数十个图案）。

```rust
// 伪代码：解析流程
let brushes = parse_brushes(cursor)?;
// 尝试寻找全局 pattern 段
if header.version.is_new_format() {
    if let Ok(true) = reach_8bim_section(&mut cursor, "patt") {
        // 提取 19MB+ 的纹理数据
        let pattern_data = read_section(cursor)?;
        abr_file.patterns = Some(pattern_data);
    }
}
```

### 3.2 图案解析 (`src-tauri/src/format/pat_parser.rs`)

实现了完整的 Adobe Pattern File (`.pat`) 格式解析器：

- **色彩模式**: 支持 Grayscale, Indexed (8-bit), RGB, CMYK。
- **压缩**: 支持 PackBits (RLE) 解压。
- **转换**: 所有格式统一转换为 `RGBA8` 用于渲染。

### 3.3 PatternLibrary (`src-tauri/src/brush/pattern_library.rs`)

负责所有图案资源的持久化管理：

- **存储路径**: `App_Data/patterns/{hash_prefix}/{hash_suffix}.lz4`
- **索引文件**: `library_index.json`，记录 `ID -> Hash` 及元数据（宽、高、模式）。
- **接口**:
  - `add_pattern`: 接收原始数据 -> 计算 Hash -> 存盘 -> 更新索引。
  - `get_by_id`: 查找元数据。
  - `load_texture_data`: 读取 LZ4 文件 -> 解压 -> 返回给 Protocol。

## 4. 前端集成细节 (Frontend)

### 4.1 笔刷预设映射 (`BrushPresets.tsx`)

当用户导入 ABR 时，后端返回的 `BrushPreset` 包含以下新增字段：

```typescript
export interface AbrTextureSettings {
  enabled: boolean;
  patternUuid: string | null; // 关键关联 ID
  scale: number;
  depth: number;
  mode: string; // blend mode
  // ...
}
```

前端 `applyPreset` 函数负责将这些设置映射到全局 Zustand Store (`useToolStore`)。

### 4.2 PatternManager (`src/utils/patternManager.ts`)

单例管理器，负责运行时纹理的缓存与获取：

- **`loadPattern(id)`**:
  1.  检查内存缓存 (`Map<string, ImageData>`)。
  2.  若未命中，发起 `fetch('http://project.localhost/pattern/' + id)`。
  3.  从响应头 `X-Image-Width/Height` 解析尺寸。
  4.  构建 `ImageData` 并缓存。

### 4.3 渲染管线 (Rendering Pipeline)

当前实现了 CPU 侧的混合逻辑（GPU 侧待同步）：

- **采样**: 支持平铺（Tiling）采样。
- **混合**:
  - `Multiply`: 正片叠底（最常用）。
  - `Subtract`: 减去。
  - `Linear Height`: 线性高度（模拟深度）。
- **参数应用**:
  - `Depth`: 控制纹理对不透明度的最大影响程度。
  - `Scale`: 控制纹理采样时的缩放比。
