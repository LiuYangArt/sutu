# ABR Pattern 解码问题修复

**日期**: 2026-01-29
**问题**: ABR patterns 无法正确解码，图像损坏或解码失败

## 问题表现

1. 部分 patterns 解码后图像损坏（水平条纹、颜色错位）
2. 部分 patterns 完全无法找到 VMA header
3. 运行时 panic: "attempt to subtract with overflow"

## 根本原因

### 1. 对 VMA 结构的错误理解

**错误假设**：pattern.data 直接包含 RLE 压缩的像素数据

**实际结构**：

```
pattern.data:
├── [0-24]: 头部信息 (mode, size 等)
├── [25-55]: Channel 0 VMA Header (31 bytes)
│   ├── version (4 bytes)
│   ├── size (4 bytes)
│   ├── dummy (4 bytes)
│   ├── rect: top, left, bottom, right (4x4 bytes)
│   ├── depth (2 bytes)
│   └── compression (1 byte)
├── Channel 0 Data
├── Channel 1 VMA Header (for RGB)
├── Channel 1 Data
├── Channel 2 VMA Header (for RGB)
└── Channel 2 Data
```

### 2. Width/Height 交换问题

某些 patterns 的 VMA rect 存储的是 `(0, 0, height, width)` 而不是 `(0, 0, width, height)`。

**解决方案**：匹配时允许 width/height 交换：

```rust
let dims_match = (vma_h == pattern_h && vma_w == pattern_w)
              || (vma_h == pattern_w && vma_w == pattern_h);
```

### 3. i32 减法 Overflow

当 VMA header 搜索到无效偏移时，`bottom - top` 可能导致 i32 overflow。

**错误代码**：

```rust
if bottom > top && right > left {
    let vma_height = (bottom - top) as usize;  // PANIC!
}
```

**修复**：

```rust
let Some(h_diff) = bottom.checked_sub(top) else { continue; };
let Some(w_diff) = right.checked_sub(left) else { continue; };
if h_diff <= 0 || w_diff <= 0 { continue; }
let vma_height = h_diff as usize;  // Safe
```

## 解决方案

### 统一的 Pattern 解码算法

```
1. 在 pattern.data 的前 100 字节搜索 VMA header
2. VMA 识别条件:
   - version: 0-10
   - size: > 0, < 10,000,000
   - rect 尺寸匹配 pattern 尺寸（允许交换）
   - depth = 8
   - compression = 0 或 1
3. 使用 checked_sub 防止 overflow
4. 根据 compression 选择解码方式:
   - 0: 直接读取 width * height 字节
   - 1: 读取 row table + PackBits RLE 解码
5. 对 RGB 模式，重复步骤 3-4 解码 3 个通道
6. 下一个通道的 VMA 位于: current_offset + 8 + size
```

### 压缩类型判断

- `compression = 0`: Uncompressed (直接像素数据)
- `compression = 1`: RLE (PackBits) with row table

无需事先判断，直接从 VMA header 的 compression 字段读取。

## 验证结果

| Pattern             | 尺寸      | 模式 | 压缩 | 结果 |
| ------------------- | --------- | ---- | ---- | ---- |
| Bubbles             | 80x80     | RGB  | 0    | ✓    |
| Gravel              | 200x200   | RGB  | 0    | ✓    |
| Black Marble        | 200x200   | RGB  | 0    | ✓    |
| rough charlk        | 200x200   | RGB  | 0    | ✓    |
| Sparse Basic Noise  | 200x200   | Gray | 1    | ✓    |
| CS2_Background8.jpg | 1024x1024 | RGB  | 0    | ✓    |
| Pattern 1           | 1996x1804 | Gray | 0    | ✓    |
| Pattern 8           | 256x256   | RGB  | 0    | ✓    |
| sparthtex01         | 900x1200  | Gray | 0    | ✓    |
| ciel_07.jpg         | 1536x2048 | RGB  | 1    | ✓    |
| metal2              | 616x616   | Gray | 0    | ✓    |
| SI080_L.jpg         | 480x640   | RGB  | 0    | ✓    |
| 2                   | 400x400   | RGB  | 1    | ✓    |

**全部 13 个 patterns 成功解码。**

## 经验教训

1. **先理解数据结构再写代码**：直接 hex dump 分析比猜测格式更有效
2. **使用 checked_sub**：处理外部数据时，永远使用安全的算术运算
3. **允许变体**：文件格式通常有多种有效变体（如 width/height 交换）
4. **单一算法优于多分支**：一个健壮的通用算法比多个特殊情况处理更可维护

## 待办事项

- [x] 将 `correct_decode.rs` 的算法集成到 `src/abr/patt.rs`
- [x] 添加单元测试验证 13 个 patterns
- [x] 清理调试用的 example 脚本（26 个 → 13 个）
