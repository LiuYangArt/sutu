# ABR 笔刷纹理切换失效修复

**日期**: 2026-01-20
**严重程度**: 功能缺陷
**影响范围**: ABR 导入的纹理笔刷切换

## 问题现象

1. 导入 ABR 文件后，切换不同纹理笔刷时，画布始终使用第一个选中的纹理
2. 重新导入新的 ABR 文件也不刷新纹理
3. CPU 渲染路径修复后正常，但 GPU Compute Shader 路径仍有问题

## 根因分析

### 问题一：纹理 ID 生成策略错误

**位置**: `TextureAtlas.ts` 和 `textureMaskCache.ts`

**错误代码**:
```typescript
function getTextureId(texture: BrushTexture): string {
  return texture.data.substring(0, 100);  // 用 base64 前 100 字符作为 ID
}
```

**问题**: PNG 文件的 base64 编码前 100 字符主要是文件头和元数据（如 `iVBORw0KGgoAAAANSUhEUgAA...`），同尺寸的 PNG 图片这部分内容**完全相同**，导致不同纹理被误判为同一纹理。

**数据流断裂**:
```
BrushPreset.id ✅ → applyPreset() → BrushTexture ❌ (缺少 id)
                                          ↓
                              TextureAtlas 用 base64 前缀做 ID
                                          ↓
                              缓存误命中 → 返回旧纹理
```

### 问题二：GPU BindGroup 缓存 key 冲突

**位置**: `ComputeTextureBrushPipeline.ts`

**错误代码**:
```typescript
private getOrCreateBindGroup(..., brushTexture: GPUBrushTexture): GPUBindGroup {
  const brushLabel = brushTexture.texture.label || 'brush';
  const key = `${inputTexture.label}_${outputTexture.label}_${brushLabel}`;
  // key 始终 = "source_dest_Brush Texture" → 缓存命中旧 BindGroup
}
```

**问题**: `TextureAtlas.uploadTexture()` 中所有纹理的 GPU label 都硬编码为 `'Brush Texture'`，导致 BindGroup 缓存 key 相同，切换笔刷时返回绑定旧纹理的 BindGroup。

## 修复方案

### 修复一：BrushTexture 添加唯一 ID

在 `BrushTexture` 接口添加 `id` 字段，从 `BrushPreset.id` 传递：

```typescript
// src/stores/tool.ts
export interface BrushTexture {
  id: string;  // 新增：唯一标识符
  data: string;
  width: number;
  height: number;
  // ...
}

// src/components/BrushPanel/settings/BrushPresets.tsx
const texture: BrushTexture = {
  id: preset.id,  // 从 preset 传递
  data: preset.textureData,
  // ...
};
```

### 修复二：缓存系统使用 texture.id

```typescript
// TextureAtlas.ts / textureMaskCache.ts
async setTexture(texture: BrushTexture): Promise<boolean> {
  const textureId = texture.id;  // 使用唯一 ID
  // ...
}
```

### 修复三：GPU 纹理使用唯一 label

```typescript
// TextureAtlas.ts
private uploadTexture(..., textureId: string): GPUBrushTexture {
  const texture = this.device.createTexture({
    label: `Brush Texture ${textureId}`,  // 唯一 label
    // ...
  });
}
```

## 代码简化

修复后进行了代码简化：

1. **抽取公共解码函数**: 将 `decodeBase64ToImageData` 移至 `src/utils/imageUtils.ts`
2. **删除重复代码**: 从 `TextureAtlas.ts` 和 `textureMaskCache.ts` 移除约 105 行重复代码

## 经验教训

### 1. ID 生成策略要可靠

**错误**: 用内容特征（base64 前缀）作为 ID
**正确**: 在数据创建时生成唯一 ID，全程传递

> 如果对象已有唯一标识（如 `BrushPreset.id`），应直接复用而非重新计算。

### 2. GPU 资源的缓存 key 要唯一

WebGPU 的 BindGroup 创建开销大，缓存是正确的优化。但缓存 key 必须包含所有影响渲染结果的因素：
- 输入纹理
- 输出纹理
- **笔刷纹理**（本次遗漏）

### 3. 分层测试的重要性

问题分两阶段暴露：
1. CPU 路径：纹理 ID 问题
2. GPU 路径：BindGroup 缓存问题

修复第一个问题后应同时测试 CPU 和 GPU 路径，避免回归。

## 影响文件

| 文件 | 改动类型 |
|------|----------|
| `src/stores/tool.ts` | 修改 - BrushTexture 添加 id |
| `src/components/BrushPanel/settings/BrushPresets.tsx` | 修改 - 传递 preset.id |
| `src/gpu/resources/TextureAtlas.ts` | 修改 - 使用 texture.id，唯一 label |
| `src/gpu/types.ts` | 修改 - GPUDabParams.texture 使用 BrushTexture 类型 |
| `src/utils/textureMaskCache.ts` | 修改 - 使用 texture.id |
| `src/utils/imageUtils.ts` | 新增 - 公共解码函数 |

## 验证清单

- [x] 导入 ABR 后切换不同纹理笔刷，纹理正确切换
- [x] 重新导入新 ABR，纹理刷新
- [x] 切换回默认圆形笔刷，纹理正确清除
- [x] CPU 渲染路径正常
- [x] GPU Compute Shader 路径正常
- [x] 类型检查通过
