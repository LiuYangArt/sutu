# Postmortem: ABR Grayscale Pattern 解码问题分析

**日期**: 2026-01-29
**标签**: #ABR #ReverseEngineering #BinaryParsing #Rust

## 1. 问题现象

在导入 ABR 画笔文件时， Pattern texture 显示异常。具体表现为：

- 渲染出的纹理出现严重的“水平条纹” (Horizontal Streaking) 伪像。
- 或者解码失败，导致纹理丢失。
  这表明 VMA (Virtual Memory Array) Header 解析错误，导致解码器使用了错误的 Width/RowBytes，或者读取了错误的 RowTable。

## 2. 根本原因

Grayscale Pattern 在 ABR 文件中的存储结构与 RGB Pattern（以及 GIMP 源码中处理的标准结构）存在差异。

- **差异点**: 并没有遵循标准的 VMA Header 偏移量。
- **误导性**: 之前尝试的偏移量（如 28 字节 ImageBlock 头）对于此类 Pattern 并不适用。

## 3. 调查与分析过程

### 3.1 初始尝试：偏移量扫描

最初假设 VMA Header 可能仅仅是偏移了几个字节。我们编写了 `debug_liuyang_abr.rs` 脚本，尝试在 offset 0, 2, 4, 8, 28, 59 等位置解析 VMA Header。
**结果**: 所有偏移量解析出的 `bottom` (height) 和 `right` (width) 均不匹配实际 Pattern 尺寸。例如，解析出的数值往往是实际值的 256 倍（左移 8 位），暗示了字段对齐问题或字段长度误判（如 2 字节 vs 4 字节）。

### 3.2 突破口：基于特征值的二进制搜索 (Pattern Search)

由于无法确定 Header 结构，我们采用了“已知明文攻击”的思路。
我们已知 Pattern #4 的尺寸为 200x200 (`00 C8`). 我们编写脚本在二进制流的前 64 字节中暴力搜索 `00 C8`。

**发现**:

- `Height (200)` 出现在 Offset **17** (Bytes 17-18)。
- `Width (200)` 出现在 Offset **21** (Bytes 21-22)。
- 两者间隔 2 字节。

### 3.3 结构推导

基于 Offset 17 的发现，我们映射出了潜在的 Header 结构：

```text
00-16: Unknown Header Prefix (17 bytes)
17-18: Height (u16 BE)
19-20: Padding/Unknown
21-22: Width (u16 BE)
23-24: Padding
25-26: Depth (u16 BE, found value 24)
27-29: Unknown
30   : Compression (u8, found value 1 = RLE)
```

验证：对 Pattern #9 (616x616) 使用相同结构，成功匹配尺寸和 Compression 标志。

### 3.4 多通道迹象

搜索结果还显示，在 Offset **49** (17 + 32) 处再次出现了 Height 值。

- `17` 和 `49` 相差 **32 字节**。
- 这强烈暗示 Grayscale Pattern 实际上是作为 **多通道 (Multi-channel)** 数据存储的，每个通道都有一个 32 字节左右的 Header。
- 如果第一个 Header 是 Alpha 或 Mask 通道，而我们尝试解码它，可能会遇到全黑或全白的数据（解释了为什么 Row Table 看起来无效，可能是因为数据被压缩得非常小，或者是全零）。

## 4. 结论与后续步骤

虽然本次调试中断，但已明确了 Grayscale Pattern 的 parsing path：

1. **不要** 假设单一的 VMA Offset。
2. 应检测 Pattern Mode。如果是 Mode 1 (Grayscale)，应使用 **Offset 17** 策略解析 Header。
3. 如果遇到解码错误，需考虑 **跳过前 32 字节** (或更多)，尝试读取后续通道的数据（可能是实际的灰度图像数据）。

## 5. 经验教训

1. **Data over Document**: 在逆向工程未公开文件格式时，不要死磕文档或参考代码。直接看二进制数据，搜索已知特征值（如宽、高、版本号）往往能最快定位结构。
2. **Visualize Raw Data**: 将 Raw Binary dump 成图片（即之前做的 Offset 0/2 Raw tests）非常有帮助。它让我们直观地看到了“条纹”，确认了 RowBytes 计算错误或 Header 偏移错误。
3. **Rust Debugging**: 编写独立的 `examples` 脚本进行一次性调试非常高效，避免了并在主应用中反复编译带来的时间损耗。
