# Postmortem: TIFF 多图层支持

**日期**: 2025-01-22
**状态**: 已放弃
**相关 Issue**: #4287-layer

## 问题描述

尝试实现 TIFF 格式的多图层保存和读取功能，以便与 Photoshop、Krita 等软件交换带图层的文件。

## 实现方案

采用 "Payload Carrier" 策略：
- **Page 0 (IFD 0)**: 合并后的完整图像，普通看图软件可预览
- **ImageDescription Tag (270)**: JSON 元数据存储图层结构
- **Page 1..N**: 各图层的 RGBA 数据

## 发现的问题

### 1. TIFF 多图层没有行业标准

TIFF 本身支持多页（Multi-page），但**不支持"图层"概念**。不同软件对"图层"的实现完全不同：

| 软件 | 实现方式 |
|------|----------|
| Photoshop | 私有 PSD 数据嵌入 (Tag 37724) |
| Krita | 识别 Photoshop 的 PSD 嵌入格式 |
| GIMP | 不支持 TIFF 图层 |
| 我们的方案 | 多页 TIFF + JSON 元数据 |

### 2. Photoshop 的私有格式

Photoshop 使用 **Tag 37724** 存储私有的 PSD 数据，这是一个：
- 古老且**文档匮乏**的格式
- 只有 Photoshop 和少数软件（Krita libtiff 4.2+）能正确解析
- 第三方工具很难生成完全兼容的文件

### 3. 测试结果

用我们的方案保存的 TIFF 文件：
- **PaintBoard**: 能正确读取（自己写的格式）
- **Krita**: 显示多页但当作独立图层，Page 0 显示为黑色图层
- **Photoshop**: 完全不识别图层，只显示 Page 0

用 Photoshop 保存的带图层 TIFF：
- **Photoshop**: 正常显示图层
- **Krita**: 正常显示图层，提示 "TIFF 包含 PSD 数据"
- **我们的方案**: 无法解析 Photoshop 的私有格式

## 决策

**放弃 TIFF 多图层支持**，原因：
1. 没有通用标准，无法实现跨软件兼容
2. 实现 Photoshop 私有格式成本过高且无官方文档
3. ORA (OpenRaster) 是更好的开放标准替代方案

## 最终方案

- **ORA** 作为主要项目格式（已实现，Krita 原生支持）
- **TIFF** 降级为纯导出格式（单层合并图像，用于分享/打印）
- 代码保留在 `src-tauri/src/file/tiff.rs` 供将来参考

## 经验教训

1. **调研先行**：在实现复杂文件格式前，应先调研行业标准和竞品实现
2. **开放标准优先**：优先选择有明确规范的开放格式（如 ORA），而非私有格式
3. **兼容性测试**：文件格式必须在目标软件中实际测试，不能只依赖文档

## 参考资料

- [TIFF 6.0 Specification](https://www.itu.int/itudoc/itu-t/com16/tiff-fx/docs/tiff6.pdf)
- [OpenRaster Specification](https://www.openraster.org/)
- [Krita TIFF Layer Support](https://docs.krita.org/en/general_concepts/file_formats/file_tiff.html)
