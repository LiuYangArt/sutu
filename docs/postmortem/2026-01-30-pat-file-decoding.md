# .pat 文件格式逆向工程与解码

**日期**: 2026-01-30
**问题**: 需要支持 Photoshop .pat 图案文件的解码，以扩充纹理库，但缺乏现成的 Rust 解析库，且与 ABR 格式有所不同。

## 问题背景

目前系统已经通过 `patt.rs` 支持了解析 ABR 文件中的 patterns。为了支持独立的 `.pat` 文件导入，我们需要理解其文件结构。虽然两者都包含图案数据，但容器格式截然不同。

## 逆向工程过程

### 1. 初始 Hex 分析

通过 PowerShell 提取文件的前 256 字节，观察到了 `8BPT` 签名，确认了这是 Photoshop Pattern 文件。

```
00: 38 42 50 54 (8BPT 签名)
04: 00 01       (版本 1?)
06: 00 00 00 0D (数量 13?)
```

这不仅确认了文件类型，也给出了文件头部的基本结构：10 字节的头部（4字节签名 + 2字节版本 + 4字节数量）。

### 2. 模式头部字段推断

尝试直接复用 ABR 的 Pattern 解析逻辑失败后，我们采取了字段推测法。通过定位已知数据（如 ASCII 字符串 "ciel_07.jpg" 和 "UUID"），反推其前面的字段含义。

- **尺寸字段确认**：在 UUID 之前发现了 1 字节长度字段（而非 ABR 中的 4 字节 Pascal String 长度）。
- **名称字段确认**：在名称字符串前是 4 字节的 UTF-16 字符计数。
- **图像元数据**：在名称长度前，发现了 4 字节的 Version，4 字节的 Mode，以及 2x2 字节的 Height/Width。

### 3. 数据流同步与 VMA 定位

通过编写 `decode_pat_file.rs` 脚本，我们发现 .pat 文件中的 Pattern 数据并不紧凑。Pattern Header 和实际图像数据（VMA结构）之间存在未知的填充数据。

为了解决这个问题，我们实施了**启发式扫描算法**：

1. 读取 Pattern Header 后的 2000 字节。
2. 扫描符合 VMA 特征的数据块：
   - Version ∈ [0, 10]
   - Size ∈ [0, 50MB]
   - Rect 尺寸合理且为正数
   - Depth = 8
   - Compression ∈ [0, 1]
3. 一旦锁定 VMA 头部，即可利用 Offset 准确定位。

### 4. 通道解码策略

与 ABR 类似，每个 Pattern 包含多个通道（RGB 为 3，Gray 为 1）。VMA header 中的 `size` 字段精确指示了下一个通道的偏移量，这使得我们可以链式读取所有通道而无需猜测。

## 最终确定的 .pat 格式规范

### 文件头 (File Header)

| 偏移 | 长度 | 说明                  |
| ---- | ---- | --------------------- |
| 0    | 4    | 签名 `8BPT`           |
| 4    | 2    | 版本 (通常为 1)       |
| 6    | 4    | 图案数量 (Big Endian) |

### 图案块 (Pattern Block)

每个图案包含 **Header** 和 **Image Data**。

#### Pattern Header

| 顺序 | 长度 | 说明                                  |
| ---- | ---- | ------------------------------------- |
| 1    | 4    | Pattern Version (通常为 1)            |
| 2    | 4    | Color Mode (1=Gray, 2=Indexed, 3=RGB) |
| 3    | 2    | Height (Pixels)                       |
| 4    | 2    | Width (Pixels)                        |
| 5    | 4    | Name Length (count of UTF-16 chars)   |
| 6    | N\*2 | Name (UTF-16BE String)                |
| 7    | 1    | ID Length (u8)                        |
| 8    | M    | ID (ASCII String, usually UUID)       |

#### Image Data

紧随 Header 之后，可能存在填充数据。实际图像数据封装在 **VMA (Virtual Memory Array)** 结构中。

- **Color Modes**:
  - RGB (Mode 3): 3 个连续的 VMA Channels
  - Grayscale (Mode 1): 1 个 VMA Channel
  - Indexed (Mode 2): 包含 768 字节颜色表 (未在本次脚本完全实现，但在 VMA 扫描中被跳过)

## 成果

编写并验证了 `src-tauri/examples/decode_pat_file.rs`，成功从测试文件 `test_patterns.pat` 中解码了全部 13 个图案，包括 RGB 和 Grayscale 模式，生成了正确的 PNG 预览图。

## 下一步计划

1. 将 `decode_pat_file.rs` 的逻辑封装到 `src/abr/pat.rs` 模块中。
2. 在 `lib.rs` 或 `commands.rs` 中添加 `.pat` 文件的导入接口。
3. 确保前端 Pattern Manager 能处理这些新导入的图案。
