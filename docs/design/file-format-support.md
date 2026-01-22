# File Format Support Design

## 1. 概述 (Overview)

为了满足 PaintBoard 的文件保存需求，同时兼顾**开源生态交换** (OpenRaster) 和**通用软件预览/查看** (TIFF)，我们将实现两种格式的导入与导出支持。

- **OpenRaster (.ora)**: 作为主推的**工程文件格式**。它是开放标准，支持完整的图层结构、混合模式和分组，可与 Krita/GIMP/MyPaint 互通。
- **TIFF (.tiff)**: 作为**兼容性格式**。利用 TIFF 的多页特性和标签扩展性，实现既能在 Windows 照片查看器/Mac 预览中正常查看（合并图），又能在 PaintBoard 中恢复图层结构。

## 2. 技术选型 (Tech Stack)

所有文件读写操作将在 **Rust 后端** (`src-tauri`) 完成，以利用 Rust 强大的二进制处理能力和并发性能。

| 功能           | OpenRaster (.ora)      | TIFF (.tiff)                 | PSD (.psd)                  |
| :------------- | :--------------------- | :--------------------------- | :-------------------------- |
| **容器/压缩**  | `zip` crate (Deflate)  | `tiff` crate / `image` crate | Custom / RLE (PackBits)     |
| **元数据解析** | `quick-xml` (读写 XML) | 自定义 TIFF Tag (存储 JSON)  | Binary Parsing (Big Endian) |
| **图像编解码** | `image` crate (PNG)    | `image` crate (TIFF Encoder) | Custom Raw Channel Writer   |
| **序列化**     | `serde`, `serde_json`  | `serde`, `serde_json`        | Custom Binary Serializer    |

> **注意**: PSD 的详细实现方案请参阅 [PSD Implementaion Design](./psd-format-implementation.md)。

---

## 3. OpenRaster (.ora) 实现方案

OpenRaster 本质上是一个包含特定目录结构的 ZIP 归档文件。

### 3.1 文件结构

```text
project.ora (ZIP Archive)
├── mimetype                # 内容固定为 "image/openraster" (Store, No Compression)
├── stack.xml               # 描述图层堆栈、混合模式、位置
├── Thumbnails/
│   └── thumbnail.png       # 256x256 预览图
└── data/                   # 存放图层数据的文件夹
    ├── layer_uuid_1.png    # 具体的图层像素 (PNG)
    └── layer_uuid_2.png
```

### 3.2 元数据映射 (stack.xml)

我们需要将 `useDocumentStore` 中的图层属性映射到 ORA 标准。

```xml
<image w="1920" h="1080">
  <stack>
    <!-- 图层组 -->
    <stack name="Lineart Group" composite-op="svg:src-over">
       <layer name="Inking" src="data/layer_1.png" x="0" y="0" composite-op="svg:src-over" opacity="1.0" />
    </stack>
    <!-- 普通图层 -->
    <layer name="Background" src="data/layer_0.png" composite-op="svg:src-over" />
  </stack>
</image>
```

**混合模式映射表 (PaintBoard -> ORA):**

- `normal` -> `svg:src-over`
- `multiply` -> `svg:multiply`
- `screen` -> `svg:screen`
- `overlay` -> `svg:overlay`
- (其他标准 SVG 混合模式直接映射)

### 3.3 读写流程

**保存 (Export):**

1. 前端: 渲染一张缩略图 (256px)。
2. 前端: 遍历所有图层，将每个图层的像素数据转换为 Blob (PNG格式)。
3. 前端: 生成图层树的 JSON 结构。
4. **Rust**: 接收数据，创建 ZIP Writer。
5. **Rust**: 写入 `mimetype` (Store模式)。
6. **Rust**: 遍历图层，并发保存 `data/*.png`。
7. **Rust**: 生成 `stack.xml` 并写入。
8. **Rust**: 写入缩略图。

**读取 (Import):**

1. **Rust**: 解压 ZIP，读取 `stack.xml`。
2. **Rust**: 解析图层结构，并行读取 `data/` 下的 PNG 文件解码为 RGBA。
3. **Rust**: 将结构重组为 PaintBoard 的 `DocumentState` 对象返回给前端。

---

## 4. TIFF (.tiff) 实现方案 (支持图层)

为了解决“普通看图软件能看”且“PaintBoard能编辑”的矛盾，我们采用 **"合并图 + 私有数据"** 的策略。

### 4.1 核心策略：Payload Carrier

标准 TIFF 对于“带有混合模式的图层”支持非常薄弱。为了实现目标，我们将 TIFF 结构设计如下：

- **Page 1 (IFD 0) - 主图像**:
  - 存储**全图合并后**的扁平图像 (Flattened Image)。
  - **作用**: Windows 照片查看器、Mac Preview、浏览器会默认显示这一页。保证了用户在任何地方看到的都是完整的画作。
- **Custom Tag (私有标签) - 元数据**:
  - TIFF 允许写入自定义 Tag。我们将申请一个私有 ID (例如 `70001` 仅作内部约定)，在该 Tag 中存储 PaintBoard 图层结构的 **JSON 字符串**。
  - JSON 包含：Layer ID, Name, Opacity, BlendMode, IsVisible, Locked 等信息，以及该图层对应的数据存储在哪个 IFD 页面。
- **Page 2..N (IFD 1..N) - 图层数据**:
  - 后续的每一页存储一个独立图层的原始像素数据 (RGBA)。
  - **作用**: PaintBoard 读取时，不仅读取 Page 1，还会扫描私有 Tag，根据 JSON 将 Page 2..N 还原回独立的图层。

### 4.2 TIFF 结构示意

```text
[TIFF Header]
   |
   v
[IFD 0: Flattened Image] <--- 通用浏览器/看图软件只展示这个
   |-- Width, Height, Compression(LZW/Deflate)
   |-- StripOffsets (指向合并后的像素数据)
   |-- (Tag 37724) ImageSourceData: [JSON String of Layer Structure] <--- PaintBoard 读取这个恢复图层
   |
   v
[IFD 1: Layer 1 Raw Data] <--- PaintBoard 内部使用
   |-- Compression (Deflate)
   |
   v
[IFD 2: Layer 2 Raw Data]
   ...
```

### 4.3 读写流程

**保存 (Export):**

1. 前端: 提供一张**合并后**的完整 Canvas 图像数据 (作为预览图/Page 1)。
2. 前端: 提供所有独立图层的图像数据。
3. 前端: 提供图层元数据 (JSON)。
4. **Rust**:
   - 创建 TIFF Encoder。
   - 写入 Page 1 (合并图像)。
   - 在 Page 1 的 Tags 中嵌入序列化后的 元数据 JSON。
   - 循环写入 Page 2..N (独立图层数据)。

**读取 (Import):**

1. **Rust**: 打开 TIFF 文件。
2. **Rust**: 检查是否存在特定的 PaintBoard 元数据 Tag。
   - **存在**: 说明这是 PaintBoard 生成的项目文件。解析 JSON，根据索引读取后续 IFD 页面，重建完整图层树。
   - **不存在**: 说明这是一张普通的 TIFF 图片。直接读取 IFD 0，将其作为一个单独的 "Background" 图层导入。

---

## 5. 实现任务清单 (Task List)

### Phase 1: 基础设施 (Infrastructure)

- [ ] 后端: 添加 crate 依赖 (`zip`, `quick-xml`, `tiff`, `serde`, `serde_json`, `base64`)。
- [ ] 后端: 定义统一的 `LayerData` 结构体，用于在前后端传输图层像素和元数据。

### Phase 2: OpenRaster (.ora)

- [ ] 后端: 实现 `ora_writer::save_ora(path, project_data)`。
- [ ] 后端: 实现 `ora_reader::read_ora(path)`。
- [ ] 后端: 实现 `stack.xml` 生成与解析逻辑。
- [ ] 前端: 实现 canvas 导出 Blob 逻辑。

### Phase 3: TIFF (Layered)

- [ ] 后端: 实现 `tiff_writer::save_layered_tiff(path, project_data)`。
  - 重点难点: 调研 `tiff` crate 是否支持写入 Custom Tags (若不支持可能需要裸写部分 Tag 或 Fork)。
- [ ] 后端: 实现 `tiff_reader::read_layered_tiff(path)`。
- [ ] 前端: 增加保存对话框的文件类型选项 (.ora, .tiff)。

## 6. 风险与注意事项

1.  **TIFF Custom Tags 支持**: Rust 的 `image` crate 对 TIFF 的写入支持较为基础，可能不支持自定义 Tag 写入。如果遇到此限制，可能需要切换到直接操作二进制或寻找更底层的 TIFF 库。
    - _备选方案_: 如果 Custom Tags 难以实现，可以将元数据 JSON 压缩后作为最后一张“图片”（编码为像素）存储，但这比较 Hack。或者存储在 `ImageDescription` (Tag 270) 或 `Software` (Tag 305) 标准字段中（如果 JSON 长度允许）。建议优先尝试 `ImageDescription`，它的兼容性最好。
2.  **大文件性能**: 对于高分辨率多图层文件，IPC 传输大量二进制数据 (Frontend -> Rust) 会有开销。建议像素数据尽可能在 Rust 端直接通过 Buffer 指针处理，或者分块传输。
