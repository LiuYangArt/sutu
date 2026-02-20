# 纹理笔刷 Cursor 生成优化实施计划（Scribbles 2，LOD 版）

## 1. 结论与方向

本轮优化主线改为：

1. **优先优化生成算法**，降低 cursor 数据量与复杂度。
2. 通过 **多级 LOD** 让复杂 tip 尽量继续走 hardware cursor。
3. DOM cursor 保留为高精度保底，不作为主优化目标。

关于你提到的 DOM 1-2 帧延时：  
这个问题通常很难“彻底抹平”。DOM cursor 即使做得再轻，交互手感上仍常弱于 hardware cursor。  
所以最有效路径是：**让更多场景回到 hardware，并确保 hardware 用的是受控复杂度的 LOD。**

## 2. 目标约束

1. 不牺牲明显的 cursor 视觉识别能力（尤其大笔刷/复杂 tip 的形态特征）。
2. 小笔刷优先低延时手感，允许使用更简化外轮廓。
3. 每个 LOD 都必须有明确复杂度上限，避免再出现超大 path。
4. 方案先聚焦生成与选择策略，不引入 Worker 主链路改造。

## 3. LOD 设计（按你的要求落地）

### 3.1 LOD 分层定义

1. `LOD2_FULL`（最高精度）
   - 用途：DOM cursor（高精度显示）。
   - 特点：保留多轮廓与细节。

2. `LOD1_BALANCED`（中精度）
   - 用途：hardware cursor 的主力层（中小笔刷）。
   - 特点：保留主体结构，显著减点减段。

3. `LOD0_OUTER`（最简层）
   - 用途：hardware cursor 小笔刷优先层。
   - 特点：仅保留外轮廓/主包络，强调低延时与稳定。

### 3.2 运行时映射策略

1. DOM cursor：默认 `LOD2_FULL`。
2. hardware cursor：
   - 小笔刷（建议 `screenBrushSize <= 24`）：强制 `LOD0_OUTER`。
   - 其余 hardware 区间（`24 < size <= 96`）：优先 `LOD1_BALANCED`，失败回退 `LOD0_OUTER`。

### 3.3 复杂度预算（首版建议值，可调）

1. `LOD0_OUTER`
   - `pathLen <= 8,000`
   - `segmentCount <= 256`
   - `contourCount = 1`（只保留主外轮廓）

2. `LOD1_BALANCED`
   - `pathLen <= 60,000`
   - `segmentCount <= 2,000`
   - `contourCount <= 8`
   - 必须低于 hardware 路径阈值（现为 120,000），留足安全余量

3. `LOD2_FULL`
   - 软预算：尽量下降（目标相对当前降 20%~40%）
   - 视觉优先，允许高于 LOD1，但需受“质量门槛”约束

## 4. 生成算法优化方案（核心）

### 4.1 基础流程

1. 原始轮廓提取（保留现有 Marching Squares 主体）。
2. 小孤岛过滤（按面积阈值移除噪点）。
3. 针对不同 LOD 走不同简化强度：
   - `LOD2`: 轻简化 + 轻平滑
   - `LOD1`: 中简化 + 平滑后再简化
   - `LOD0`: 只取主外轮廓并强简化

### 4.2 预算驱动简化（关键）

对每个 LOD 采用“迭代加压简化”直到满足预算：

1. 先按初始 `epsilon` 生成 path。
2. 若超预算，逐步增大 `epsilon` 并重算。
3. 达到预算即停止；若达到上限仍超预算，走最后兜底（进一步降 contour/外轮廓化）。

这样可保证：**生成结果一定不会超过该 LOD 的复杂度上限**。

### 4.3 质量门槛（防止“简化过头”）

对 `LOD1/LOD2` 增加自动质量检查（离线导入阶段即可）：

1. 轮廓面积偏差在阈值内（建议 < 8%）。
2. 外接框中心漂移在阈值内（建议 < 1 px，归一化后换算）。
3. 关键方向形态（长宽比、主轴角）不出现突变。

若不达标，回退到更高精度参数。

## 5. 数据模型与兼容策略

### 5.1 数据结构扩展

在 BrushPreset 层新增（命名可在实现时确定）：

1. `cursorPathLod0`
2. `cursorPathLod1`
3. `cursorPathLod2`（可沿用现有 `cursorPath` 语义）
4. 对应的 `cursorComplexity` 元数据（len/segments/contours）

### 5.2 兼容

1. 老数据仅有单 `cursorPath` 时：
   - 导入后首次访问可后台补齐 LOD（或在下次重保存时补齐）。
2. 运行时选择 LOD 失败时：
   - `LOD2 -> LOD1 -> LOD0 -> ellipse` 逐级回退。

## 6. 分阶段实施

### 6.1 Phase A：观测与基线（1 天）

1. 固化基线样本（`scribbles 2` + 对照 tip）。
2. 记录当前指标：
   - `cursorPathLen / segmentCount`
   - hardware 命中率
   - WinTab `emit->frontend.recv` P95/P99

### 6.2 Phase B：生成算法 + LOD 产物（2-4 天）

1. 落地 LOD 生成流程与预算驱动简化。
2. 落地质量门槛和自动回退。
3. 产出三层 LOD 与复杂度元数据。

### 6.3 Phase C：运行时 LOD 选择（1-2 天）

1. 接入 size 驱动策略（小笔刷强制 LOD0）。
2. hardware 路径优先 LOD1/LOD0。
3. DOM 路径默认 LOD2。

### 6.4 Phase D：调参与回归（1-2 天）

1. 调整预算阈值与 size 分段阈值。
2. 对典型复杂笔刷做视觉与手感回归。
3. 输出最终阈值建议与灰度开关配置。

## 7. 验收标准

1. `scribbles 2` 在小笔刷场景可稳定使用 hardware cursor（由 LOD0/LOD1 命中）。
2. 小笔刷手感改善（主观延时下降），不再强依赖 DOM cursor。
3. `LOD1` 复杂度始终低于硬阈值安全区（建议 <= 60,000）。
4. 大笔刷 DOM 下保持高精度形态，不出现明显“失真”。
5. WinTab 关键高尾指标（`emit->frontend.recv` P95/P99）相对当前基线有实质改善。

## 8. 风险与回滚

1. 风险：LOD0 过简导致识别度下降。
   - 对策：仅在小笔刷强制，且阈值可调。

2. 风险：LOD1 为满足预算损失细节。
   - 对策：质量门槛 + 超限回退策略。

3. 风险：多 LOD 增加存储体积。
   - 对策：仅存 path，不存多份位图；必要时只对高复杂 tip 生成完整三层。

回滚顺序：

1. 关闭 LOD 选择策略，回退单路径逻辑。
2. 保留仅生成端减重（若稳定）。
3. 全量回退到当前稳定版本。

## 9. Task List

1. 定义三层 LOD 的预算与质量门槛（含默认阈值）。
2. 实现导入期 LOD 生成与预算驱动简化。
3. 扩展 BrushPreset 存储与兼容读取逻辑。
4. 接入运行时 LOD 选择（DOM=LOD2，hardware=LOD1/LOD0）。
5. 针对 `scribbles 2` 做阈值调参并完成 WinTab/PointerEvent 对照验证。
6. 产出最终灰度方案与回滚开关说明。
