# Pattern 解码失败：提取成功但解码策略错误

**日期**: 2026-01-29
**状态**: 调查中
**影响**: ABR 导入的 Pattern 纹理显示为花纹/乱码

## 问题现象

用户导入 ABR 笔刷后，Texture 面板中的 Pattern 预览显示为绿色噪点或横条花纹，而非正确的纹理图案。

## 根因分析

### 初始假设（错误）

最初怀疑是 Pattern 提取遗漏 - 因为解析出的 Pattern 名称（Bubbles, Gravel）与 PS 显示的（Pattern 1, metal2）不一致。

### 实际根因

通过 `scan_abr_structure.rs` 扫描脚本发现：

1. **Pattern 已被正确提取** - 共 12 个 Pattern，包括 `Pattern 1`、`metal2` 等
2. **问题出在解码阶段** - 尤其是 Grayscale 模式的 Pattern

### 关键发现

| Pattern   | 尺寸      | 模式      | 解码状态                |
| --------- | --------- | --------- | ----------------------- |
| Pattern 1 | 1996x1804 | Grayscale | ❌ 失败                 |
| metal2    | 616x616   | Grayscale | ❌ 失败                 |
| Pattern 8 | 256x256   | RGB       | ⚠️ 部分成功             |
| Bubbles   | 80x80     | RGB       | ✅ raw_interleaved 成功 |

### 技术细节

1. **RGB 模式**：部分 Pattern 以 `raw_interleaved`（未压缩交错格式）存储，解码成功
2. **Grayscale 模式**：解码逻辑未正确处理，可能存在：
   - PackBits 压缩但解码参数错误
   - 或者数据格式与预期不符
3. **命名混淆**：Pattern 名称末尾有 NUL 字符（`\u0000`），导致字符串比较时可能失败

### 遗漏的 Pattern

扫描发现 1 个 Pattern 确实遗漏：

- ID: `a62e2199-b0dc-11d9-abbc-80161526f2e4`
- 被 `viagnuage4` 笔刷引用

## 修复方向

1. **Grayscale 解码** - 检查 `commands.rs` 中 Grayscale 模式的处理逻辑
2. **NUL 字符** - 清理 Pattern 名称中的 NUL 字符
3. **遗漏 Pattern** - 调查为何有 1 个 Pattern 未被提取

## 经验教训

1. **分层诊断**：问题可能在提取、解码、转换、渲染任一环节，需要逐层排查
2. **可视化调试**：导出中间结果为图片是定位图像处理问题的有效方法
3. **扫描验证**：原始文件扫描可以快速确认数据是否存在，避免在错误方向上浪费时间
