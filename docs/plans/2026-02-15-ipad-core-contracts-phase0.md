# iPad Core Contracts Phase 0（边界冻结）

**日期**：2026-02-15  
**状态**：Draft v1（用于 Phase 0/1 实施）

## 1. 目标

在不引入 iPad 工程目录的前提下，先冻结跨端共享契约，确保桌面端与后续 iPad 端可围绕统一 DTO 和 API 对齐。

## 2. Core DTO 契约

## 2.1 `BrushPresetCore`

用途：跨端共享笔刷预设元数据，不携带大块纹理二进制。  
字段原则：
1. 保留笔刷基础形态参数：`diameter / spacing / hardness / angle / roundness`。
2. 保留压感行为开关：`sizePressure / opacityPressure`。
3. 保留资源关联最小标识：`id / sourceUuid / hasTexture / textureWidth / textureHeight`。

## 2.2 `PatternResourceCore`

用途：跨端共享纹理资源索引，不耦合具体 UI。  
字段原则：
1. 唯一标识：`id`。
2. 去重依据：`contentHash`。
3. 显示与分组：`name / source / group`。
4. 基本尺寸与模式：`width / height / mode`。

## 2.3 `ProjectDataCore` / `LayerDataCore`

用途：保存/加载链路跨端主合同。  
字段原则：
1. 图像载体 bytes-first：
   - `layerPngBytes`
   - `flattenedPngBytes`
   - `thumbnailPngBytes`
2. 兼容层仅通过 adapter 暴露 legacy：
   - `legacyImageDataBase64`
   - `legacyFlattenedImageBase64`
   - `legacyThumbnailBase64`
3. 图层元数据保持与现有桌面端一致：
   - `id / name / type / visible / locked / opacity / blendMode / offsetX / offsetY`

## 2.4 `DabParamsCore`

用途：后续跨端笔刷中间层参数统一（本轮先冻结字段，不切入渲染实现）。  
字段原则：
1. 几何与力度：`x / y / size / flow / hardness`。
2. 视觉参数：`color / dabOpacity / roundness / angle`。

## 3. 可空规则与单位

1. `opacity / flow / hardness`：范围 `[0, 1]`。  
2. `spacing`：沿用当前桌面定义（百分比语义）。  
3. 图像 bytes 字段：`None` 表示由 `project://` 缓存路径或 legacy 字段提供。  
4. 兼容字段：仅当 bytes 不可用时使用，不作为主数据来源。

## 4. 兼容策略

1. `save_project_v2/load_project_v2` 为新主接口。  
2. 旧 `save_project/load_project` 保留，通过 adapter 转发到同一 core 实现。  
3. 不删除旧命令，待后续稳定期再评估移除。

## 5. 非目标

1. 本文不定义 iPad UI 或交互一致性。  
2. 本文不要求桌面渲染链路改写为 bytes 全量直连。  
3. 本文不包含 iPad 原生输入/Metal 细节。
