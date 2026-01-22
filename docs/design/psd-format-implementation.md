# PSD 文件格式支持 (PSD File Format Support)

## 1. 目标 (Objective)

在 PaintBoard 中实现 **Adobe Photoshop (.psd)** 格式的原生读写支持，实现与 Photoshop 和 Krita 的工作流互通。
核心目标是**支持图层结构（Layers）**、**混合模式（Blend Modes）**和**透明度**的完整保留。

## 2. Krita 源码分析 (Krita Implementation Analysis)

通过对 Krita (`f:\CodeProjects\krita`) 源码的深度调研，我们梳理出了 PSD 读写的关键路径。Krita 的实现严格遵循 Adobe Photoshop File Format Specification，代码主要分布在 `libs/psd` (核心数据结构) 和 `plugins/impex/psd` (导入导出逻辑) 中。

### 2.1 核心文件参考

- **导入逻辑**: `plugins/impex/psd/psd_loader.cpp`
  - 负责按顺序解析 PSD 的各个 Section。
  - 使用 `PSDLayerRecord` 解析图层信息，并重建 Krita 的 `KisImage` / `KisLayer` 树。
  - 处理了很多兼容性边缘情况（如 unbalanced group markers）。
- **导出逻辑**: `plugins/impex/psd/psd_saver.cpp`
  - 负责将内部图层树扁平化为线性结构写入 PSD。
  - **关键点**: Photoshop 要求同时写入“合并后的全图数据 (Image Data)”和“图层及蒙版信息 (Layer and Mask Information)”。如果只写图层不写全图，某些软件预览会失效；如果只写全图不写图层，就失去了编辑性。
- **数据结构**: `libs/psd/psd_header.h`, `libs/psd/psd_layer_record.h`
  - 定义了精细的二进制结构，如 `ChannelInfo` (通道压缩与偏移)、`LayerBlendingRanges` 等。

### 2.2 PSD 文件结构摘要

PSD 文件本质上是一个大端序 (Big-Endian) 的二进制流，分为 5 个主要部分：

1.  **File Header**: 固定 26 字节。
    - Signature: "8BPS"
    - Channels: 4 (RGBA)
    - Depth: 8/16
    - Mode: 3 (RGB)
2.  **Color Mode Data**: 索引颜色模式用，RGB 模式下通常长度为 0。
3.  **Image Resources**: 存储非像素元数据。
    - 分辨率 (ResolutionInfo)
    - 参考线 (Grid/Guides)
    - ICC Profile
    - Krita 甚至在这里存了自定义的 XML 元数据。
4.  **Layer and Mask Information**: **(最复杂的部分)**
    - 包含图层结构、混合模式、图层名、通道长度信息。
    - 每个通道的像素数据紧随 Layer Record 之后存储。
5.  **Image Data**:
    - 整张图合并后的像素数据 (Compatibility Image)。
    - 使用 RLE (PackBits) 压缩。

---

## 3. PaintBoard 实现设计 (Implementation Design)

由于 Rust 生态中现有的 `psd` crate 主要是 **Read-Only** 且功能有限（通常只支持读取合并图或简单的图层提取，不支持写入复杂的图层结构），我们需要**从头实现一个精简版的 PSD Writer**。

### 3.1 架构设计

在 `src-tauri/src/file_formats/psd/` 下建立模块：

```rust
pub mod serializer;   // 负责写入
pub mod parser;       // 负责读取
pub mod structs;      // 定义 Header, LayerRecord 等结构体
pub mod compression;  // 实现 RLE (PackBits) 算法
```

### 3.2 导出流程 (Export Workflow)

参考 Krita 的 `PSDSaver::buildFile`，我们的导出步骤如下：

#### Step 1: 准备数据

从 `DocumentStore` 获取图层树，将其展平为列表（PSD 的图层是线性存储的，通过 Group Markers `lsct` 来标记组的开始和结束）。

- 需要计算每个通道压缩后的字节大小，这通过预先运行 RLE 压缩实现。

#### Step 2: 写入 Header

```rust
struct PsdHeader {
    signature: [u8; 4], // "8BPS"
    version: u16,       // 1
    reserved: [u8; 6],  // 0
    channels: u16,      // 4 (R, G, B, A)
    height: u32,
    width: u32,
    depth: u16,         // 8
    mode: u16,          // 3 (RGB)
}
```

#### Step 3: 写入 Image Resources

至少写入 **ResolutionInfo** (Tag `0x03ED`)，否则在 Photoshop 中打开 DPI 可能不正确（默认为 72）。

#### Step 4: 写入 Layer and Mask Information (核心)

这是最大的挑战。结构层级：

- **Length Word**: 整个 Section 的长度（需要先在内存中构建完才能计算，或者使用占位符后回填）。
- **Layer Info**:
  - **Layer Count**: 图层数量（负数表示包含 Alpha 通道供合并图使用，通常用绝对值）。
  - **Layer Records**: 遍历每个图层写入：
    - ROI (Top, Left, Bottom, Right)
    - Channels Info (每个通道的压缩大小)
    - Blend Mode Key (e.g., `norm`=Normal, `mul `=Multiply)
    - Opacity
    - Clipping
    - Flags (Visible, etc.)
    - **Extra Data**:
      - Layer Mask Data
      - Layer Blending Ranges
      - Layer Name (Pascal String, padded 4)
  - **Channel Image Data**:
    - 按顺序写入每个图层的通道像素数据。
    - 格式：`[Compression Code (u16)]` + `[Compressed Data]`。
    - 如果用 RLE，每行前面还要有 ByteCounts。

#### Step 5: 写入 Image Data

将 Canvas 的当前渲染结果（Composite）进行 RLE 压缩后写入。这是为了兼容不支持图层的查看器。

### 3.3 导入流程 (Import Workflow)

导入相对简单，可以考虑使用或魔改现有的 `psd` crate，或者直接根据上述结构逆向解析。

1.  读取 Header，校验 "8BPS"。
2.  跳过 Color Mode Data。
3.  跳过 Image Resources (或读取 DPI)。
4.  解析 Layer Mask Info：
    - 读取 Layer Records，建立图层属性列表。
    - 读取 Channel Data，解压 RLE，填充到 PaintBoard 的 Buffer 中。
5.  如果 Layer Section 为空，则降级读取最后的 Image Data 作为单层背景。

### 3.4 关键算法：PackBits (RLE)

PSD 使用的 RLE 变体（PackBits）是必须实现的：

- **Header Byte (N)**:
  - `0 <= N <= 127`: 读取接下来的 `N + 1` 个字节（Literal）。
  - `-127 <= N <= -1`: 重复下一个字节 `1 - N` 次（Run）。
  - `-128`:用于对齐/无操作。

---

## 4. 当前实现状态 (Current Implementation Status)

### 4.1 模块结构

实际代码位于 `src-tauri/src/file/psd/`：

```
src-tauri/src/file/psd/
├── mod.rs          # 模块导出
├── writer.rs       # PSD 写入器 ✅ 生产使用
├── reader.rs       # PSD 读取器 ✅ 生产使用（基于 psd crate）
├── compression.rs  # PackBits 压缩/解压
└── types.rs        # PSD 数据结构定义
```

### 4.2 代码使用情况

| 文件             | 组件                      | 状态    | 说明                          |
| ---------------- | ------------------------- | ------- | ----------------------------- |
| `writer.rs`      | 整体                      | ✅ 生产 | 完整的 PSD 写入功能           |
| `reader.rs`      | 整体                      | ✅ 生产 | 使用外部 `psd` crate 实现读取 |
| `compression.rs` | `packbits_encode()`       | ✅ 生产 | 写入时压缩通道数据            |
| `compression.rs` | `packbits_decode()`       | 🔒 保留 | 供测试验证 + 未来自研读取     |
| `compression.rs` | `CompressionError`        | 🔒 保留 | 解压错误类型                  |
| `types.rs`       | `ColorMode::Rgb`          | ✅ 生产 | 写入 PSD header               |
| `types.rs`       | `ColorMode` 其他变体      | 🔒 保留 | 完整规范定义，供未来扩展      |
| `types.rs`       | `PsdHeader::write()`      | ✅ 生产 | 写入文件头                    |
| `types.rs`       | `PsdHeader::SIZE`         | 🔒 保留 | 测试验证用                    |
| `types.rs`       | `ChannelInfo::write()`    | ✅ 生产 | 写入通道信息                  |
| `types.rs`       | `ChannelInfo::SIZE`       | 🔒 保留 | 未来读取用                    |
| `types.rs`       | `LayerFlags::to_byte()`   | ✅ 生产 | 写入图层标志                  |
| `types.rs`       | `LayerFlags::from_byte()` | 🔒 保留 | 未来自研读取用                |
| `types.rs`       | `ResolutionInfo::write()` | ✅ 生产 | 写入分辨率信息                |
| `types.rs`       | `ResolutionInfo::SIZE`    | 🔒 保留 | 测试验证用                    |

> **🔒 保留代码说明**: 标记为 `#[allow(dead_code)]` 的代码虽未在生产中直接调用，但有明确用途：
>
> 1. 测试覆盖（如 roundtrip 验证压缩算法）
> 2. 规范完整性（如 `ColorMode` 枚举）
> 3. 未来自研 PSD 读取功能预留

### 4.3 设计决策

**PSD 读取策略**: 当前使用外部 `psd` crate 而非自研实现，原因：

- `psd` crate 已处理大量边缘情况和兼容性问题
- 自研读取器的 ROI 不高，写入功能更重要
- 保留 `packbits_decode()` 和 `from_byte()` 等代码，以便未来需要时可快速切换到自研实现

## 5. 任务清单 (Task List)

### Phase 1: 基础架构与压缩 ✅

- [x] Rust: 实现 `PackBits` (RLE) 压缩与解压算法。
- [x] Rust: 定义 `PsdHeader` 和 `ChannelInfo` 等基础结构体 (参考 Krita `libs/psd/psd_header.h`)。
- [x] Rust: 实现二进制流写入器 `BigEndianWriter`。

### Phase 2: 简单导出 (Flattened) ✅

- [x] Rust: 实现只写 Header + Image Data 的导出器。
- [x] 验证: 生成的文件能在 Photoshop/Krita 中打开（显示为单层背景）。

### Phase 3: 图层导出 (Layered) ✅

- [x] Rust: 实现 `LayerRecord` 的序列化。
- [x] Rust: 实现多图层通道数据的组织与写入。
- [x] Rust: 支持基本混合模式映射 (Normal, Multiply, Screen, Overlay)。
- [x] 验证: 导出多图层文件，检查层级和混合模式是否正确。

### Phase 4: 导入 (Parsing) ✅

- [x] Rust: 集成 `psd` crate 实现 PSD 解析。
- [x] 前端: 对接导入接口，恢复图层状态。

## 5. 后续规划 (Future Roadmap)

### Phase 5: 高级特性与优化

- [ ] **DPI/Resolution 读取**:
  - 当前导入时 DPI默认为 72。需要解析 `Image Resources` (ID `0x03ED`) 以获取正确的文档分辨率并同步到 PaintBoard 项目设置。
- [ ] **图层组 (Layer Groups)**:
  - 实现 `lsct` (Section Divider Setting) 的解析与写入，以支持嵌套的图层组结构。
  - 目前 PaintBoard 将图层处理为线性结构，完善图层组需要配合前端 `useDocumentStore` 的树状结构改造。
- [ ] **性能优化 (Performance Optimization)**:
  - **Custom Protocol 传输 (参考 `docs/design/file-io-optimization.md`)**:
    - 目前 `commands.rs` 将图层数据转为 Base64 字符串传递给前端，导致内存和解析瓶颈。
    - **新方案**: 采用自定义协议 (`project://`) + 无损 WebP 格式。
    - 后端解析 PSD 获取 RGBA -> 编码为 WebP -> 浏览器通过网络线程直接请求 `project://layer/{id}` 加载，实现零 JS 主线程阻塞。
  - **图层边界裁剪 (Trim Bounds)**: 导出时计算每个图层的实际有效像素范围 (Bounding Box)，而非总是保存全画布尺寸。这将显著减小文件体积并提升保存速度。
- [ ] **色彩管理**:
  - 支持 ICC Profile 的读写 (Image Resource ID `0x040F`)，确保跨软件的色彩一致性。

## 6. 参考资料

- **Adobe Photoshop File Format Specification**: [Link](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/)
- **Krita Source**: `plugins/impex/psd/`
- **Rust `psd` crate**: [GitHub](https://github.com/PistonDevelopers/psd) (主要参考其 Parser 实现)
