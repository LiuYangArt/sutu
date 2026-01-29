# Postmortem: ABR 笔刷图案关联失效问题的根因分析与修复

**日期**: 2026-01-29
**状态**: 已诊断，等待实施
**文件**: `docs/postmortem/2026-01-29-pattern-association-failure.md`

## 1. 问题定义 (Problem Definition)

**症状**: 导入 ABR 笔刷（如 `liuyang_paintbrushes.abr`）时，虽然正确加载了笔刷形状和 Pattern 资源，但笔刷的纹理设置丢失（UI 显示 "Texture: None"）。

**影响**: 笔刷系统的核心“纹理”功能不可用，无法还原 Photoshop 笔刷的质感。

## 2. 调查过程 (Investigation)

### 初步假设与推翻

最初推测 Pattern 资源的 ID 格式不匹配（如 parse 出来的 ID 为空字符串），导致笔刷无法通过 ID 引用 Pattern。
然而，通过编写测试脚本 `src-tauri/examples/test_pattern_association.rs` 解析发现：

1. **Pattern ID 完好**：解析出的 10 个 Pattern 均拥有有效的 Pascal String ID（如 `b7334...`）。
2. **内嵌 Descriptor 无效**：尝试从 `samp` section 的笔刷数据块中提取内嵌描述符，结果未能提取到任何有效的 Txtr 信息。

### 关键发现 (Breakthrough)

通过深度分析 ABR 文件结构（`src-tauri/examples/find_txtr_ids.rs`）：

1. **全局 desc section 包含真相**：在全局 `desc` (8BIM section) 中发现了 14 个 `Txtr` 描述符对象。
2. **UUID 完美匹配**：
   - Txtr #10 的 `Idnt` (UUID) 为 `b7334da0-122f-11d4-8bb5-e27e45023b5f`。
   - 这与 Pattern `Bubbles` 的 ID 完全一致。
3. **结构错位**：当前的 `AbrParser` 是基于旧有的假设编写的，即“每个笔刷的设置存储在其 samp 数据块尾部的内嵌描述符中”。实际上，Photoshop (v6+) 经常将完整的笔刷预设列表存储在全局 `desc` section 中，而 samp section 仅存储图像数据。

## 3. 根因 (Root Cause)

**架构性缺失**：解析器缺乏对全局 `desc` section 的解析能力。

- **现状**：`AbrParser` 按顺序扫描 `samp` section，试图从每个笔刷图像数据后读取描述符。对于许多 ABR 文件，这里并没有包含完整的 Texturing 信息。
- **真相**：ABR 文件（特别是 Tool Presets）使用分离式存储——图像在 `samp`，元数据在 `desc`。两者通过顺序索引对应（Brsh 列表的第 N 项对应 samp 中的第 N 个图像）。

## 4. 解决方案 (Solution)

采用 **"二次解析" (Two-Pass Parsing)** 策略：

1. **Pass 1 (现有)**：保留现有的 `samp` section 解析，提取所有的 `AbrBrush` 对象（包含 tip_image, diameter 等基础属性）。
2. **Pass 2 (新增)**：
   - 定位并解析全局 `desc` section。
   - 提取 `Brsh` 列表。
   - 遍历列表，提取其中的 `Txtr` 设置（包含 Scale, Depth, **Pattern UUID** 等）。
   - 按索引将 Txtr 设置注入到 Pass 1 生成的 `AbrBrush` 对象中。
3. **关联 (Linking)**：
   - 利用提取到的 Pattern UUID，在 `patt` section 解析出的 Pattern 列表中查找匹配项。
   - 将匹配到的 Pattern ID (internal id) 赋值给笔刷配置。

## 5. 经验教训 (Lessons Learned)

- **不要盲信文档或局部样本**：之前的解析器可能参考了特定版本的 ABR 或开源实现（如 Krita 旧代码），但在面对更复杂的 Photoshop ABR 变体时失效。
- **数据取证优先**：在猜测代码逻辑之前，先写脚本 dump 原始二进制结构（Hex Dump + 结构化解析）是最高效的排错手段。如果早点分析 desc section，能节省大量猜测时间。
- **全貌观**：文件格式解析不能只盯着局部数据块 (chunk)，要关注所有顶层结构 (sections) 的交互。

## 6. 后续行动 (Action Items)

- [ ] 修改 `src-tauri/src/abr/parser.rs`，实现 `apply_global_texture_settings`。
- [ ] 确保 `Txtr` 解析逻辑能正确处理 `Idnt` (UUID) 字段。
- [ ] 验证修复后的笔刷是否能正确显示纹理名称和效果。
