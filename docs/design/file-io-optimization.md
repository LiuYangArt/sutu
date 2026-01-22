# 文件加载优化方案

## 1. 现状分析

**当前实现**: Rust 后端 (瓶颈所在)

当前的文件打开流程 (`menu > open`) 主要由 Rust 后端处理，但存在严重的效率问题：

1.  **冗余转码 (ORA)**:
    - 现有流程: `ZIP (PNG)` -> `解码为 RGBA (CPU 密集)` -> `重编码为 PNG (CPU 密集)` -> `Base64 编码` -> `IPC (JSON)` -> `前端解码`.
    - `image::load_from_memory` 和 `img.write_to` 步骤对于 ORA 文件完全是不必要的，因为其中的数据本来就是 PNG 格式。

2.  **转码开销 (PSD)**:
    - 现有流程: `PSD (Raw/RLE)` -> `解码为 RGBA` -> `编码为 PNG (CPU 密集)` -> `Base64 编码` -> `IPC`.
    - PNG 压缩步骤非常慢，并且运行在主线程上（阻塞了异步任务中的其他操作）。

3.  **数据传输低效**:
    - **Base64**: 使得数据量增加了约 33%。
    - **巨型载荷**: 所有图层被打包成一个巨大的 JSON 对象。在*所有数据*处理完成前，前端收不到任何响应。
    - **内存压力**: 巨大的字符串会在 JS 端引起严重的 GC 压力。

## 2. 优化策略

### 第一阶段：快速见效 (立竿见影)

目标: ORA 文件 (以及部分 PSD)

1.  **ORA 直接透传**:
    - **动作**: 修改 `src-tauri/src/file/ora.rs`。
    - **逻辑**: 不从 ZIP 中解码 PNG，而是读取原始字节并直接进行 Base64 编码。
    - **收益**: 消除两个最昂贵的 CPU 操作（PNG 解码和重编码）。

2.  **PSD 优化**:
    - **动作**: 使用更快的压缩设置或格式进行 IPC 传输，或者如果可能的话跳过 PNG 编码（尽管原始 RGBA 数据量巨大）。
    - **替代方案**: 使用 `FAST` 压缩预设进行 PNG 编码，而非默认设置。

### 第二阶段：架构重构 (推荐)

目标: 所有格式，大文件

1.  **分离元数据与图像数据 (懒加载)**:
    - **逻辑**: `load_project` 仅返回 `ProjectMetadata` (尺寸, 图层信息, IDs)，_不包含_ 图像数据。
    - **UI**: 前端立即显示图层列表和占位符。
    - **获取**: 前端单独请求图层图像 (例如: `get_layer_image(layer_id)`)。

2.  **二进制数据传输**:
    - **动作**: 停止在 JSON 中使用 Base64。
    - **方法**:
      - 使用 Tauri 2.0 高效的二进制命令通道 (如果可用且稳定)。
      - 或者返回 `Vec<u8>`，Tauri 会将其作为字节数组处理 (v1 中仍有 JSON 开销，但 v2 中更好)。

3.  **并行化**:
    - 图层可以并行加载，更有效地利用后端的多线程特性。

## 3. 实现计划 (第一阶段)

**文件**: `src-tauri/src/file/ora.rs`

```rust
// 当前代码
let img = image::load_from_memory_with_format(&img_data, ImageFormat::Png)?;
layer.image_data = Some(encode_png_to_base64(&img.to_rgba8())?);

// 优化后
// 由于 ORA 存储的数据就是 PNG，我们可以直接使用
layer.image_data = Some(BASE64.encode(&img_data));
```

**文件**: `src-tauri/src/file/psd/reader.rs`

对于 PSD，我们仍然只有原始 RGBA 数据。生成 PNG 很慢。
**选项**: 使用 `qoi` (Quite OK Image Format) 进行 IPC 传输？它的编码速度极快，且在 JS 端解码也很快 (通过 WASM 或简单的 JS 解析器)。
**选项**: 如果 IPC 通道支持高效传输，则发送原始 RGBA 字节。

## 4. 验证

1.  测量打开一个大型 `.ora` 文件的时间。
2.  应用第一阶段修复。
3.  再次测量时间。预期减少 >50% 的时间。
