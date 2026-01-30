# ABR 笔刷参数导入位置错误

**日期**: 2026-01-30
**严重程度**: Medium
**影响范围**: ABR 笔刷导入功能

## 问题描述

导入 ABR 文件后：

1. Texture Tab 参数（Scale, Brightness, Contrast, Depth, Mode）显示默认值，未正确导入
2. Brush Tip Shape 参数（Spacing, Angle, Roundness, Hardness）未从描述符读取
3. 所有笔刷的 Texture toggle 都被启用，即使 Photoshop 中未启用

## 根因分析

### 问题 1 & 2：参数存储位置假设错误

**错误假设**：Texture 参数存储在 `Txtr` 子对象内部

```
brush_desc
└── Txtr
    ├── Scl  (Scale)      ← 假设在这里
    ├── Brgh (Brightness) ← 假设在这里
    └── Dpth (Depth)      ← 假设在这里
```

**实际结构**：Texture 参数在**根描述符**顶级键，`Txtr` 仅包含 pattern 引用

```
brush_desc
├── textureScale       ← 实际在这里
├── textureBrightness  ← 实际在这里
├── textureDepth       ← 实际在这里
├── textureBlendMode   ← 实际在这里
├── InvT (invert)      ← 实际在这里
├── useTexture         ← 控制是否启用
├── Txtr
│   ├── Nm   (Pattern Name)
│   └── Idnt (Pattern UUID)
└── Brsh
    ├── Spcn (Spacing)
    ├── Angl (Angle)
    ├── Rndn (Roundness)
    └── Hrdn (Hardness)
```

### 问题 3：前端逻辑混淆

`BrushPresets.tsx` 中：

```typescript
// 错误：hasTexture 表示"有笔尖图像"，不是"启用 Texture Tab"
const shouldEnableTexture = preset.hasTexture;
```

## 修复方案

### 后端修改 (`parser.rs`)

1. 新增 `apply_texture_params_from_root()` 从根描述符读取 texture 参数
2. 新增 `apply_brush_tip_params()` 从 `Brsh` 子对象读取笔刷形状参数
3. 检查 `useTexture` 布尔字段决定是否启用 texture

### 前端修改 (`BrushPresets.tsx`)

```typescript
// 修复：根据 textureSettings.enabled 判断
const shouldEnableTexture = preset.textureSettings?.enabled === true;
```

## 验证结果

以 'front - main+sparthcharc' 笔刷为例：

| 参数           | 修复前 | 修复后 |
| -------------- | ------ | ------ |
| Spacing        | 25%    | 15%    |
| Roundness      | 100%   | 76%    |
| Hardness       | None   | 94%    |
| Texture Scale  | 100%   | 51%    |
| Texture Depth  | 100%   | 10%    |
| Texture Invert | false  | true   |

Oil Pastel 4 笔刷（PS 中无 Texture）：修复后 Texture toggle 正确关闭。

## 经验教训

1. **不要假设文件格式结构**：应先用调试脚本分析实际数据结构，再编写解析代码
2. **区分相似概念**：`hasTexture`（笔尖图像）vs `textureSettings.enabled`（Texture Tab 启用）是不同的概念
3. **调试脚本是必要的**：`analyze_brush_params.rs` 帮助快速定位参数存储位置问题

## 相关文件

- `src-tauri/src/abr/parser.rs` - 后端解析逻辑
- `src/components/BrushPanel/settings/BrushPresets.tsx` - 前端笔刷应用逻辑
