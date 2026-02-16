# Cross-Platform Core Consistency v1

**日期**：2026-02-15  
**适用阶段**：iPad 路线 Phase 0/1  
**目标**：统一“跨端一致性”验收口径，避免实现细节争论。

## 1. 一致性维度

## 1.1 数据一致（必须）

定义：同一输入在桌面与未来 iPad 适配层经过 Core API 后，关键结构字段可对齐。  
检查项：
1. `BrushPresetCore` 数量与关键字段一致（`id/name/diameter/spacing`）。  
2. `PatternResourceCore` 数量、`id/contentHash/width/height` 一致。  
3. `ProjectDataCore` 文档尺寸、图层顺序、图层偏移与可见性一致。  
4. 导入 API path-vs-bytes 一致（同文件路径读取与内存字节读取结果一致）。

## 1.2 视觉一致（阶段性）

定义：相同工程在目标格式 roundtrip 后，核心视觉结果不出现可见退化。  
检查项（当前阶段）：
1. `PSD` roundtrip 后图层数量不丢失。  
2. `ORA` roundtrip 后图层偏移与透明度不异常。  
3. 导入 ABR/PAT 后可完成绘制并导出，且无空白层/错位。

> 注：本阶段不要求逐像素完全一致；要求“可用工作流一致”。

## 2. 最小样例集

1. ABR：`abr/202002.abr`  
2. PAT：`abr/test_patterns.pat`  
3. PSD/ORA：测试内动态构造 1x1 样例并 roundtrip。

## 3. 自动化验收

1. Rust 单测：
   - ABR path-vs-bytes
   - PAT path-vs-bytes
   - PSD roundtrip
   - ORA roundtrip
2. 命令兼容：
   - `save_project` 与 `save_project_v2` 产物都可被 `load_project_v2` 打开
3. 前端单测：
   - `useGlobalExports` 暴露 bytes 导出函数
   - `file` store 优先走 V2，失败回退旧命令

## 4. 手测清单（桌面）

1. 新建多图层文档，绘制后分别保存为 `PSD/ORA`。  
2. 关闭并重开，确认图层内容、透明度、偏移无异常。  
3. 导入 `ABR/PAT`，使用纹理笔刷绘制后再次保存并重开。  
4. 观察是否出现空白层、错位、纹理失效。

## 5. 判定规则

1. 自动化全绿 + 手测无 blocker，判定“通过”。  
2. 若仅出现兼容回退（V2 失败但旧接口成功），判定“可接受但需记录风险”。  
3. 若出现图层丢失、错位、无法打开文件，判定“失败”。
