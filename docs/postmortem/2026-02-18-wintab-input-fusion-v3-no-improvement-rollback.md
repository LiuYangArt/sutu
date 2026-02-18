# 2026-02-18 WinTab Input Fusion V3 无改善复盘（回滚）

## 结论

2026-02-18 本轮 WinTab 输入重构在自动化与局部指标上通过，但真实手感没有改善，仍出现：

1. 起笔大头。
2. 偶发丢笔/缺段。
3. 与 PointerEvent 明显体感差异持续存在。

按用户决定，本轮代码改动全部回滚，仅保留本复盘文档。

---

## 背景与目标

目标是通过 `Pointer 几何 + Native 传感器 + 时间对齐融合（Input Fusion V3）` 修复 WinTab 体验，使其接近 PointerEvent。

预期：

1. 消除起笔大头。
2. 消除丢笔。
3. WinTab 与 PointerEvent 手感收敛。

实际：未达成。

---

## 关键观测（用户实测）

用户提供的典型日志：

```json
{
  "reason": "ended",
  "strokeId": 10,
  "pointerId": 1,
  "sampleCount": 23,
  "sensorResolvedCount": 22,
  "sensorResolvedRate": 0.9565,
  "sensorMatchedCount": 22,
  "sensorFallbackCount": 0,
  "pointerOnlyCount": 1,
  "downWithoutSensorMatch": true,
  "maxSensorSkewUs": 7545,
  "hasAnomaly": false
}
```

关键矛盾：

1. `sensorResolvedRate` 很高，但仍出现明显大头和丢笔。
2. `pointerOnlyCount=1` 且 `downWithoutSensorMatch=true` 持续出现，说明每笔首点仍会落到 pointer-only 路径。
3. 指标 `hasAnomaly=false` 与主观失败并不一致，说明观测口径不足以代表真实绘制质量。

---

## 本轮尝试过的修复（按顺序）

1. source 别名归一化（`win_tab/mac_native` -> `wintab/macnative`）。
2. raw 输入非绘制阶段不推进 native cursor，避免提前消费。
3. stroke summary 口径重构（区分 pointerOnly 与 sensorResolved）。
4. 起笔去伪：首点 `down+pointerevent` 且后续有 native 时丢首点。
5. temporal join 改为相位兼容匹配：`down` 不再匹配 `move`。
6. starting 阶段近同坐标点折叠，降低起笔团块风险。
7. pen pointerId 变号容错，避免中途 move 被忽略。

自动化结果：

1. 相关单测通过。
2. `pnpm check:all` 通过（仓库既有 warning 仍在）。

但实机体感仍失败。

---

## 第一性原理复盘

### 1) 问题不在“有没有匹配”，而在“首点质量”

当前融合在统计上能匹配大部分点，但首点一旦失真（延迟、压力不对、几何不稳），用户感知会被极大放大，表现为大头。

### 2) 现有指标偏“计数正确”，不等于“手感正确”

`sensorResolvedRate/sensorMatchedCount` 只能说明多数点有配对，不能证明：

1. 首点压力是否可信。
2. 首 2~3 点是否按正确相位与时序进入渲染。
3. 压力与几何是否同一因果窗口内对齐。

### 3) WinTab 语义对前端融合仍不够稳定

即便有 down/up phase 与时间戳，首点附近仍可能存在：

1. 事件到达顺序抖动。
2. 压力建立延迟。
3. 浏览器 pointer 与 native 包在首帧窗口内跨线程错位。

这导致“看起来只有 1 个 pointerOnly 点”，但该点正是最致命的视觉点。

---

## 为什么本轮失败

1. 我们修的是“融合正确性”，但用户失败点是“首点主观质量”。
2. 复现链路依赖真实硬件/驱动时序，单测和离线回放无法覆盖该时序抖动。
3. 指标设计对首点权重不足，导致误判“已收敛”。

---

## 经验沉淀（必须遵守）

1. 以后 WinTab 相关方案，禁止仅用平均指标判定通过，必须引入首点专用门禁。
2. `downWithoutSensorMatch` 即使只出现 1 次，也必须按高优先级处理，不可被总量指标稀释。
3. 对“手感问题”，自动化通过不构成验收，必须实机 A/B 结论优先。
4. 复盘口径要明确区分：
   - 数据面通过（统计）
   - 体验面通过（主观手感）

---

## 若未来重启该课题（建议前置条件）

1. 先建立首点质量指标：
   - first_dab_pressure_error
   - first_3_points_phase_consistency
   - start_blob_area_ratio
2. 先做硬件级 trace（Rust packet -> 事件发射 -> 前端消费）统一时间线，再决定是否继续融合路线。
3. 若首点时序问题无法稳定收敛，优先评估更激进路线（例如在 Windows 平台统一输入源策略），避免继续在融合层做局部补丁。

---

## 最终处理

根据用户决策：

1. 停止本轮修复。
2. 回滚本轮全部代码改动。
3. 保留本 postmortem 作为失败经验归档。
