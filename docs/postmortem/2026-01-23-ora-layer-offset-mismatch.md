# ORA/PSD 图层位置偏移 - 前后端字段命名不一致

## 日期
2026-01-23

## 问题描述

从 Krita 创建的 ORA 文件在 PaintBoard 中打开时，较小的图层位置有偏移。绿色图层本应在画布右下角，却显示在左上角 (0, 0) 位置。

### 症状
- 图层内容被绘制在错误的位置
- 较小的图层（有非零偏移）受影响最明显
- 全画布大小的图层不受影响（因为 offset = 0）

### 触发条件
- 打开 Krita 创建的 ORA 文件
- 该文件包含尺寸小于画布的图层（被裁剪的图层）

### 影响
- ORA 文件图层位置错误
- PSD 文件同样受影响（使用相同的 offset 机制）

## 根因分析

### 数据流追踪

```
后端 Rust 结构体        →   JSON 序列化          →   前端 TypeScript
offset_x, offset_y    →   offsetX, offsetY    →   期望 offset_x, offset_y
(snake_case)              (camelCase ✅)           (snake_case ❌)
```

### 关键代码

**后端 (正确)**
```rust
// src-tauri/src/file/types.rs
#[serde(rename = "offsetX", default)]
pub offset_x: i32,
#[serde(rename = "offsetY", default)]
pub offset_y: i32,
```

**前端 (错误)**
```typescript
// src/components/Canvas/index.tsx (修复前)
layersData: Array<{ id: string; imageData?: string; offset_x?: number; offset_y?: number }>
//                                                   ^^^^^^^^ snake_case

const offsetX = layerData.offset_x ?? 0;  // undefined ?? 0 = 0
const offsetY = layerData.offset_y ?? 0;  // undefined ?? 0 = 0
```

### 问题本质

| 组件 | 字段名 | 实际值 |
|------|--------|--------|
| 后端 JSON | `offsetX` | `100` |
| 前端访问 | `layerData.offset_x` | `undefined` |
| 回退值 | `?? 0` | `0` |

由于字段名不匹配，`layerData.offset_x` 始终为 `undefined`，导致所有图层都被绘制在 (0, 0) 位置。

## 修复方案

### 修改文件
`src/components/Canvas/index.tsx`

### 修改内容

```typescript
// Before (L388)
layersData: Array<{ id: string; imageData?: string; offset_x?: number; offset_y?: number }>

// After
layersData: Array<{ id: string; imageData?: string; offsetX?: number; offsetY?: number }>

// Before (L405-406)
const offsetX = layerData.offset_x ?? 0;
const offsetY = layerData.offset_y ?? 0;

// After
const offsetX = layerData.offsetX ?? 0;
const offsetY = layerData.offsetY ?? 0;
```

## 经验教训

### 1. 前后端字段命名必须统一
- Rust 使用 snake_case，但 serde 可以重命名为 camelCase
- TypeScript 接收端必须使用与 JSON 一致的命名
- 建议：在项目中明确约定 IPC 边界使用 camelCase

### 2. 可选字段的回退值可能掩盖问题
- `layerData.offset_x ?? 0` 看起来安全，实际上隐藏了字段缺失的问题
- 更好的做法：在开发阶段添加警告日志
  ```typescript
  if (layerData.offsetX === undefined) {
    console.warn(`Layer ${layerData.id} missing offsetX`);
  }
  ```

### 3. 调试策略
- 从数据源开始追踪（后端 → IPC → 前端）
- 在每个边界点打印实际数据结构
- 注意 JSON 序列化时的字段名转换

### 4. PSD 和 ORA 共享 offset 机制
- `psd/reader.rs` 中的 `build_layer_image` 函数使用相同的优化策略
- 只存储图层实际内容区域，用 offset 记录位置
- 修复一处，两种格式都受益

## 验证步骤

1. 在 Krita 中创建包含多个小图层（位于不同位置）的 ORA 文件
2. 在 PaintBoard 中打开该文件
3. 确认所有图层位置与 Krita 中一致
4. 测试 PSD 文件（同样包含偏移图层）

## 相关文件

- `src/components/Canvas/index.tsx` - 前端图层加载 (修复位置)
- `src-tauri/src/file/types.rs` - 后端数据结构定义
- `src-tauri/src/file/ora.rs` - ORA 文件解析
- `src-tauri/src/file/psd/reader.rs` - PSD 文件解析
- `src/stores/file.ts` - 文件操作 store

## 预防措施

1. **类型共享**：考虑从 Rust 自动生成 TypeScript 类型定义
2. **端到端测试**：添加 ORA/PSD 文件加载测试，验证图层位置
3. **开发时校验**：在 DEBUG 模式下检查关键字段是否存在
