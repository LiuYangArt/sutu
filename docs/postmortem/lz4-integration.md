# Postmortem: LZ4 压缩集成 (Rust ↔ JavaScript)

**日期**: 2026-01-23
**问题**: PSD 文件加载时 LZ4 压缩数据无法正确解压，图层显示为空白

## 背景

为减少 PSD 文件加载时的内存占用和传输量，我们在后端使用 `lz4_flex` crate 对 RGBA 数据进行 LZ4 压缩，前端使用 `lz4js` 库解压。

## 问题 1: lz4js API 不兼容 lz4_flex 格式

### 症状
```
Uncaught Error: Malformed LZ4 Data: signature mismatch
```

### 根因
- `lz4_flex::compress_prepend_size` 产生的是 **Raw Block + 4字节 size header** 格式
- `lz4js.decompress()` 期望的是 **LZ4 Frame 格式**（带有 magic number 0x184D2204）
- 两种格式完全不兼容

### 解决方案
使用 `lz4js.decompressBlock()` 低级 API，手动解析 size header：

```typescript
// 错误 ❌
lz4.decompress(compressed);

// 正确 ✅
const uncompressedSize =
  compressed[0]! |
  (compressed[1]! << 8) |
  (compressed[2]! << 16) |
  (compressed[3]! << 24);
const decompressed = new Uint8Array(uncompressedSize);
lz4.decompressBlock(compressed, decompressed, 4, compressed.length - 4, 0);
```

## 问题 2: decompressBlock 参数顺序错误

### 症状
解压成功但图层内容全部透明

### 根因
`decompressBlock` 的参数签名与预期不同：

```javascript
// 实际签名
decompressBlock(src, dst, sIndex, sLength, dIndex)

// 错误调用 ❌ - 把 blockData.length 当成了 endIdx
lz4.decompressBlock(blockData, decompressed, 0, blockData.length);

// 正确调用 ✅
lz4.decompressBlock(compressed, decompressed, 4, compressed.length - 4, 0);
```

参数说明：
- `sIndex` = 源数据起始索引（跳过 4 字节 header = 4）
- `sLength` = 压缩数据长度（不是结束索引！）
- `dIndex` = 目标起始索引

## 问题 3: ORA 加载变空白

### 症状
修复 PSD 后，ORA 文件加载变成空白

### 根因
`response.arrayBuffer()` 会消费整个响应体。后续对 PNG/WebP 调用 `response.blob()` 返回空 blob。

```typescript
// 问题代码
const buffer = await response.arrayBuffer(); // 消费响应体
// ...
const blob = await response.blob(); // 返回空 blob！

// 修复
const blob = new Blob([buffer], { type: contentType }); // 从已获取的 buffer 创建
```

## 经验教训

1. **第三方库 API 兼容性**：不同语言/平台的 LZ4 实现可能使用不同的封装格式（Frame vs Block）。集成前需要仔细阅读两边的文档。

2. **低级 API 参数**：使用低级 API 时，参数的含义可能与高级 API 不同。`sLength` vs `endIdx` 容易混淆。

3. **Response 只能消费一次**：`fetch` 的 Response body 只能读取一次（`arrayBuffer()` 或 `blob()`）。如果需要两种格式，从已获取的数据创建。

4. **测试多种文件格式**：修改文件加载逻辑后，需要测试所有支持的格式（ORA、PSD 等）。

## 最终实现

### 后端 (Rust)
```rust
use lz4_flex::compress_prepend_size;

let compressed = compress_prepend_size(&rgba_data);
// 格式: [4字节 LE size][LZ4 block data]
```

### 前端 (TypeScript)
```typescript
// src/utils/lz4.ts
export function decompressLz4PrependSize(compressed: Uint8Array): Uint8Array {
  const uncompressedSize =
    compressed[0]! |
    (compressed[1]! << 8) |
    (compressed[2]! << 16) |
    (compressed[3]! << 24);

  const decompressed = new Uint8Array(uncompressedSize);
  lz4.decompressBlock(compressed, decompressed, 4, compressed.length - 4, 0);
  return decompressed;
}
```

## 相关文件

- `src-tauri/src/file/layer_cache.rs` - LZ4 压缩
- `src/utils/lz4.ts` - LZ4 解压工具函数
- `src/components/Canvas/index.tsx` - 图层加载逻辑
- `src/types/lz4js.d.ts` - lz4js 类型声明
