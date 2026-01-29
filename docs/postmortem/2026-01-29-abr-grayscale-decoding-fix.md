# ABR Grayscale Pattern 解码修复

**日期**: 2026-01-29
**状态**: 部分解决
**影响范围**: ABR 笔刷文件中 Grayscale (mode=1) 模式 Pattern 的解码

## 问题背景

在导入 ABR 笔刷文件时，Grayscale 模式的 Pattern 无法正确解码，导致：

1. 部分纹理显示为乱码/噪点
2. 部分纹理根本无法解码
3. 某些纹理出现水平条纹（horizontal streaking）

## 测试文件

- **ABR 文件**: `abr/liuyang_paintbrushes.abr`
- **Pattern 总数**: 12 个
- **RGB 模式 (mode=3)**: 8 个
- **Grayscale 模式 (mode=1)**: 4 个

## 当前解码状态

### RGB Patterns (mode=3) - 全部成功 ✓

| #   | Name                | Size      | 解码策略                        | 状态 |
| --- | ------------------- | --------- | ------------------------------- | ---- |
| 0   | Bubbles             | 80×80     | PackBits Cont Offset 2 + Planar | ✓    |
| 1   | Gravel              | 200×200   | PackBits Cont Offset 2 + Planar | ✓    |
| 2   | Black Marble        | 200×200   | PackBits Cont Offset 2 + Planar | ✓    |
| 3   | rough charlk        | 200×200   | PackBits Cont Offset 2 + Planar | ✓    |
| 5   | CS2_Background8.jpg | 1024×1024 | PackBits Cont Offset 2 + Planar | ✓    |
| 7   | Pattern 8           | 256×256   | PackBits Cont Offset 2 + Planar | ✓    |
| 10  | SI080_L.jpg         | 616×602   | PackBits Cont Offset 2 + Planar | ✓    |
| 11  | 2                   | 400×400   | PackBits Cont Offset 2 + Planar | ✓    |

### Grayscale Patterns (mode=1) - 状态不一

| #   | Name               | Size      | 解码策略               | 输出文件                 | 视觉正确性    |
| --- | ------------------ | --------- | ---------------------- | ------------------------ | ------------- |
| 4   | Sparse Basic Noise | 200×200   | PackBits Cont Offset 2 | p4_gray_cont2.png        | ✓ 正确        |
| 6   | Pattern 1          | 1996×1804 | VMA GIMP Offset 2      | p6_gray_offset2.png      | ⚠️ 有水平条纹 |
| 8   | sparthtex01        | 900×1200  | Sequential Planar      | p8_sequential_planar.png | ⚠️ 待验证     |
| 9   | metal2             | 616×616   | VMA GIMP Offset 2      | p9_gray_offset2.png      | ✓ 看起来正确  |

## 发现的数据结构

### 结构 1: 简单 PackBits (Pattern #4)

适用于小尺寸 Grayscale pattern，数据从 offset 2 开始：

```
Offset 0-1: 未知头部 (跳过)
Offset 2+:  RLE/PackBits 压缩数据
```

**解码方式**: `packbits_decode(&data[2..], width * height)`

### 结构 2: VMA (Virtual Memory Array) Header

GIMP 使用的标准 VMA 格式，31 字节头部：

```
Offset 0-3:   chan_version (i32 BE)
Offset 4-7:   size (i32 BE)
Offset 8-11:  dummy (i32 BE)
Offset 12-15: top (i32 BE)
Offset 16-19: left (i32 BE)
Offset 20-23: bottom (i32 BE)
Offset 24-27: right (i32 BE)
Offset 28-29: depth (i16 BE)
Offset 30:    compression (0=raw, 1=RLE)
Offset 31+:   row_table (height * 2 bytes) + RLE data
```

### 结构 3: Postmortem 发现的结构

通过直接分析 Pattern #4 字节发现的结构：

```
First 32 bytes: 00 00 03 00 00 55 DC 00 00 00 00 00 00 00 00 00
                00 00 C8 00 00 00 C8 00 00 00 18 00 00 00 01 00

Offset 17-18: Height (u16 BE) = 0x00C8 = 200
Offset 21-22: Width (u16 BE)  = 0x00C8 = 200
Offset 25-26: Depth (u16 BE)  = 0x0018 = 24 (注意: 不是 8！)
Offset 30:    Compression     = 0x01 = RLE
```

> **重要发现**: 即使 `pattern.mode == 1` (Grayscale)，`depth` 字段可能是 24，暗示数据可能以 RGB 格式存储。

## 尝试过的解码策略

### 1. 标准 GIMP VMA Channel Decode

```rust
fn decode_vma_channel(data, expected_width, expected_height) -> Option<(Vec<u8>, usize)>
```

**问题**: VMA 头部解析得到的 rect 值经常不正确（溢出、负数等）

### 2. 2-byte Rect VMA Decode

尝试用 2 字节而非 4 字节解析 rect 字段。
**结果**: 维度匹配失败

### 3. Postmortem Structure Decode

使用固定偏移 (h@17, w@21, comp@30) 解析。
**结果**: 维度能匹配，但 RLE 解码失败 - row table 位置不对

### 4. Simple PackBits with Offset

```rust
packbits_decode(&data[offset..], width * height)
```

**结果**: Offset 2 对 Pattern #4 成功！

### 5. Sequential Planar Decode

分别解码每个通道，然后按需组合。
**结果**: 对 Pattern #8 成功

## 关键代码修改

### 添加 Grayscale 保存逻辑

```rust
// In continuous offset 2 decode
} else if pattern.mode == 1 && decoded.len() == expected_bytes {
    // Grayscale mode - save as gray image
    let mut img = GrayImage::new(pattern.width, pattern.height);
    for y in 0..pattern.height {
        for x in 0..pattern.width {
            let i = (y * pattern.width + x) as usize;
            if i < decoded.len() {
                img.put_pixel(x, y, Luma([decoded[i]]));
            }
        }
    }
    img.save(&filename)?;
}
```

### 修复溢出问题

```rust
// 添加边界检查防止 subtraction overflow
if bottom >= top && right >= left && bottom >= 0 && right >= 0 && top >= 0 && left >= 0 {
    let h = (bottom - top) as usize;
    let w = (right - left) as usize;
    // ... continue processing
}
```

## 未解决的问题

### 1. Pattern #6 "Pattern 1" 水平条纹

尺寸 1996×1804，解码后出现明显的水平条纹，说明 RLE 解码或数据布局有问题。

**可能原因**:

- Row table 偏移不正确
- RLE 每行长度读取错误
- 多通道数据被当作单通道处理

### 2. depth=24 在 Grayscale 模式下的含义

Pattern #4 虽然 `mode=1` (Grayscale)，但 `depth=24`，这可能意味着：

- 数据实际是 RGB，只是最终使用时转为灰度
- 某种历史兼容性原因
- 我们的结构解析有误

### 3. Row Table 结构不统一

不同 pattern 的 row table 起始位置和格式可能不同：

- 标准 VMA: offset 31
- 其他格式: 需要动态检测

## 经验总结

1. **ABR 格式没有统一标准**: Photoshop 不同版本使用不同的内部结构
2. **Mode 字段不可靠**: `mode=1` 不意味着数据一定是单通道
3. **多策略尝试是必要的**: 需要依次尝试多种解码策略
4. **边界检查很重要**: 二进制解析必须处理 overflow 情况
5. **GIMP 源码是好参考**: 但不能完全依赖，需要结合实际数据分析

## 下一步行动

1. 深入分析 Pattern #6 的数据结构，找出水平条纹的根因
2. 考虑实现多通道灰度解码（将 RGB 转为灰度）
3. 对比 Photoshop 或 GIMP 加载同一 ABR 文件的结果
4. 将成功的解码策略集成到正式的 `commands.rs` 中

## 相关文件

- `src-tauri/examples/debug_liuyang_abr.rs` - 调试脚本
- `src-tauri/src/abr/mod.rs` - ABR 解析器
- `debug_output/` - 解码输出图像目录
