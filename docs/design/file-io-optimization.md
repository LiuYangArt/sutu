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

### 第二阶段：架构重构 (深度优化 - 推荐)

目标: 所有格式，大文件，**零 JS 主线程阻塞**。

1.  **采用自定义协议 (Custom Protocol) - _核心变更_**:
    - **现状**: `Rust -> Base64/IPC -> JS String -> Image Object`。路径长，内存占用双倍，阻塞主线程。
    - **新方案**: 注册 `project://` 协议 (Tauri `uri_scheme`)。
    - **流程**:
      1.  Rust 解析文件，将图层数据缓存在内存 (HashMap) 或临时文件。
      2.  前端 `<img src="project://layer/{id}.png" />`。
      3.  浏览器网络线程直接请求 Rust，Rust 返回二进制流。
    - **收益**: **零 JS 开销**，利用浏览器原生图像解码，支持流式传输和缓存。

2.  **PSD 优化策略 (WebP/LZ4)**:
    - **放弃 QOI**: 浏览器原生不支持 QOI，JS/WASM 解码会阻塞 UI 线程。
    - **新策略 (配合自定义协议)**:
      - Rust 解析 PSD -> RGBA。
      - 编码为 **无损 WebP (Lossless WebP)** (编码速度快于 PNG，浏览器原生支持)。
      - 通过 `project://` 协议直接返回 WebP 数据。
    - **替代策略 (WebGL)**: 如果是 WebGL 渲染，可使用 LZ4 压缩原始数据，前端 WASM 极速解压上传 GPU。

3.  **缩略图优先与懒加载**:
    - `load_project` 仅返回图层树结构 + **微型缩略图** (Base64, ~64px)。
    - 前端利用 `IntersectionObserver` 监听视口，仅当图层可见时通过 `project://` 加载高清大图。

4.  **并行化**:
    - 图层数据解析与转换在 Rust 端并行执行 (Rayon)。

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

对于 PSD，我们仍然只有原始 RGBA 数据。
**调整**: 既然最终我们要上自定义协议，第一阶段先维持 "RGBA -> PNG (Fast Config) -> Base64"。
**后续**: 在第二阶段直接切换到 `RGBA -> WebP -> Custom Protocol`。

## 4. 实施顺序与 TODO

**推荐顺序**：先完成统一的第二阶段架构（自定义协议），再分别适配 ORA 和 PSD。

理由：
- 自定义协议是 ORA 和 PSD 共用的基础设施
- 避免为 PSD 单独做第一阶段优化（Fast PNG）后又要重构
- 一次性解决 Base64 膨胀、JS 主线程阻塞等根本问题

### TODO List

#### 第一阶段：ORA 快速优化 ✅ DONE
- [x] ORA 直接透传 PNG 字节，跳过解码/重编码 (`ora.rs`)
- [x] 缩略图同样直接透传

#### 第二阶段：自定义协议基础设施 ✅ DONE
- [x] 注册 `project://` 自定义协议 (Tauri `uri_scheme`)
- [x] 实现图层数据内存缓存 (`HashMap<LayerId, Vec<u8>>`)
- [x] 实现协议处理器：`project://layer/{id}` → 返回二进制流
- [x] 前端适配：`http://project.localhost/layer/{id}` (Windows 格式)
- [x] 后端 CORS header: `Access-Control-Allow-Origin: *` (`src-tauri/src/lib.rs`)
- [x] 前端 crossOrigin: `img.crossOrigin = 'anonymous'` (`src/components/Canvas/index.tsx`)
  - **已修复**: Canvas Taint 问题 (详见 `docs/postmortem/2026-01-22-canvas-taint-crossorigin.md`)

#### 第三阶段：ORA 适配自定义协议 ✅ DONE
- [x] `load_ora` 仅返回图层元数据（不含 image_data）
- [x] 图层 PNG 数据存入缓存，通过协议按需加载
- [ ] 实现微型缩略图（64px）用于图层面板预览 *(可选优化)*

#### 第四阶段：PSD 适配自定义协议 ✅ DONE
- [x] PSD 解码后使用 WebP 无损编码（替代 PNG）
- [x] WebP 数据存入缓存，通过协议返回
- [x] 使用 Rayon 并行解码多图层
- [x] `image_data` 设为 `None`，前端通过 `project://` 协议加载

#### 第五阶段：懒加载与增量优化
- [ ] 前端 `IntersectionObserver` 监听可见图层
- [ ] 仅加载视口内图层的高清数据
- [ ] 图层面板使用微型缩略图，画布按需加载原图

## 5. 验证

1.  测量打开一个大型 `.ora` 文件的时间。
2.  应用第一阶段修复。
3.  再次测量时间。预期减少 >50% 的时间。
