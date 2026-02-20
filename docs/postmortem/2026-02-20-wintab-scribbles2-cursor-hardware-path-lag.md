# 2026-02-20 WinTab + scribbles 2 卡顿复盘：硬件光标路径复杂度触发主线程排队

## 结论

本次 `scribbles 2` 在 WinTab 下“卡顿/断续/偶发切回后无法画”的核心诱因，不是 WinTab 采样本身损坏，也不是 dab 算法单点错误，而是 **复杂 brush cursor 的 hardware cursor 生成与主线程调度竞争**：

1. `scribbles 2` 的 `cursorPath` 复杂度明显高于常规 tip。
2. 小笔刷默认走 hardware cursor，频繁生成/应用 cursor URL（SVG + `btoa`）会占用主线程。
3. WinTab 事件到前端回调本身依赖主线程调度；主线程忙时表现为 `emit->frontend.recv` 高尾上升、`native_empty` 连续增长。
4. PointerEvent 路径在该场景体感更稳，主要因为输入事件时序和调度特征不同，未触发同级别拥塞。

---

## 现象

1. 同一画笔库中，`scribbles 2` 可稳定复现 WinTab 卡顿；多数其他笔刷正常。
2. PointerEvent 下同笔刷基本正常。
3. 改成默认鼠标/crosshair 后卡顿显著缓解。
4. `scribbles 2` 换任意其他 brush tip 后，问题明显减轻。
5. 小笔刷（hardware cursor）更容易卡，大笔刷（DOM cursor）反而更顺。

---

## 关键证据链

来自 trace + pipeline-lag 分析：

1. `host->emit` 低毫秒稳定，说明 WinTab 采样与后端 emit 正常。
2. `emit->frontend.recv` 高尾显著抬升（可到百毫秒），说明主要延迟在前端调度/分发阶段。
3. 同期出现大量 `frontend.pointermove.native_empty` 与 `frontend.anomaly.native_missing_with_pointer`，对应“笔接触存在但短时间读不到 native 点”。
4. 关闭复杂 cursor 显示后，体感和 trace 指标同步改善，证明 cursor 子路径是主要放大器。

---

## 根因（第一性原理）

输入链路可拆为：

1. WinTab 采样（Rust）
2. 后端 emit
3. 前端事件回调执行
4. 点消费与 dab 渲染

本问题主要卡在第 3 步：**前端主线程可用性不足**。  
复杂硬件光标路径在小笔刷场景下频繁参与主线程工作，导致 WinTab 事件回调晚执行，进而在消费端表现为缺样、批量补样和断续感。

---

## 已落地修复

文件：

1. `src/components/Canvas/useCursor.ts`
2. `src/components/Canvas/index.tsx`
3. `src/components/Canvas/__tests__/useCursor.test.ts`
4. `src/stores/settings.ts`
5. `src/components/SettingsPanel/index.tsx`

改动：

1. 增加 hardware cursor 复杂度门控：`cursorPath.length > 120000` 时禁用 hardware，强制走 DOM cursor。
2. 增加 hardware cursor URL 缓存（容量 64，近似 LRU），减少重复 SVG 拼装与 `btoa`。
3. 稳定 `brushTexture` 引用，避免每次 render 触发无意义重算。
4. 新增 debug 开关：`forceDomCursorDebug`（默认关闭），用于一键强制所有笔刷走 DOM cursor 做对照测试。

---

## 验证

自动化：

1. `pnpm -s typecheck`
2. `pnpm -s test src/components/Canvas/__tests__/useCursor.test.ts`
3. `pnpm -s test src/stores/__tests__/settings.test.ts`

手工验证（用户）：

1. WinTab + `scribbles 2` 卡顿问题已显著改善，复现失败。
2. debug 开关可稳定切换“全部 DOM cursor”用于后续对照采集。

---

## 经验沉淀

1. “只有某个笔刷 + 某个 backend 异常”不一定是输入 backend 本身问题，可能是前端主线程负载差异放大。
2. `emit->frontend.recv` 是排查 WinTab 体感卡顿的关键指标，不能只看 `recv.native_v3` 数量。
3. cursor 子系统必须有复杂度预算与降级策略，不能默认假设 tip 轮廓简单。
4. 为输入问题提供可切换的 debug 旁路（如强制 DOM cursor）能显著降低定位成本。

---

## 后续项

1. 按中期计划推进 cursor worker/off-main-thread 预处理与导入期多级缓存。
2. trace 增加 `cursor_mode` / `cursor_cache_hit` / `cursor_build_ms` 字段，建立“输入延迟 vs cursor 开销”直接关联。
