# Krita 压感尖尾一致性执行计划（当前 issue 范围）

**日期**：2026-02-17  
**当前分支**：`perf/146-krita-photoshop`  
**目标**：只解决压感尖尾一致性，不在本 issue 内推进轨迹平滑功能。

## 0. 范围定义（防止跑偏）

### 0.1 In Scope（本 issue 要做）

1. 压感映射链路对齐（输入压感到 dab 压感）。  
2. 采样触发语义对齐（distance/timing 触发与 carry 行为）。  
3. 收笔末样本完整消费（避免快抬笔丢最后低压段）。  
4. 自动化链路对比（替代高频手工回归）。

### 0.2 Out of Scope（本 issue 不做）

1. 轨迹平滑模式对齐（`NONE/BASIC/WEIGHTED/STABILIZER/PIXEL`）。  
2. Brush Smoothing UI 与参数策略调优。  

独立文档：`docs/plans/2026-02-17-krita-trajectory-smoothing-plan.md`

---

## 1. Krita 侧必须对照的源码锚点（按执行顺序）

### 1.1 输入压感与速度

1. Tablet 压感曲线配置读写：  
   - `F:\CodeProjects\krita\libs\ui\kis_config.cc:1584`  
   - `F:\CodeProjects\krita\libs\ui\kis_config.cc:1601`
2. Preferences 页面对应项（压感曲线 + brush speed smoothing）：  
   - `F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1645`  
   - `F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1677`  
   - `F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1692`  
   - `F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1701`
3. 构建 `KisPaintInformation` 时应用压感曲线：  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:46`  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:179`
4. 速度平滑读取与估计：  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_speed_smoother.cpp:103`  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_speed_smoother.cpp:149`  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_speed_smoother.cpp:157`

### 1.2 采样触发（核心）

1. `paintLine()` 循环触发 `getNextPointPosition()` 并做 `mix(t, ...)`：  
   - `F:\CodeProjects\krita\libs\image\brushengine\kis_paintop_utils.h:67`  
   - `F:\CodeProjects\krita\libs\image\brushengine\kis_paintop_utils.h:68`
2. `getNextPointPosition()` 取 `distanceFactor/timeFactor` 最小值：  
   - `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:405`  
   - `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:424`  
   - `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:431`
3. 未命中与命中时的时间累积与重置：  
   - `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:436`  
   - `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:443`
4. distance 触发插值：  
   - `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:460`  
   - `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:482`

### 1.3 动态传感器（尾端参数变化来源）

1. 传感器曲线映射入口：  
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensor.cpp:35`  
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensor.cpp:42`
2. Fade 归一：  
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensorFade.cpp:21`  
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensorFade.cpp:27`
3. Distance 归一：  
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensorDistance.cpp:21`  
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensorDistance.cpp:27`
4. Speed 传感器：  
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensors.h:19`

---

## 2. Sutu 当前差异（仅保留本 issue 相关）

### 2.1 压感与采样启发式

1. EMA 压感平滑：`src/utils/strokeBuffer.ts:1432`、`src/utils/strokeBuffer.ts:1445`。  
2. 压感插值是 smoothstep，不是线性：`src/utils/strokeBuffer.ts:1558`、`src/utils/strokeBuffer.ts:1562`。  
3. 压力变化触发 spacing 减半：`src/utils/strokeBuffer.ts:1694`、`src/utils/strokeBuffer.ts:1697`。  
4. 低压 density boost：`src/utils/strokeBuffer.ts:1699`、`src/utils/strokeBuffer.ts:1705`。  
5. 采样器当前是 distance/time 并集去重：`src/utils/freehand/segmentSampler.ts:54`、`src/utils/freehand/segmentSampler.ts:64`、`src/utils/freehand/segmentSampler.ts:81`。

### 2.2 收笔末样本风险

1. `finalizeStroke()` 起始就清 point buffer：`src/components/Canvas/useStrokeProcessor.ts:515`、`src/components/Canvas/useStrokeProcessor.ts:517`。  
2. `pointerup` 直接 `finishCurrentStroke()`，未补拉 native 末样本：`src/components/Canvas/usePointerHandlers.ts:430`、`src/components/Canvas/usePointerHandlers.ts:480`。

### 2.3 轨迹平滑状态（仅记录，不执行）

1. 本分支已将轨迹平滑从主链路隔离并默认关闭：  
   - `src/utils/strokeBuffer.ts:1342`  
   - `src/utils/strokeBuffer.ts:1377`  
   - `src/components/Canvas/useBrushRenderer.ts:810`  
   - `src/components/Canvas/useBrushRenderer.ts:856`
2. 轨迹平滑后续工作移至独立文档，不在本计划内推进。

---

## 3. 实施阶段（本 issue）

### Phase 0（P0）：链路对比基建

目标：同输入下自动导出并对比 `input_raw / pressure_mapped / sampler_t / dab_emit`。

任务：

1. Sutu 导出 `trace.sutu.json`。  
2. Krita 本地 harness 导出 `trace.krita.json`。  
3. 对比脚本输出 `report.json + stage_diff.csv + tail_chart.png`。  
4. 新增本地 gate 命令。

### Phase 1（P0）：压感链路去启发式

目标：先去掉会把尖尾压钝的本地补偿。

任务：

1. 段内 pressure 改线性插值。  
2. EMA / pressure-change-spacing / low-pressure-density 改可配置。  
3. 新增 `kritaParityProfile`，默认关闭这三项启发式。  
4. 用 trace 比较尾段压力曲线和 dab 密度。

### Phase 2（P0）：收笔末样本完整消费

目标：快抬笔不丢尾端低压段。

任务：

1. 调整顺序：先消费末段输入，再清 buffer。  
2. pointerup 时补读一次 native buffer。  
3. 无 native 点时使用 pointerup 事件兜底。  
4. 增加快抬笔/慢抬笔/停笔抬起自动测试。

### Phase 3（P0）：采样器语义对齐 Krita

目标：把 `sampler_t` 分布收敛到 Krita 基线。

任务：

1. 改为按“最早触发者”推进，不再并集合并后排序。  
2. timed sampling 改成显式配置控制。  
3. carry/reset 语义按 Krita 对齐。  
4. finalize 路径复用同一采样推进器。

---

## 4. 验收标准（本 issue）

### 4.1 自动化（必须全过）

1. `pressure_mapped` 尾段误差低于阈值。  
2. `sampler_t` 分布误差低于阈值。  
3. `dab_emit` 尾段 dab 数量、间距、pressure slope 通过阈值。  
4. 快抬笔 case 不丢终样本。

### 4.2 手动（仅里程碑）

1. 场景：慢抬、快甩、急停、低压慢移。  
2. 仅在 gate 失败或阶段合并前做抽检。

---

## 5. 当前执行顺序

1. 先做 Phase 0（把比对系统搭起来）。  
2. 再做 Phase 1 + 2（先修压感钝化与末样本丢失）。  
3. 最后做 Phase 3（采样器语义）。  
4. 轨迹平滑工作严格按独立文档执行，不混入本 issue。
