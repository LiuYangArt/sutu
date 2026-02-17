# Krita 轨迹平滑对齐计划（独立文档，非当前 issue）

**日期**：2026-02-17  
**状态**：挂起（deferred）  
**原因**：当前分支优先解决压感尖尾一致性，轨迹平滑不再混入同一 issue 执行。

关联主计划：`docs/plans/2026-02-17-krita-pressure-tail-parity-plan.md`

---

## 1. 范围

本计划只处理“轨迹几何平滑”：

1. Krita Tool Options 中的 `Brush Smoothing` 模式语义。  
2. `NONE/BASIC/WEIGHTED/STABILIZER/PIXEL` 模式行为对齐。  
3. 轨迹层参数（例如 tail aggressiveness / smooth pressure / delay distance）对齐。  

不处理：

1. 压感映射曲线对齐。  
2. 采样器 distance/timing 触发语义。  
3. 收笔末样本丢失问题。

---

## 2. Krita 实操锚点（后续执行时必看）

### 2.1 UI 与配置入口

1. smoothing 枚举定义：  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_smoothing_options.h:20`
2. Tool Options 下拉创建：  
   - `F:\CodeProjects\krita\plugins\tools\basictools\kis_tool_brush.cc:413`  
   - `F:\CodeProjects\krita\plugins\tools\basictools\kis_tool_brush.cc:415`  
   - `F:\CodeProjects\krita\plugins\tools\basictools\kis_tool_brush.cc:421`
3. 参数读写配置：  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_smoothing_options.cpp:16`  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_smoothing_options.cpp:182`
4. 默认配置值：  
   - `F:\CodeProjects\krita\libs\ui\kis_config.cc:2156`  
   - `F:\CodeProjects\krita\libs\ui\kis_config.cc:2196`  
   - `F:\CodeProjects\krita\libs\ui\kis_config.cc:2246`

### 2.2 运行时分支

1. Basic/Weighted 分支：  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_tool_freehand_helper.cpp:592`
2. Weighted 里的 tail aggressiveness 和 smooth pressure：  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_tool_freehand_helper.cpp:545`  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_tool_freehand_helper.cpp:568`
3. None 分支：  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_tool_freehand_helper.cpp:623`
4. Stabilizer 分支与收束：  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_tool_freehand_helper.cpp:665`  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_tool_freehand_helper.cpp:892`  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_stabilized_events_sampler.cpp:56`

---

## 3. Sutu 现状（记录）

1. 轨迹平滑器实现：`src/utils/freehand/kritaLikeFreehandSmoother.ts`。  
2. 当前分支已在主链路默认关闭轨迹平滑，仅保留隔离代码：  
   - `src/utils/strokeBuffer.ts:1342`  
   - `src/utils/strokeBuffer.ts:1377`  
   - `src/components/Canvas/useBrushRenderer.ts:810`  
   - `src/components/Canvas/useBrushRenderer.ts:856`

---

## 4. 后续执行入口（恢复时再用）

恢复执行本计划前，必须先满足：

1. 压感尖尾主计划全部达到 P0 验收。  
2. 轨迹平滑对齐目标单独建 gate（几何对比，不混用压感指标）。  
3. UI/预设变更评审独立进行，避免牵连当前 issue 回归。
