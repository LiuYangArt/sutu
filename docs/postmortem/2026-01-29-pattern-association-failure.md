# ABR Pattern 关联失败与 UI 显示问题综合分析报告

**日期**: 2026-01-29
**相关模块**: `abr/parser`, `abr/patt`, `commands.rs`, `TextureSettings.tsx`, `LZ4Image.tsx`
**状态**: ✅ 已修复 (Fixed)

## 1. 问题背景

用户反馈在 PaintBoard 中导入 ABR 笔刷时遇到一系列 Pattern 相关问题：

1.  **关联缺失**: UI 显示 "Texture: None"，笔刷未能关联到正确的图案。
2.  **缩略图破损**: 即使关联ID正确，UI 上也不显示图案缩略图。
3.  **部分笔刷失效**: 特定笔刷 (如 Brush 65) 始终无法找到关联 Pattern。

经过深入排查，发现这是一个由 **5 个独立问题** 叠加导致的复杂 Bug。

## 2. 根因分析 (Root Cause Analysis)

### 2.1 PackBits 解码过严 (最初问题)

- **根因**: `packbits_decode` 严格校验解压后大小，而 ABR 文件中的 RLE 数据常含 Padding 导致校验失败。
- **修复**: 放宽校验，允许数据略大于预期。

### 2.2 Pattern 2MB 大小限制 (导致 Brush 65 关联失败)

- **根因**: `src-tauri/src/abr/patt.rs` 中硬编码了 `40..=2_000_000` 的严格大小检查。
- **影响**: Brush 65 引用的 Pattern 大小约为 19MB，被作为"非法数据"直接丢弃/跳过。导致 Pattern 列表里根本没有这个 ID， naturally 无法关联。
- **修复**: 将大小上限提升至 **50MB**。

### 2.3 数据流中途截断 (导致 UI 拿不到 ID)

- **根因**:
  1.  `commands.rs` 中的 `build_preset_with_id` 函数显式将 `texture_settings` 字段设为 `None`。
  2.  后端 struct 中 `pattern_uuid` 被标记为 `#[serde(skip)]` 且未回填给前端可见的 `pattern_id`。
- **影响**: 即使解析成功，前端收到的 JSON 中 `patternId` 也是空的。
- **修复**:
  1.  在 `commands.rs` 中正确传递 `texture_settings`。
  2.  在 `parser.rs` 中将 UUID 同时赋值给 `pattern_id`。

### 2.4 Pattern 未持久化缓存 (导致 404)

- **根因**: `commands.rs` 在解析 Pattern 元数据后，**忘记调用** `cache_pattern_rgba` 将图片数据写入磁盘/内存缓存。
- **影响**: 前端请求图片 URL 时，后端 Cache 中查无此图，返回 404。
- **修复**: 在 `import_abr_file` 循环中增加 `cache_pattern_rgba` 调用。

### 2.5 前端无法渲染 LZ4 (导致图片裂开)

- **根因**:
  1.  **URL Scheme**: Tauri v2 在 Windows 上不支持 `project://` 自定义协议，必须使用 `http://project.localhost/`。
  2.  **编码格式**: 后端为优化性能返回的是 `image/x-rgba-lz4` (专有格式)，而前端使用标准 `<img>` 标签尝试渲染，浏览器无法识别 LZ4 数据。
- **修复**:
  1.  修正 URL 拼接逻辑为 `http://project.localhost/...`。
  2.  实现 `<LZ4Image />` 组件：使用 `fetch` 获取二进制数据 -> `lz4js` 解压 -> Canvas 绘制。

## 3. 解决方案 (Solution)

### 后端 (Rust)

1.  **Relax Limits**: 提升 Pattern 单体大小限制至 50MB。
2.  **Persist Data**: 确保 Pattern 解析后立即存入 Cache。
3.  **Data Flow**: 确保 Brush Preset 生成时携带完整的 Texture Settings。

### 前端 (React/TypeScript)

1.  **URL Fix**: 适配 Windows 协议格式。
2.  **LZ4 Rendering**: 引入 `LZ4Image` 组件处理专有格式渲染。

## 4. 经验总结 (Lessons Learned)

1.  **隐式限制是大坑**: `2MB` 这种硬编码的限制在初期很难被发现，直到遇到真实世界的巨型素材。对于用户导入的内容，限制应尽可能宽容并配合日志警告，而不是静默失败。
2.  **全链路验证的重要性**: 从文件解析(Parser) -> 数据传输(IPC) -> 缓存(Cache) -> 前端协议(Protocol) -> 渲染(Rendering)，每一个环节都可能出问题。排查时应分段验证（Pattern是否存在? ID是否传输? URL是否可访? 格式是否支持?）。
3.  **私有协议/格式的代价**: 使用 LZ4 优化传输确实减少了开销，但也破坏了浏览器的原生支持（`<img src>` 失效）。在决定引入非标格式前，需评估前端解码的复杂度成本。
